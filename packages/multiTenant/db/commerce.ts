import { bigint, index as mysqlIndex, int, mysqlEnum, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { index as sqliteIndex, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { and, eq, gte, lt, lte, gt, or, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

export const membershipSegments = ["merchant", "creator", "unknown"] as const;
export const membershipRates = ["intro", "standard"] as const;
export const commerceEntryKinds = ["refund", "model", "fee", "support"] as const;
export const membershipDuration = 30 * 86400000;

export const sqliteMembershipOrder = sqliteTable("kairosMembershipOrder", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  paymentRef: text("paymentRef").notNull().unique(),
  rate: text("rate", { enum: membershipRates }).notNull(),
  segment: text("segment", { enum: membershipSegments }).notNull(),
  paidFen: integer("paidFen").notNull(),
  refundedFen: integer("refundedFen").notNull().default(0),
  imageRouteId: text("imageRouteId"),
  videoRouteId: text("videoRouteId"),
  paidAt: integer("paidAt").notNull(),
  startsAt: integer("startsAt").notNull(),
  endsAt: integer("endsAt").notNull(),
}, table => [sqliteIndex("kairosMembershipUserStarts").on(table.userId, table.startsAt), sqliteIndex("kairosMembershipPaidAt").on(table.paidAt)]);

export const mysqlMembershipOrder = mysqlTable("kairosMembershipOrder", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: varchar("userId", { length: 36 }).notNull(),
  paymentRef: varchar("paymentRef", { length: 80 }).notNull().unique(),
  rate: mysqlEnum("rate", membershipRates).notNull(),
  segment: mysqlEnum("segment", membershipSegments).notNull(),
  paidFen: int("paidFen").notNull(),
  refundedFen: int("refundedFen").notNull().default(0),
  imageRouteId: varchar("imageRouteId", { length: 36 }),
  videoRouteId: varchar("videoRouteId", { length: 36 }),
  paidAt: bigint("paidAt", { mode: "number" }).notNull(),
  startsAt: bigint("startsAt", { mode: "number" }).notNull(),
  endsAt: bigint("endsAt", { mode: "number" }).notNull(),
}, table => [mysqlIndex("kairosMembershipUserStarts").on(table.userId, table.startsAt), mysqlIndex("kairosMembershipPaidAt").on(table.paidAt)]);

export const sqliteCommerceEntry = sqliteTable("kairosCommerceEntry", {
  id: text("id").primaryKey(),
  orderId: text("orderId").notNull(),
  kind: text("kind", { enum: commerceEntryKinds }).notNull(),
  value: integer("value").notNull(),
  quantity: integer("quantity").notNull(),
  note: text("note").notNull(),
  createdAt: integer("createdAt").notNull(),
}, table => [sqliteIndex("kairosCommerceOrderTime").on(table.orderId, table.createdAt), sqliteIndex("kairosCommerceTime").on(table.createdAt)]);

export const mysqlCommerceEntry = mysqlTable("kairosCommerceEntry", {
  id: varchar("id", { length: 36 }).primaryKey(),
  orderId: varchar("orderId", { length: 36 }).notNull(),
  kind: mysqlEnum("kind", commerceEntryKinds).notNull(),
  value: int("value").notNull(),
  quantity: int("quantity").notNull(),
  note: varchar("note", { length: 256 }).notNull(),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
}, table => [mysqlIndex("kairosCommerceOrderTime").on(table.orderId, table.createdAt), mysqlIndex("kairosCommerceTime").on(table.createdAt)]);

export type MembershipOrder = typeof sqliteMembershipOrder.$inferSelect;
export type MembershipPurchase = Omit<MembershipOrder, "startsAt" | "endsAt" | "refundedFen" | "paidAt"> & { paidAt?: number };
export type MembershipHistory = MembershipOrder & { userName: string | null; firstImageAt: number | null; firstVideoAt: number | null; renewed: boolean; modelPacks: number };
export type CommerceEntry = typeof sqliteCommerceEntry.$inferSelect;
export type CommercePeriod = { from: number; to: number; userId?: string };
export type CommerceOrders = CommercePeriod & { limit: number; before?: { paidAt: number; id: string } };

export function commerceError(message: string, status = 409): never {
  throw Object.assign(new Error(message), { status });
}

export function confirmPurchase(input: MembershipPurchase, previous: MembershipOrder) {
  if (Object.entries(input).some(([key, value]) => value !== previous[key as keyof MembershipPurchase])) {
    commerceError("付款流水号或请求 ID 已用于其他订单");
  }
  return previous;
}

export function confirmEntry(input: Omit<CommerceEntry, "createdAt">, previous: CommerceEntry) {
  if (Object.entries(input).some(([key, value]) => value !== previous[key as keyof typeof input])) {
    commerceError("请求 ID 已用于其他经营记录");
  }
  return previous;
}

export function commerceQuery(order: typeof sqliteMembershipOrder | typeof mysqlMembershipOrder) {
  function period(time: SQLWrapper, value: CommercePeriod) {
    return and(gte(time, value.from), lt(time, value.to), value.userId ? eq(order.userId, value.userId) : undefined);
  }
  const renewed = sql<boolean>`exists (
    select 1 from kairosMembershipOrder as renewal
    where renewal.userId = ${order.userId} and renewal.startsAt >= ${order.endsAt}
      and renewal.rate = 'standard' and renewal.paidFen = 19900 and renewal.refundedFen = 0
  )`.mapWith(Boolean);
  return {
    period, renewed,
    active(userId: string, routeId: string | undefined, at: number) {
      return and(eq(order.userId, userId), lte(order.startsAt, at), gt(order.endsAt, at),
        sql`${order.refundedFen} < ${order.paidFen}`, routeId ? or(eq(order.imageRouteId, routeId), eq(order.videoRouteId, routeId)) : undefined);
    },
    list(filters: CommerceOrders) {
      const before = filters.before;
      return and(period(order.paidAt, filters), before
        ? or(lt(order.paidAt, before.paidAt), and(eq(order.paidAt, before.paidAt), lt(order.id, before.id)))
        : undefined);
    },
    receipt: {
      paidFen: sql<number>`coalesce(sum(${order.paidFen}), 0)`.mapWith(Number),
      payers: sql<number>`count(distinct ${order.userId})`.mapWith(Number),
    },
    introEligibility(value: CommercePeriod, now: number) {
      return and(period(order.endsAt, value), eq(order.rate, "intro"), lte(order.endsAt, now),
        sql`${order.refundedFen} < ${order.paidFen}`);
    },
    renewalCount: {
      introEligible: sql<number>`count(*)`.mapWith(Number),
      introRenewed: sql<number>`coalesce(sum(case when ${renewed} then 1 else 0 end), 0)`.mapWith(Number),
    },
  };
}
