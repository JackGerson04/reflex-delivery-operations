import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, confirmationsTable, deliveryEventsTable, deliveriesTable, ridersTable } from "@workspace/db";
import {
  AssignDeliveryBody,
  AssignDeliveryParams,
  AssignDeliveryResponse,
  ConfirmDeliveryBody,
  ConfirmDeliveryParams,
  ConfirmDeliveryResponse,
  CreateDeliveryBody,
  CreateDeliveryResponse,
  GetDashboardResponse,
  GetDeliveryParams,
  GetDeliveryResponse,
  ListActivityQueryParams,
  ListActivityResponse,
  ListDeliveriesQueryParams,
  ListDeliveriesResponse,
  ListRidersResponse,
  UpdateDeliveryBody,
  UpdateDeliveryParams,
  UpdateDeliveryResponse,
  UpdateDeliveryStatusBody,
  UpdateDeliveryStatusParams,
  UpdateDeliveryStatusResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const statusLabels: Record<string, string> = {
  requested: "Requested",
  assigned: "Assigned",
  picked_up: "Picked up",
  in_transit: "In transit",
  delivered: "Delivered",
  exception: "Needs attention",
};

let seedPromise: Promise<void> | null = null;

async function ensureSeedData(): Promise<void> {
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
    const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(ridersTable);
    if (Number(count) > 0) return;

    const riders = await db
      .insert(ridersTable)
      .values([
        { name: "Amina Wanjiku", phone: "+254 712 483 920", vehicle: "Motorbike · KDA 318Q", availability: "available" },
        { name: "Brian Otieno", phone: "+254 726 104 615", vehicle: "Motorbike · KDG 704M", availability: "on route" },
        { name: "Faith Njeri", phone: "+254 701 833 204", vehicle: "Motorbike · KCU 941P", availability: "available" },
      ])
      .returning();

    const deliveries = await db
      .insert(deliveriesTable)
      .values([
        {
          reference: "RX-1048",
          customerName: "Mercy Kamau",
          customerPhone: "+254 722 908 115",
          address: "Kilimani, Prestige Plaza, shop 14",
          area: "Kilimani",
          itemDescription: "Samsung A15 128GB · black",
          notes: "Call on arrival. Customer will meet at the gate.",
          status: "in_transit",
          eta: "12:40 PM",
          riderId: riders[1].id,
        },
        {
          reference: "RX-1047",
          customerName: "David Mwangi",
          customerPhone: "+254 733 140 882",
          address: "Westlands, Mpaka Road, apartment 6B",
          area: "Westlands",
          itemDescription: "Amoxicillin 500mg · 2 packs",
          status: "assigned",
          eta: "1:15 PM",
          riderId: riders[0].id,
        },
        {
          reference: "RX-1046",
          customerName: "Jane Wambui",
          customerPhone: "+254 719 556 430",
          address: "South B, Hazina Estate, house 22",
          area: "South B",
          itemDescription: "Drill bits set · 24 piece",
          status: "requested",
          eta: "2:00 PM",
        },
        {
          reference: "RX-1045",
          customerName: "Peter Ochieng",
          customerPhone: "+254 710 478 219",
          address: "Lavington, Muthangari Drive",
          area: "Lavington",
          itemDescription: "JBL Tune 760NC headphones",
          status: "delivered",
          eta: "11:25 AM",
          riderId: riders[2].id,
        },
      ])
      .returning();

    const events = deliveries.flatMap((delivery) => {
      const statuses = delivery.status === "delivered"
        ? ["requested", "assigned", "picked_up", "in_transit", "delivered"]
        : delivery.status === "in_transit"
          ? ["requested", "assigned", "picked_up", "in_transit"]
          : delivery.status === "assigned"
            ? ["requested", "assigned"]
            : ["requested"];
      return statuses.map((status, index) => ({
        deliveryId: delivery.id,
        status,
        actor: status === "requested" ? "Retailer staff" : status === "assigned" ? "Dispatch desk" : "Brian Otieno",
        note: index === statuses.length - 1 ? `${statusLabels[status]} update recorded` : null,
        createdAt: new Date(Date.now() - (statuses.length - index) * 22 * 60 * 1000),
      }));
    });
    await db.insert(deliveryEventsTable).values(events);
    await db.insert(confirmationsTable).values({
      deliveryId: deliveries[3].id,
      method: "code",
      value: "4821",
      recipientName: "Peter Ochieng",
    });
  })();
  return seedPromise;
}

function parseId(raw: string | string[]): number {
  return Number(Array.isArray(raw) ? raw[0] : raw);
}

