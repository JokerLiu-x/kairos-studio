import { createHash } from "node:crypto";
import { z } from "zod";
import { openDatabase } from "@toonflow/multi-tenant-db";
import type { AdminDatabase, BillingRecord, ModelUsageFilters, ModelUsagePage, ModelUsageRecord, WalletRecord } from "@toonflow/multi-tenant-db";
import { calculateModelPrice } from "@toonflow/multi-tenant-models";
import { modelPriceSchema, modelRouteSchema } from "@toonflow/multi-tenant-models/config";
import type { ModelRoute } from "@toonflow/multi-tenant-models/config";
import { billingCreditSchema, billingCurrencySchema, billingUsageSchema, modelUsageFeatureSchema, modelUsagePurposeSchema, modelUsageReleaseSchema } from "./config";
import type { BillingChargeReceipt, BillingCredit, BillingReleaseMetadata, BillingSettlement, BillingSnapshot, BillingUsage, ModelUsageFeature, ModelUsagePurpose, ModelUsageRelease } from "./config";

export { billingCreditSchema, billingCurrencySchema, billingUsageSchema } from "./config";
export type { BillingChargeReceipt, BillingCredit, BillingCurrency, BillingReleaseMetadata, BillingSettlement, BillingSnapshot, BillingTransaction, BillingUsage, BillingWallet } from "./config";
export type { ModelUsageFilters, ModelUsagePage } from "@toonflow/multi-tenant-db";

const safeMicrosSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timeSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const walletSchema = z.object({
  userId: z.uuid(), currency: billingCurrencySchema, balanceMicros: safeMicrosSchema, reservedMicros: safeMicrosSchema,
}).refine(wallet => wallet.reservedMicros <= wallet.balanceMicros);
const recordSchema = z.object({
  requestId: z.uuid(), userId: z.uuid(), currency: billingCurrencySchema,
  kind: z.enum(["credit", "model"]), status: z.enum(["reserved", "settled", "released"]),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/), reservedMicros: safeMicrosSchema, amountMicros: safeMicrosSchema,
  details: z.record(z.string(), z.unknown()), usage: z.record(z.string(), z.unknown()).nullable(),
  createdAt: timeSchema, updatedAt: timeSchema,
}).refine(record => record.kind === "credit"
  ? record.status === "settled" && record.reservedMicros === 0 && record.amountMicros > 0
  : record.status === "settled" ? record.amountMicros <= record.reservedMicros : record.amountMicros === 0);
const chargeDetailsSchema = z.strictObject({
  routeId: z.uuid(), label: z.string().trim().min(1).max(128), type: z.enum(["text", "image", "video", "audio"]),
  revision: z.number().int().min(1).max(2147483647), salePrice: modelPriceSchema, costPrice: modelPriceSchema.nullable(),
  feature: modelUsageFeatureSchema.optional(), purpose: modelUsagePurposeSchema.optional(),
  coveredOrderId: z.uuid().optional(), baseSalePrice: modelPriceSchema.optional(),
});
const reserveSchema = z.strictObject({
  userId: z.uuid(), requestId: z.uuid(), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  route: modelRouteSchema, revision: z.number().int().min(1).max(2147483647), maximumUsage: billingUsageSchema,
  recoverExisting: z.boolean().optional(), feature: modelUsageFeatureSchema.optional(), purpose: modelUsagePurposeSchema.optional(), expectMembership: z.boolean().optional(),
});
const releaseMetadataSchema = z.strictObject({
  actorId: z.string().trim().min(1).max(64),
  reason: z.string().trim().min(1).max(256),
});

function fail(message: string, status: number): never { throw Object.assign(new Error(message), { status }); }

function micros(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) fail("计费金额无效", 400);
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, "0"));
}

function safeMicros(value: bigint) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail("计费金额超出可处理范围", 400);
  return Number(value);
}

