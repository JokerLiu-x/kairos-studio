import { and, eq, gte, lt, or, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import type { BillingRecord, mysqlBillingLedger, sqliteBillingLedger } from "./schema";

export type ModelUsageFilters = {
  from: number;
  to: number;
  userId?: string;
  modelType?: string;
  feature?: string;
  purpose?: string;
  routeId?: string;
};
export type ModelUsageCursor = Pick<BillingRecord, "createdAt" | "requestId">;
export type ModelUsagePage = ModelUsageFilters & { limit: number; before?: ModelUsageCursor };
export type ModelUsageRecord = Pick<BillingRecord, "requestId" | "userId" | "status" | "currency" | "amountMicros" | "details" | "usage" | "createdAt" | "updatedAt">
  & { userName: string | null };
export type ModelUsageGroup = {
  feature: string;
  modelType: string;
  purpose: string;
  status: BillingRecord["status"];
  releaseOutcome: string | null;
  requests: number;
  outputFiles: number | null;
  videoSeconds: number | null;
  videoRequestsWithDuration: number;
  inputTokens: number | null;
  outputTokens: number | null;
};
export type ModelUsageDay = { day: number; requests: number; activeUsers: number; images: number; videos: number };
export type ModelUsageAlert = { userId: string; userName: string | null; recentRequests: number; previousRequests: number; failedLastThree: boolean; staleRequests: number };

const dayMs = 86400000;

export function modelUsageQuery(ledger: typeof sqliteBillingLedger | typeof mysqlBillingLedger, unwrapJson: (value: SQL) => SQL) {
  // 固定 JSON 路径保持 SELECT 和 GROUP BY 表达式一致，筛选参数仍由 ORM 绑定。
  const field = (column: SQLWrapper, path: SQL) => unwrapJson(sql`json_extract(${column}, ${path})`);
  const feature = sql<string>`coalesce(${field(ledger.details, sql`'$.feature'`)}, 'unknown')`;
  const modelType = sql<string>`coalesce(${field(ledger.details, sql`'$.type'`)}, 'unknown')`;
  const purpose = sql<string>`coalesce(${field(ledger.details, sql`'$.purpose'`)}, 'unknown')`;
  const status = sql<BillingRecord["status"]>`${ledger.status}`;
  const releaseOutcome = sql<string | null>`case when ${status} = 'released' then
    case when ${field(ledger.usage, sql`'$.releasedBy'`)} is not null then 'manual' else ${field(ledger.usage, sql`'$.outcome'`)} end end`;
  const outputFiles = field(ledger.usage, sql`'$.outputs'`);
  const seconds = sql`case when ${modelType} = 'video' then ${field(ledger.usage, sql`'$.seconds'`)} end`;
  const sum = (value: SQLWrapper) => sql<number | null>`sum(${value})`.mapWith(Number);
  const day = sql<number>`floor((${ledger.createdAt} + 28800000) / 86400000)`.mapWith(Number);
  function where(filters: ModelUsageFilters, before?: ModelUsageCursor) {
    return and(eq(ledger.kind, "model"), gte(ledger.createdAt, filters.from), lt(ledger.createdAt, filters.to),
      filters.userId ? eq(ledger.userId, filters.userId) : undefined,
      filters.routeId ? eq(field(ledger.details, sql`'$.routeId'`), filters.routeId) : undefined,
      filters.modelType ? eq(modelType, filters.modelType) : undefined,
      filters.feature ? eq(feature, filters.feature) : undefined,
      filters.purpose ? eq(purpose, filters.purpose) : undefined,
      before ? or(lt(ledger.createdAt, before.createdAt), and(eq(ledger.createdAt, before.createdAt), lt(ledger.requestId, before.requestId))) : undefined);
  }
  return {
    where, day,
    daily: {
      day, requests: sql<number>`count(*)`.mapWith(Number), activeUsers: sql<number>`count(distinct ${ledger.userId})`.mapWith(Number),
      images: sql<number>`sum(case when ${modelType} = 'image' then coalesce(${outputFiles}, 0) else 0 end)`.mapWith(Number),
      videos: sql<number>`sum(case when ${modelType} = 'video' then coalesce(${outputFiles}, 0) else 0 end)`.mapWith(Number),
    },
    alerts(filters: ModelUsageFilters) {
      const recent = filters.to - 7 * dayMs;
      const previous = recent - 7 * dayMs;
      const stale = filters.to - 3600000;
      return sql`with scoped as (
        select ${ledger.userId} as userId, ${ledger.createdAt} as createdAt, ${status} as status,
          ${releaseOutcome} as outcome, ${ledger.updatedAt} as updatedAt, ${ledger.requestId} as requestId
        from ${ledger} where ${where({ ...filters, from: Math.max(0, Math.min(filters.from, previous)) })}
      ), ranked as (
        select scoped.*, row_number() over (partition by userId order by
          case when status = 'reserved' then 1 else 0 end, updatedAt desc, requestId desc) as completionRank from scoped
      ), amounts as (
        select userId,
          sum(case when createdAt >= ${recent} then 1 else 0 end) as recentRequests,
          sum(case when createdAt >= ${previous} and createdAt < ${recent} then 1 else 0 end) as previousRequests,
          sum(case when completionRank <= 3 and updatedAt >= ${recent}
            and outcome in ('failed', 'rejected', 'notSubmitted') then 1 else 0 end) as failedCount,
          sum(case when status = 'reserved' and createdAt <= ${stale} then 1 else 0 end) as staleRequests
        from ranked group by userId
      )
      select amounts.*, users.userName as userName from amounts
      left join multiTenantUser users on users.id = amounts.userId
      where staleRequests > 0 or failedCount = 3 or (recentRequests >= 20 and recentRequests >= 2 * previousRequests)
      order by staleRequests desc, failedCount desc, recentRequests desc, amounts.userId limit 50`;
    },
    activeUsers: { count: sql<number>`count(distinct ${ledger.userId})`.mapWith(Number) },
    group: [feature, modelType, purpose, status, releaseOutcome] as const,
    totals: {
      feature, modelType, purpose, status, releaseOutcome, requests: sql<number>`count(*)`.mapWith(Number),
      outputFiles: sum(outputFiles), videoSeconds: sum(seconds), videoRequestsWithDuration: sql<number>`count(${seconds})`.mapWith(Number),
      inputTokens: sum(field(ledger.usage, sql`'$.input'`)), outputTokens: sum(field(ledger.usage, sql`'$.output'`)),
    },
  };
}

export function mapModelUsageAlerts(rows: Array<{ userId: string; userName: string | null; recentRequests: string | number;
  previousRequests: string | number; failedCount: string | number; staleRequests: string | number }>): ModelUsageAlert[] {
  return rows.map(row => ({ userId: row.userId, userName: row.userName, recentRequests: Number(row.recentRequests),
    previousRequests: Number(row.previousRequests), failedLastThree: Number(row.failedCount) === 3, staleRequests: Number(row.staleRequests) }));
}
export type ModelUsageAlertRow = Parameters<typeof mapModelUsageAlerts>[0][number];