async function deliveryView(id: number) {
  const [row] = await db
    .select({ delivery: deliveriesTable, rider: ridersTable })
    .from(deliveriesTable)
    .leftJoin(ridersTable, eq(deliveriesTable.riderId, ridersTable.id))
    .where(eq(deliveriesTable.id, id));
  if (!row) return null;

  const events = await db
    .select()
    .from(deliveryEventsTable)
    .where(eq(deliveryEventsTable.deliveryId, id))
    .orderBy(deliveryEventsTable.createdAt);
  const [confirmation] = await db
    .select()
    .from(confirmationsTable)
    .where(eq(confirmationsTable.deliveryId, id));
  return {
    id: row.delivery.id,
    reference: row.delivery.reference,
    customerName: row.delivery.customerName,
    customerPhone: row.delivery.customerPhone,
    address: row.delivery.address,
    area: row.delivery.area,
    itemDescription: row.delivery.itemDescription,
    notes: row.delivery.notes,
    status: row.delivery.status,
    statusLabel: statusLabels[row.delivery.status] ?? row.delivery.status,
    createdAt: row.delivery.createdAt.toISOString(),
    updatedAt: row.delivery.updatedAt.toISOString(),
    eta: row.delivery.eta,
    rider: row.rider
      ? {
          id: row.rider.id,
          name: row.rider.name,
          phone: row.rider.phone,
          vehicle: row.rider.vehicle,
          active: row.rider.active,
          currentLoad: 0,
          availability: row.rider.availability,
        }
      : null,
    confirmation: confirmation
      ? {
          method: confirmation.method,
          value: confirmation.value,
          recipientName: confirmation.recipientName,
          confirmedAt: confirmation.confirmedAt.toISOString(),
        }
      : null,
    timeline: events.map((event) => ({
      status: event.status,
      label: statusLabels[event.status] ?? event.status,
      timestamp: event.createdAt.toISOString(),
      note: event.note,
      actor: event.actor,
    })),
  };
}

async function allDeliveryViews(status?: string) {
  const rows = await db
    .select({ id: deliveriesTable.id })
    .from(deliveriesTable)
    .where(status ? eq(deliveriesTable.status, status) : undefined)
    .orderBy(desc(deliveriesTable.createdAt));
  const views = await Promise.all(rows.map((row) => deliveryView(row.id)));
  return views.filter((view): view is NonNullable<typeof view> => Boolean(view));
}

router.get("/deliveries", async (req, res): Promise<void> => {
  await ensureSeedData();
  const parsed = ListDeliveriesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  res.json(ListDeliveriesResponse.parse(await allDeliveryViews(parsed.data.status)));
});

router.post("/deliveries", async (req, res): Promise<void> => {
  await ensureSeedData();
  const parsed = CreateDeliveryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const reference = `RX-${1000 + Math.floor(Math.random() * 8999)}`;
  const [delivery] = await db.insert(deliveriesTable).values({ ...parsed.data, reference }).returning();
  await db.insert(deliveryEventsTable).values({
    deliveryId: delivery.id,
    status: "requested",
    actor: "Retailer staff",
    note: "Request logged",
  });
  res.status(201).json(CreateDeliveryResponse.parse(await deliveryView(delivery.id)));
});

router.get("/deliveries/:id", async (req, res): Promise<void> => {
  await ensureSeedData();
  const params = GetDeliveryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const view = await deliveryView(params.data.id);
  if (!view) {
    res.status(404).json({ error: "Delivery not found" });
    return;
  }
  res.json(GetDeliveryResponse.parse(view));
});

router.patch("/deliveries/:id", async (req, res): Promise<void> => {
  await ensureSeedData();
  const params = UpdateDeliveryParams.safeParse(req.params);
  const parsed = UpdateDeliveryBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [delivery] = await db
    .update(deliveriesTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(deliveriesTable.id, params.data.id))
    .returning();
  if (!delivery) {
    res.status(404).json({ error: "Delivery not found" });
    return;
  }
  res.json(UpdateDeliveryResponse.parse(await deliveryView(delivery.id)));
});

router.post("/deliveries/:id/assign", async (req, res): Promise<void> => {
  await ensureSeedData();
  const params = AssignDeliveryParams.safeParse(req.params);
  const parsed = AssignDeliveryBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, parsed.data.riderId));
  if (!rider) {
    res.status(404).json({ error: "Rider not found" });
    return;
  }
  const [delivery] = await db
    .update(deliveriesTable)
    .set({ riderId: rider.id, status: "assigned", updatedAt: new Date() })
    .where(eq(deliveriesTable.id, params.data.id))
    .returning();
  if (!delivery) {
    res.status(404).json({ error: "Delivery not found" });
    return;
  }
  await db.insert(deliveryEventsTable).values({
    deliveryId: delivery.id,
    status: "assigned",
    actor: "Dispatch desk",
    note: `Assigned to ${rider.name}`,
  });
  res.json(AssignDeliveryResponse.parse(await deliveryView(delivery.id)));
});