function amount(value: number | bigint) {
  const units = typeof value === "bigint" ? value : BigInt(value);
  const fraction = (units % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${units / 1000000n}.${fraction}` : (units / 1000000n).toString();
}

function storedRecord(record: BillingRecord) {
  const parsed = recordSchema.safeParse(record);
  if (!parsed.success) fail("计费记录无效，请联系管理员", 503);
  return parsed.data;
}

function storedWallet(wallet: WalletRecord) {
  const parsed = walletSchema.safeParse(wallet);
  if (!parsed.success) fail("余额记录无效，请联系管理员", 503);
  return parsed.data;
}

function settlement(record: BillingRecord): BillingSettlement {
  if (record.status === "reserved") fail("计费记录尚未结算", 409);
  return { amount: amount(record.amountMicros), currency: record.currency, capped: record.usage?.capped === true, status: record.status };
}

function usageDetails(record: ModelUsageRecord) {
  const details = chargeDetailsSchema.safeParse(record.details);
  if (!details.success) fail("计费记录无效，请联系管理员", 503);
  const usage = record.usage;
  const release = modelUsageReleaseSchema.safeParse(usage?.outcome);
  return {
    requestId: record.requestId, userId: record.userId, userName: record.userName,
    routeId: details.data.routeId, model: details.data.label, modelType: details.data.type,
    feature: details.data.feature ?? "unknown",
    purpose: details.data.purpose ?? "unknown",
    status: record.status,
    releaseOutcome: record.status === "released" ? typeof usage?.releasedBy === "string" ? "manual" : release.data ?? null : null,
    outputFiles: typeof usage?.outputs === "number" ? usage.outputs : null,
    videoSeconds: details.data.type === "video" && typeof usage?.seconds === "number" ? usage.seconds : null,
    inputTokens: typeof usage?.input === "number" ? usage.input : null,
    outputTokens: typeof usage?.output === "number" ? usage.output : null,
    coveredOrderId: details.data.coveredOrderId ?? null,
    chargedAmount: record.status === "settled" ? amount(record.amountMicros) : null,
    currency: record.currency, createdAt: record.createdAt, updatedAt: record.updatedAt,
  };
}

export function createBilling(dataDirectory: string) {
  let database: Promise<AdminDatabase | undefined> | undefined;
  async function getDatabase() {
    if (database) return database;
    const opening = openDatabase(dataDirectory, false);
    database = opening;
    try {
      const current = await opening;
      if (!current && database === opening) database = undefined;
      return current;
    } catch (error) {
      if (database === opening) database = undefined;
      throw error;
    }
  }
  async function requireDatabase() {
    const db = await getDatabase();
    if (!db) fail("计费数据源尚未初始化，请联系管理员", 503);
    return db;
  }
  async function initialize() {
    const db = await requireDatabase();
    if (!await db.getAdmin()) fail("请先设置超级管理员账号", 409);
    await db.initialize();
    await db.initializeBilling();
    return db;
  }
  async function read(userId: string): Promise<BillingSnapshot> {
    z.uuid().parse(userId);
    const db = await getDatabase();
    const wallets = db ? (await db.getWallets(userId)).map(storedWallet) : [];
    const records = db ? (await db.listBillingRecords(userId, 20)).map(storedRecord) : [];
    if (wallets.some(wallet => wallet.userId !== userId) || records.some(record => record.userId !== userId)) {
      fail("计费记录归属不一致，请联系管理员", 503);
    }
    return {
      wallets: billingCurrencySchema.options.map(currency => {
        const wallet = wallets.find(item => item.currency === currency);
        const balance = BigInt(wallet?.balanceMicros ?? 0);
        const reserved = BigInt(wallet?.reservedMicros ?? 0);
        return { currency, balance: amount(balance), reserved: amount(reserved), available: amount(balance - reserved) };
      }),
      // ACT: 账号页仅展示最近 20 笔；完整账目始终保留在 SQL，不通过裁剪结果清理历史。
      transactions: records.map(record => ({
        id: record.requestId, kind: record.kind, status: record.status,
        // reserved 展示预占额，settled 展示实扣额，released 展示 0；SQL 实扣金额不变。
        amount: amount(record.status === "reserved" ? record.reservedMicros : record.amountMicros),
        currency: record.currency, createdAt: record.createdAt,
        label: typeof record.details.label === "string" ? record.details.label.slice(0, 128) : "",
        note: typeof record.details.note === "string" ? record.details.note.slice(0, 256)
          : typeof record.usage?.releaseReason === "string" ? record.usage.releaseReason.slice(0, 256) : "",
      })),
    };
  }
  async function ownedRecord(db: AdminDatabase, requestId: string, userId: string) {
    z.uuid().parse(requestId);
    z.uuid().parse(userId);
    const raw = await db.getBillingRecord(requestId);
    if (!raw) fail("计费记录不存在", 404);
    const record = storedRecord(raw);
    if (record.userId !== userId || record.kind !== "model") fail("无权操作此计费记录", 403);
    return record;
  }
  return {
    async initialize() { await initialize(); },
    read,
    async hasMembership(userId: string, routeId: string) {
      return Boolean(await (await getDatabase())?.activeMembership(userId, routeId, Date.now()));
    },
    async readUsage(filters: ModelUsageFilters) {
      const db = await getDatabase();
      const { activeUsers, groups, days, alerts } = await db?.readModelUsage(filters) ?? { activeUsers: 0, groups: [], days: [], alerts: [] };
      const requests = { total: 0, settled: 0, released: 0, reserved: 0 };
      for (const group of groups) {
        requests.total += group.requests;
        requests[group.status] += group.requests;
      }
      groups.sort((a, b) => b.requests - a.requests || a.feature.localeCompare(b.feature) || a.modelType.localeCompare(b.modelType));
      return { from: filters.from, to: filters.to, activeUsers, requests, groups, days, alerts };
    },
    async listUsage(filters: ModelUsagePage) {
      const db = await getDatabase();
      const rows = await db?.listModelUsage(filters) ?? [];
      const page = rows.slice(0, filters.limit);
      const last = rows.length > filters.limit ? page.at(-1) : undefined;
      return {
        from: filters.from, to: filters.to, items: page.map(usageDetails),
        nextCursor: last ? { createdAt: last.createdAt, requestId: last.requestId } : null,
      };
    },
    async getCharge(requestId: string, userId: string): Promise<BillingChargeReceipt> {
      const record = await ownedRecord(await requireDatabase(), requestId, userId);
      return {
        status: record.status, currency: record.currency,
        amount: amount(record.status === "reserved" ? record.reservedMicros : record.amountMicros),
      };
    },
    async credit(input: BillingCredit): Promise<BillingSnapshot> {
      const value = billingCreditSchema.parse(input);
      const db = await initialize();
      if (!await db.getUserById(value.userId)) fail("账号不存在", 404);
      const amountMicros = safeMicros(micros(value.amount));
      const note = value.note ?? "";
      const requestHash = createHash("sha256").update(JSON.stringify({
        kind: "credit", userId: value.userId, currency: value.currency, amountMicros, note,
      })).digest("hex");
      const result = await db.creditWallet({
        requestId: value.requestId, userId: value.userId, currency: value.currency, amountMicros,
        requestHash, details: { note }, createdAt: Date.now(),
      });
      if (result === "duplicate") {
        const previous = await db.getBillingRecord(value.requestId);
        if (!previous || previous.kind !== "credit" || previous.userId !== value.userId || previous.requestHash !== requestHash) {
          fail("请求标识已被其他操作使用", 409);
        }
        storedRecord(previous);
      }
      return read(value.userId);
    },
    async reserve(input: { userId: string; requestId: string; requestHash: string; route: ModelRoute; revision: number; maximumUsage: BillingUsage; recoverExisting?: boolean; feature?: ModelUsageFeature; purpose?: ModelUsagePurpose; expectMembership?: boolean }) {
      const value = reserveSchema.parse(input);
      if (!value.route.enabled) fail("模型路由已停用", 403);
      const db = await requireDatabase();
      const user = await db.getUserById(value.userId);
      if (!user) fail("账号不存在", 404);
      if (user.disabled) fail("账号已禁用", 403);
      const now = Date.now();
      const membership = ["image", "video"].includes(value.route.type) ? await db.activeMembership(value.userId, value.route.id, now) : undefined;
      async function recover() {
        const previous = await db!.getBillingRecord(value.requestId);
        if (!previous || previous.kind !== "model" || previous.userId !== value.userId || previous.requestHash !== value.requestHash) {
          fail("请求标识已被其他操作使用", 409);
        }
        storedRecord(previous);
        if (!value.recoverExisting || previous.status !== "reserved") fail("请求已处理，请勿重复提交", 409);
        const prior = chargeDetailsSchema.safeParse(previous.details);
        const originalQuote = prior.success && calculateModelPrice(prior.data.salePrice, value.maximumUsage);
        if (!prior.success || prior.data.routeId !== value.route.id || prior.data.revision !== value.revision
          || value.expectMembership && !prior.data.coveredOrderId
          || !originalQuote || previous.currency !== originalQuote.currency || previous.reservedMicros !== safeMicros(micros(originalQuote.amount))
          || JSON.stringify(prior.data.baseSalePrice ?? prior.data.salePrice) !== JSON.stringify(value.route.salePrice)
          || JSON.stringify(prior.data.costPrice) !== JSON.stringify(value.route.costPrice)) fail("计费请求与原预占记录不一致", 409);
        return { id: previous.requestId, amount: amount(previous.reservedMicros), currency: previous.currency, reused: true };
      }
      if (value.expectMembership && !membership) {
        if (value.recoverExisting && await db.getBillingRecord(value.requestId)) return recover();
        throw Object.assign(new Error("月卡已失效或不包含该模型，请刷新后重试"), { status: 409, code: "membershipUnavailable" });
      }
      const salePrice = membership ? { mode: "perRequest" as const, currency: value.route.salePrice.currency, amount: "0" } : value.route.salePrice;
      const quote = calculateModelPrice(salePrice, value.maximumUsage);
      if (!quote) fail("无法确定本次请求的计费用量", 400);
      const reservedMicros = safeMicros(micros(quote.amount));
      const details = {
        routeId: value.route.id, label: value.route.label, type: value.route.type, revision: value.revision,
        salePrice, costPrice: value.route.costPrice,
        ...(membership ? { coveredOrderId: membership.id, baseSalePrice: value.route.salePrice } : {}),
        ...(value.feature ? { feature: value.feature } : {}),
        ...(value.purpose ? { purpose: value.purpose } : {}),
      };
      const result = await db.reserveWallet({
        requestId: value.requestId, userId: value.userId, currency: quote.currency, reservedMicros,
        requestHash: value.requestHash, details, createdAt: now,
      });
      if (result === "insufficient") fail(quote.currency === "POINTS" ? "积分不足，请先充值。" : "余额不足，请联系管理员充值", 402);
      if (result === "duplicate") return recover();
      return { id: value.requestId, amount: quote.amount, currency: quote.currency, reused: false };
    },
    async settle(requestId: string, userId: string, usage: BillingUsage): Promise<BillingSettlement> {
      const db = await requireDatabase();
      let record = await ownedRecord(db, requestId, userId);
      if (record.status !== "reserved") return settlement(record);
      const details = chargeDetailsSchema.safeParse(record.details);
      if (!details.success || details.data.salePrice.currency !== record.currency) fail("计费记录无效，请联系管理员", 503);
      const counts = billingUsageSchema.parse(usage);
      const quote = calculateModelPrice(details.data.salePrice, counts);
      if (!quote) fail("无法确定本次请求的实际计费用量", 400);
      const actual = micros(quote.amount);
      const held = BigInt(record.reservedMicros);
      const capped = actual > held;
      const charged = capped ? held : actual;
      const cost = details.data.costPrice ? calculateModelPrice(details.data.costPrice, counts) : null;
      const recordedUsage: Record<string, unknown> = {
        ...counts, capped, calculatedAmount: quote.amount,
        costAmount: cost?.amount ?? null, costCurrency: cost?.currency ?? null,
      };
      if (await db.settleWallet(requestId, userId, safeMicros(charged), recordedUsage, Date.now())) {
        return { amount: amount(charged), currency: record.currency, capped, status: "settled" };
      }
      record = await ownedRecord(db, requestId, userId);
      if (record.status === "reserved") fail("计费状态发生冲突，请联系管理员", 409);
      return settlement(record);
    },
    async release(requestId: string, userId: string, metadata?: BillingReleaseMetadata | { outcome: ModelUsageRelease }) {
      let audit: Record<string, unknown> | undefined;
      if (metadata && "outcome" in metadata) audit = { outcome: modelUsageReleaseSchema.parse(metadata.outcome) };
      else if (metadata) {
        const manual = releaseMetadataSchema.parse(metadata);
        audit = { releasedBy: manual.actorId, releaseReason: manual.reason };
      }
      const db = await requireDatabase();
      const record = await ownedRecord(db, requestId, userId);
      if (record.status !== "reserved") return;
      if (await db.releaseWallet(requestId, userId, Date.now(), audit)) return;
      if ((await ownedRecord(db, requestId, userId)).status === "reserved") fail("计费状态发生冲突，请联系管理员", 409);
    },
  };
}
