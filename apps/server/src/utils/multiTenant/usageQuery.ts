import { z } from "zod";
import { modelUsageFeatureSchema, modelUsagePurposeSchema } from "@toonflow/multi-tenant-billing/config";

const day = 24 * 60 * 60 * 1000;
const timestamp = z.string().regex(/^\d{1,16}$/).transform(Number).pipe(z.number().int().min(0).max(8640000000000000));
export const usageQueryFields = {
  from: timestamp.optional(), to: timestamp.optional(), userId: z.uuid().optional(), routeId: z.uuid().optional(),
  modelType: z.enum(["text", "image", "video", "audio"]).optional(),
  feature: modelUsageFeatureSchema.or(z.literal("unknown")).optional(),
  purpose: modelUsagePurposeSchema.or(z.literal("unknown")).optional(),
};
export const usagePageFields = {
  ...usageQueryFields,
  limit: z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
  beforeAt: timestamp.optional(), beforeId: z.uuid().optional(),
};
const usageQuerySchema = z.object(usageQueryFields);
const usagePageSchema = z.object(usagePageFields);

export function readUsageFilters(query: unknown) {
  const parsed = usageQuerySchema.parse(query);
  const to = parsed.to ?? Date.now();
  const from = parsed.from ?? Math.max(0, to - 30 * day);
  if (from >= to || to - from > 90 * day) {
    throw Object.assign(new Error("用量统计时间范围必须大于零且不超过 90 天"), { status: 400 });
  }
  return { ...parsed, from, to };
}

export function readUsagePage(query: unknown) {
  const filters = readUsageFilters(query);
  const { beforeAt, beforeId, limit } = usagePageSchema.parse(query);
  if ((beforeAt === undefined) !== (beforeId === undefined)) {
    throw Object.assign(new Error("请同时提供用量记录的时间游标和请求 ID"), { status: 400 });
  }
  return { ...filters, limit: limit ?? 20,
    before: beforeAt === undefined || beforeId === undefined ? undefined : { createdAt: beforeAt, requestId: beforeId } };
}