router.post("/deliveries/:id/status", async (req, res): Promise<void> => {
  await ensureSeedData();
  const params = UpdateDeliveryStatusParams.safeParse(req.params);
  const parsed = UpdateDeliveryStatusBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [delivery] = await db
    .update(deliveriesTable)
    .set({ status: parsed.data.status, updatedAt: new Date() })
    .where(eq(deliveriesTable.id, params.data.id))
    .returning();
  if (!delivery) {
    res.status(404).json({ error: "Delivery not found" });
    return;
  }
  await db.insert(deliveryEventsTable).values({
    deliveryId: delivery.id,
    status: parsed.data.status,
    actor: "Rider",
    note: parsed.data.note ?? `${statusLabels[parsed.data.status]} update recorded`,
  });
  res.json(UpdateDeliveryStatusResponse.parse(await deliveryView(delivery.id)));
});

router.post("/deliveries/:id/confirmation", async (req, res): Promise<void> => {
  await ensureSeedData();
  const params = ConfirmDeliveryParams.safeParse(req.params);
  const parsed = ConfirmDeliveryBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [delivery] = await db
    .update(deliveriesTable)
    .set({ status: "delivered", updatedAt: new Date() })
    .where(eq(deliveriesTable.id, params.data.id))
    .returning();
  if (!delivery) {
    res.status(404).json({ error: "Delivery not found" });
    return;
  }
  await db
    .insert(confirmationsTable)
    .values({ deliveryId: delivery.id, ...parsed.data })
    .onConflictDoUpdate({
      target: confirmationsTable.deliveryId,
      set: { ...parsed.data, confirmedAt: new Date() },
    });
  await db.insert(deliveryEventsTable).values({
    deliveryId: delivery.id,
    status: "delivered",
    actor: "Rider",
    note: `Proof captured via ${parsed.data.method}`,
  });
  res.json(ConfirmDeliveryResponse.parse(await deliveryView(delivery.id)));
});

router.get("/dashboard", async (_req, res): Promise<void> => {
  await ensureSeedData();
  const rows = await db.select({ status: deliveriesTable.status }).from(deliveriesTable);
  const [{ activeRiders }] = await db.select({ activeRiders: sql<number>`count(*)` }).from(ridersTable).where(eq(ridersTable.active, true));
  const dashboard = {
    total: rows.length,
    requested: rows.filter((row) => row.status === "requested").length,
    assigned: rows.filter((row) => row.status === "assigned").length,
    inTransit: rows.filter((row) => ["picked_up", "in_transit"].includes(row.status)).length,
    delivered: rows.filter((row) => row.status === "delivered").length,
    exceptions: rows.filter((row) => row.status === "exception").length,
    activeRiders: Number(activeRiders),
    averageDeliveryMinutes: 38,
    onTimeRate: 0.92,
  };
  res.json(GetDashboardResponse.parse(dashboard));
});

router.get("/activity", async (req, res): Promise<void> => {
  await ensureSeedData();
  const parsed = ListActivityQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const limit = parsed.data.limit ?? 8;
  const events = await db
    .select({ event: deliveryEventsTable, delivery: deliveriesTable })
    .from(deliveryEventsTable)
    .innerJoin(deliveriesTable, eq(deliveryEventsTable.deliveryId, deliveriesTable.id))
    .orderBy(desc(deliveryEventsTable.createdAt))
    .limit(limit);
  res.json(ListActivityResponse.parse(events.map(({ event, delivery }) => ({
    id: event.id,
    reference: delivery.reference,
    label: event.note ?? `${statusLabels[event.status]} update`,
    status: event.status,
    timestamp: event.createdAt.toISOString(),
    actor: event.actor,
  }))));
});

router.get("/riders", async (_req, res): Promise<void> => {
  await ensureSeedData();
  const riders = await db.select().from(ridersTable).orderBy(ridersTable.name);
  const loads = await db
    .select({ riderId: deliveriesTable.riderId, count: sql<number>`count(*)` })
    .from(deliveriesTable)
    .where(and(sql`${deliveriesTable.riderId} is not null`, sql`${deliveriesTable.status} not in ('delivered', 'exception')`))
    .groupBy(deliveriesTable.riderId);
  const loadMap = new Map(loads.map((load) => [load.riderId, Number(load.count)]));
  res.json(ListRidersResponse.parse(riders.map((rider) => ({
    id: rider.id,
    name: rider.name,
    phone: rider.phone,
    vehicle: rider.vehicle,
    active: rider.active,
    currentLoad: loadMap.get(rider.id) ?? 0,
    availability: rider.availability,
  }))));
});

export default router;