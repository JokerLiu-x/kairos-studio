import { dirname } from "node:path";
import type { Request } from "express";
import { z } from "zod";
import { commerceEntryKinds, membershipRates, membershipSegments, openDatabase } from "@toonflow/multi-tenant-db";
import { assertAppRequest } from "@/utils/mcp/control";
import conf from "@/utils/conf";
import { authorize } from "./index";
import { requestIdentity } from "./runtime";
import { modelGateway } from "./gateway";
import { readUsageFilters, usagePageFields } from "./usageQuery";

const cents = z.number().int().min(1).max(10000000);
export const membershipFields = {
  id: z.uuid(), userId: z.uuid(), paymentRef: z.string().trim().regex(/^[A-Za-z0-9._-]{3,80}$/),
  rate: z.enum(membershipRates), segment: z.enum(membershipSegments), paidFen: cents,
  paidAt: z.number().int().positive().max(8640000000000000).optional(),
  imageRouteId: z.uuid().nullable(), videoRouteId: z.uuid().nullable(),
};
export const commerceAdjustmentFields = {
  id: z.uuid(), orderId: z.uuid(), kind: z.enum(commerceEntryKinds), value: cents,
  quantity: z.number().int().min(0).max(1000), note: z.string().trim().min(1).max(256),
};
export const commerceQueryFields = { ...usagePageFields, orderId: z.uuid().optional() };
const membershipSchema = z.object(membershipFields);
const adjustmentSchema = z.object(commerceAdjustmentFields);
const querySchema = z.object(commerceQueryFields);
let opening: ReturnType<typeof openDatabase> | undefined;
let initializing: Promise<void> | undefined;

function fail(message: string, status: number): never { throw Object.assign(new Error(message), { status }); }

async function access<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (cause) {
    if (cause instanceof z.ZodError || (cause as { status?: number })?.status) throw cause;
    fail("读取或保存经营数据失败，请检查数据库", 503);
  }
}

async function database(write = false) {
  const current = opening ??= openDatabase(dirname(conf.path));
  try {
    const db = await current;
    if (!db) {
      if (opening === current) opening = undefined;
      return write ? fail("请先初始化多租户数据库", 503) : undefined;
    }
    if (write) {
      const ready = initializing ??= db.initializeCommerce();
      try { await ready; }
      catch (cause) { if (initializing === ready) initializing = undefined; throw cause; }
    }
    return db;
  } catch (cause) { if (opening === current && !initializing) opening = undefined; throw cause; }
}

export async function readCommerce(req: Request) {
  await authorize(req);
  const { from, to, userId } = readUsageFilters(req.query);
  const { beforeAt, beforeId, limit = 20, orderId } = querySchema.parse(req.query);
  if ((beforeAt === undefined) !== (beforeId === undefined)) fail("请同时提供时间游标和订单 ID", 400);
  const period = { from, to, userId };
  return access(async () => {
    const db = await database();
    const [totals, rows, adjustments] = await Promise.all([
      db?.readCommerceTotals(period),
      db?.listMemberships({ ...period, limit,
        before: beforeAt !== undefined && beforeId ? { paidAt: beforeAt, id: beforeId } : undefined }),
      orderId ? db?.listCommerceEntries(orderId, 100) : undefined,
    ]);
    const sum = (kind: typeof commerceEntryKinds[number]) => totals?.entries.find(entry => entry.kind === kind)?.value ?? 0;
    const paidFen = totals?.paidFen ?? 0;
    const refundedFen = sum("refund");
    const modelFen = sum("model");
    const feeFen = sum("fee");
    const orders = (rows ?? []).slice(0, limit);
    const last = (rows?.length ?? 0) > limit ? orders.at(-1) : undefined;
    return {
      from, to, orders, adjustments: adjustments ?? [], nextCursor: last ? { paidAt: last.paidAt, id: last.id } : null,
      totals: { paidFen, refundedFen, modelFen, feeFen, contributionFen: paidFen - refundedFen - modelFen - feeFen,
        payers: totals?.payers ?? 0, introEligible: totals?.introEligible ?? 0, introRenewed: totals?.introRenewed ?? 0,
        supportMinutes: sum("support"), modelPacks: totals?.entries.find(entry => entry.kind === "model")?.quantity ?? 0 },
    };
  });
}

export async function saveMembership(req: Request) {
  await authorize(req);
  const input = membershipSchema.parse(req.body);
  if (!input.imageRouteId || !input.videoRouteId) fail("请选择月卡包含的图片和视频模型", 400);
  if (input.paidAt !== undefined && input.paidAt > Date.now()) fail("收款时间不能晚于当前时间", 400);
  if (input.rate === "intro" && input.paidFen !== 16900) fail("首月优惠的实收金额应为 169 元", 400);
  const db = await access(() => database(true));
  const routing = await modelGateway.read();
  for (const [type, id] of [["image", input.imageRouteId], ["video", input.videoRouteId]] as const) {
    if (!routing.routes.some(route => route.id === id && route.type === type && route.enabled)) fail("请选择已启用且类型匹配的模型路由", 400);
  }
  return access(() => db!.addMembership({ ...input, paymentRef: input.paymentRef.toUpperCase() }));
}

export async function saveCommerceAdjustment(req: Request) {
  await authorize(req);
  const input = adjustmentSchema.parse(req.body);
  if (input.kind === "model" ? input.quantity < 1 : input.quantity !== 0) fail("仅模型采购记录需要填写套餐份数", 400);
  if (input.kind === "support" && input.value > 10080) fail("单笔售后时间最多为 10080 分钟", 400);
  const db = await access(() => database(true));
  return access(() => db!.addCommerceEntry(input));
}

export async function ownMembership(req: Request) {
  assertAppRequest(req);
  const user = requestIdentity(req);
  if (user?.role !== "user") return null;
  return access(async () => {
    const db = await database();
    const active = await db?.activeMembership(user.id, undefined, Date.now());
    return active ? { endsAt: active.endsAt, imageRouteId: active.imageRouteId, videoRouteId: active.videoRouteId } : null;
  });
}
