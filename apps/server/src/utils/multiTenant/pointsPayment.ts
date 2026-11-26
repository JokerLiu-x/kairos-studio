import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { dirname } from "node:path";
import type { Request } from "express";
import { z } from "zod";
import { openDatabase, type AdminDatabase, type PointsOrder } from "@toonflow/multi-tenant-db";
import { pointsPacks, pointsRates } from "@toonflow/multi-tenant-billing/config";
import conf from "@/utils/conf";
import { assertAppRequest } from "@/utils/mcp/control";
import { modelGateway } from "./gateway";
import { isEnabled } from "./mode";
import { requestIdentity } from "./runtime";

function fail(message: string, status: number): never { throw Object.assign(new Error(message), { status }); }

function paymentConfig() {
  const {
    KAIROS_ALIPAY_APP_ID: appId, KAIROS_ALIPAY_SELLER_ID: sellerId, KAIROS_ALIPAY_PRIVATE_KEY: privateKey,
    KAIROS_ALIPAY_PUBLIC_KEY: publicKey, KAIROS_PAYMENT_ORIGIN: origin,
  } = process.env;
  if (!appId || !sellerId || !privateKey || !publicKey || !origin) return undefined;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash
      || !/^\d{16}$/.test(appId) || !/^\d{16}$/.test(sellerId)) return undefined;
    const signingKey = createPrivateKey(privateKey.replaceAll("\\n", "\n"));
    const verifyingKey = createPublicKey(publicKey.replaceAll("\\n", "\n"));
    if (signingKey.asymmetricKeyType !== "rsa" || verifyingKey.asymmetricKeyType !== "rsa"
      || (signingKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || (verifyingKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return undefined;
    return { appId, sellerId, origin: url.origin, signingKey, verifyingKey };
  } catch { return undefined; }
}

function requireConfig() {
  const config = paymentConfig();
  if (!isEnabled() || !config) fail("在线充值尚未启用。", 503);
  return config;
}

function requireBuyer(req: Request) {
  assertAppRequest(req);
  const buyer = requestIdentity(req);
  if (!isEnabled() || buyer?.role !== "user") fail("请使用创作账号登录后充值。", 401);
  return buyer;
}

let checkoutDatabase: ReturnType<typeof openDatabase> | undefined;
async function database() {
  const opening = checkoutDatabase ??= openDatabase(dirname(conf.path)).then(async db => {
    if (!db) fail("积分订单数据源尚未初始化。", 503);
    await db.initializeBilling();
    return db;
  });
  try {
    const db = await opening;
    if (!db) fail("积分订单数据源尚未初始化。", 503);
    return db;
  } catch (cause) {
    if (checkoutDatabase === opening) checkoutDatabase = undefined;
    throw cause;
  }
}

function canonical(params: Record<string, string>) {
  return Object.keys(params).sort().filter(key => params[key] !== "").map(key => `${key}=${params[key]}`).join("&");
}

async function orderStatus(db: AdminDatabase, order: PointsOrder) {
  const receipt = await db.getBillingRecord(order.creditId);
  const paid = receipt?.userId === order.userId && receipt.kind === "credit" && receipt.currency === "POINTS" && receipt.status === "settled";
  return {
    id: order.id, packId: order.packId, amountFen: order.amountFen, points: order.points,
    status: paid ? "paid" as const : Date.now() >= order.createdAt + 30 * 60_000 ? "expired" as const : "pending" as const,
  };
}

export function pointsCatalog(req: Request) {
  return { packs: pointsPacks, rates: pointsRates, online: isEnabled() && Boolean(paymentConfig()), signedIn: requestIdentity(req)?.role === "user" };
}

export async function createPointsOrder(req: Request, packId: string, id: string) {
  const buyer = requireBuyer(req);
  const config = requireConfig();
  const pack = pointsPacks.find(item => item.id === packId);
  if (!pack) return fail("积分套餐不存在。", 404);
  const db = await database();
  await db.createPointsOrder({ id, creditId: randomUUID(), userId: buyer.id, packId, amountFen: pack.amountFen, points: pack.points, createdAt: Date.now() });
  const order = await db.getPointsOrder(id);
  if (!order || order.userId !== buyer.id || order.packId !== packId) return fail("该订单标识已被使用。", 409);
  const summary = await orderStatus(db, order);
  if (summary.status !== "pending") return { ...summary, payment: null };

  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const params = {
    app_id: config.appId, method: "alipay.trade.page.pay", charset: "UTF-8", sign_type: "RSA2",
    timestamp: formatter.format(new Date()), version: "1.0",
    notify_url: `${config.origin}/api/points/notify`, return_url: `${config.origin}/#/studio/points?order=${id}`,
    biz_content: JSON.stringify({
      out_trade_no: id, product_code: "FAST_INSTANT_TRADE_PAY", subject: `Kairos ${order.points} 积分`,
      total_amount: (order.amountFen / 100).toFixed(2), time_expire: formatter.format(new Date(order.createdAt + 30 * 60_000)),
    }),
  };
  const signature = sign("RSA-SHA256", Buffer.from(canonical(params)), config.signingKey).toString("base64");
  return { ...summary, payment: { action: "https://openapi.alipay.com/gateway.do?charset=UTF-8", fields: { ...params, sign: signature } } };
}

export async function getPointsOrder(req: Request, id: string) {
  const buyer = requireBuyer(req);
  const db = await database();
  const order = await db.getPointsOrder(id);
  if (!order || order.userId !== buyer.id) return fail("订单不存在。", 404);
  return orderStatus(db, order);
}

export async function receivePointsPayment(raw: unknown) {
  const config = requireConfig();
  const parsed = z.record(z.string(), z.string()).safeParse(raw);
  if (!parsed.success) return false;
  const { sign: signature, sign_type: signType, ...params } = parsed.data;
  if (signType !== "RSA2" || !signature || !verify("RSA-SHA256", Buffer.from(canonical(params)), config.verifyingKey, Buffer.from(signature, "base64"))
    || params.app_id !== config.appId || params.seller_id !== config.sellerId || !z.uuid().safeParse(params.out_trade_no).success) return false;
  const order = await (await database()).getPointsOrder(params.out_trade_no!);
  if (!order || !/^\d{1,8}(?:\.\d{1,2})?$/.test(params.total_amount ?? "")) return false;
  const [yuan, cents = ""] = params.total_amount!.split(".");
  if (Number(yuan) * 100 + Number(cents.padEnd(2, "0")) !== order.amountFen) return false;
  if (params.trade_status !== "TRADE_SUCCESS" && params.trade_status !== "TRADE_FINISHED") return true;
  if (!/^\d{8,64}$/.test(params.trade_no ?? "")) return false;
  // 支付通知重发时复用订单专用账本标识，钱包和流水由同一事务提交。
  await modelGateway.credit({ userId: order.userId, requestId: order.creditId, currency: "POINTS", amount: String(order.points),
    note: `支付宝充值 ${params.trade_no}` });
  return true;
}
