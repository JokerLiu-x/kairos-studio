import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { and, asc, count, desc, eq, getTableColumns, gte, lt, or, sql } from "drizzle-orm";
import { mysqlSchema, varchar } from "drizzle-orm/mysql-core";
import { mysqlAdmin, mysqlBillingLedger, mysqlModelRouting, mysqlPointsOrder, mysqlSettings, mysqlSourceMapping, mysqlUser, mysqlWallet, mysqlWebSession } from "./schema";
import type { AdminDatabase, WalletRecord } from "./schema";
import type { DataSource } from "./index";
import { mapModelUsageAlerts, modelUsageQuery, type ModelUsageAlertRow } from "./modelUsage";
import { commerceError, commerceQuery, confirmEntry, confirmPurchase, membershipDuration, mysqlMembershipOrder, mysqlCommerceEntry } from "./commerce";
import { maxWalletMicros, validateWalletAmount, walletBalanceOverflow, walletSettlementExceeded, walletStateConflict } from "./billing";

const informationColumns = mysqlSchema("information_schema").table("COLUMNS", {
  tableSchema: varchar("TABLE_SCHEMA", { length: 64 }).notNull(),
  tableName: varchar("TABLE_NAME", { length: 64 }).notNull(),
  columnName: varchar("COLUMN_NAME", { length: 64 }).notNull(),
  columnType: varchar("COLUMN_TYPE", { length: 255 }).notNull(),
});
const informationTables = mysqlSchema("information_schema").table("TABLES", {
  tableSchema: varchar("TABLE_SCHEMA", { length: 64 }).notNull(),
  tableName: varchar("TABLE_NAME", { length: 64 }).notNull(),
  engine: varchar("ENGINE", { length: 64 }),
});

export function connectMysql(config: Extract<DataSource, { provider: "mysql" }>["mysql"]): AdminDatabase {
  const client = mysql.createPool({ ...config, connectionLimit: 5, ...(config.ssl ? { ssl: { ...config.ssl, rejectUnauthorized: true } } : {}) });
  const db = drizzle(client);
  const commerce = commerceQuery(mysqlMembershipOrder);
  const usage = modelUsageQuery(mysqlBillingLedger, value => sql`json_unquote(${value})`);
  let accountColumn: boolean | undefined;
  let initialized = false;
  let billingEngine: Promise<void> | undefined;
  async function columns(tableName = "multiTenantAdmin") {
    return db.select({ columnName: informationColumns.columnName }).from(informationColumns).where(and(
      eq(informationColumns.tableSchema, config.database), eq(informationColumns.tableName, tableName),
    ));
  }
  function errorCode(error: unknown) {
    const failure = error as { code?: string; cause?: { code?: string } };
    return failure.cause?.code ?? failure.code;
  }
  function requireWallet(wallet: WalletRecord | undefined) {
    if (!wallet || !Number.isSafeInteger(wallet.balanceMicros) || !Number.isSafeInteger(wallet.reservedMicros)
      || wallet.balanceMicros < 0 || wallet.balanceMicros > maxWalletMicros || wallet.reservedMicros < 0
      || wallet.reservedMicros > wallet.balanceMicros) walletStateConflict();
    return wallet;
  }
  async function requireBillingEngine() {
    if (billingEngine) return billingEngine;
    const checking = (async () => {
      const tables = await db.select({ engine: informationTables.engine }).from(informationTables).where(and(
        eq(informationTables.tableSchema, config.database),
        sql`${informationTables.tableName} IN (${"multiTenantWallet"}, ${"multiTenantBillingLedger"})`,
      ));
      if (tables.length !== 2 || tables.some(table => table.engine?.toLowerCase() !== "innodb")) {
        throw Object.assign(new Error("钱包数据表尚未初始化或存储引擎不支持事务"), { code: "walletStorageUnavailable", status: 503 });
      }
    })();
    billingEngine = checking;
    try { await checking; }
    catch (error) {
      if (billingEngine === checking) billingEngine = undefined;
      throw error;
    }
  }
  const insufficientWallet = new Error("余额不足");
  return {
    async initializeBilling() {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS multiTenantWallet (
        userId VARCHAR(36) NOT NULL,
        currency ENUM('CNY', 'USD', 'POINTS') NOT NULL,
        balanceMicros BIGINT NOT NULL DEFAULT 0,
        reservedMicros BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (userId, currency),
        CHECK (balanceMicros >= 0 AND balanceMicros <= 9007199254740991),
        CHECK (reservedMicros >= 0 AND reservedMicros <= balanceMicros)
      ) ENGINE=InnoDB`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS multiTenantBillingLedger (
        requestId VARCHAR(36) PRIMARY KEY,
        userId VARCHAR(36) NOT NULL,
        currency ENUM('CNY', 'USD', 'POINTS') NOT NULL,
        kind ENUM('credit', 'model') NOT NULL,
        status ENUM('reserved', 'settled', 'released') NOT NULL,
        requestHash VARCHAR(64) NOT NULL,
        reservedMicros BIGINT NOT NULL DEFAULT 0,
        amountMicros BIGINT NOT NULL DEFAULT 0,
        details JSON NOT NULL,
        \`usage\` JSON,
        createdAt BIGINT NOT NULL,
        updatedAt BIGINT NOT NULL,
        INDEX multiTenantBillingLedgerUserCreatedAt (userId, createdAt),
        CHECK (reservedMicros >= 0 AND reservedMicros <= 9007199254740991),
        CHECK (amountMicros >= 0 AND amountMicros <= 9007199254740991)
      ) ENGINE=InnoDB`);
      await requireBillingEngine();
      const currencyColumns = await db.select({ table: informationColumns.tableName, type: informationColumns.columnType }).from(informationColumns)
        .where(and(eq(informationColumns.tableSchema, config.database), eq(informationColumns.columnName, "currency"),
          sql`${informationColumns.tableName} IN ('multiTenantWallet', 'multiTenantBillingLedger')`));
      if (currencyColumns.some(column => column.table === "multiTenantWallet" && !column.type.includes("'POINTS'"))) {
        await db.execute(sql`ALTER TABLE multiTenantWallet MODIFY currency ENUM('CNY', 'USD', 'POINTS') NOT NULL`);
      }
      if (currencyColumns.some(column => column.table === "multiTenantBillingLedger" && !column.type.includes("'POINTS'"))) {
        await db.execute(sql`ALTER TABLE multiTenantBillingLedger MODIFY currency ENUM('CNY', 'USD', 'POINTS') NOT NULL`);
      }
      await db.execute(sql`CREATE TABLE IF NOT EXISTS kairosPointsOrder (
        id VARCHAR(36) PRIMARY KEY, creditId VARCHAR(36) NOT NULL UNIQUE, userId VARCHAR(36) NOT NULL, packId VARCHAR(32) NOT NULL,
        amountFen INT NOT NULL, points INT NOT NULL, createdAt BIGINT NOT NULL
      ) ENGINE=InnoDB`);
    },
    async createPointsOrder(order) {
      await db.insert(mysqlPointsOrder).values(order).onDuplicateKeyUpdate({ set: { id: sql`id` } });
    },
    async getPointsOrder(id) {
      return (await db.select().from(mysqlPointsOrder).where(eq(mysqlPointsOrder.id, id)).limit(1))[0];
    },
    async initializeCommerce() {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS kairosMembershipOrder (
        id VARCHAR(36) PRIMARY KEY NOT NULL, userId VARCHAR(36) NOT NULL,
        paymentRef VARCHAR(80) COLLATE utf8mb4_bin NOT NULL UNIQUE,
        rate ENUM('intro','standard') NOT NULL, segment ENUM('merchant','creator','unknown') NOT NULL,
        paidFen INTEGER NOT NULL, refundedFen INTEGER NOT NULL DEFAULT 0,
        imageRouteId VARCHAR(36), videoRouteId VARCHAR(36),
        paidAt BIGINT NOT NULL, startsAt BIGINT NOT NULL, endsAt BIGINT NOT NULL,
        CHECK (paidFen > 0 AND refundedFen >= 0 AND refundedFen <= paidFen)
        , INDEX kairosMembershipUserStarts (userId, startsAt), INDEX kairosMembershipPaidAt (paidAt)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS kairosCommerceEntry (
        id VARCHAR(36) PRIMARY KEY NOT NULL, orderId VARCHAR(36) NOT NULL,
        kind ENUM('refund','model','fee','support') NOT NULL, value INTEGER NOT NULL,
        quantity INTEGER NOT NULL, note VARCHAR(256) NOT NULL, createdAt BIGINT NOT NULL,
        CHECK (value > 0 AND quantity >= 0), INDEX kairosCommerceOrderTime (orderId, createdAt), INDEX kairosCommerceTime (createdAt)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    },
    async addMembership(input) {
      try { return await db.transaction(async tx => {
        const owner = (await tx.select({ id: mysqlUser.id, disabled: mysqlUser.disabled }).from(mysqlUser).where(eq(mysqlUser.id, input.userId)).limit(1).for("update"))[0];
        if (!owner) commerceError("账号不存在", 404);
        const previous = (await tx.select().from(mysqlMembershipOrder).where(or(eq(mysqlMembershipOrder.id, input.id), eq(mysqlMembershipOrder.paymentRef, input.paymentRef))).limit(1))[0];
        if (previous) return confirmPurchase(input, previous);
        if (owner.disabled) commerceError("账号已禁用", 403);
        const latest = (await tx.select().from(mysqlMembershipOrder).where(and(eq(mysqlMembershipOrder.userId, input.userId), sql`${mysqlMembershipOrder.refundedFen} < ${mysqlMembershipOrder.paidFen}`)).orderBy(desc(mysqlMembershipOrder.endsAt)).limit(1))[0];
        if (input.rate === "intro") {
          const prior = (await tx.select({ id: mysqlMembershipOrder.id }).from(mysqlMembershipOrder).where(eq(mysqlMembershipOrder.userId, input.userId)).limit(1))[0];
          if (prior) commerceError("此账号已购买过月卡，不能再使用首月价");
        }
        const now = Date.now();
        const paidAt = input.paidAt ?? now;
        const startsAt = Math.max(now, latest?.endsAt ?? 0);
        const order = { ...input, paidAt, startsAt, endsAt: startsAt + membershipDuration, refundedFen: 0 };
        await tx.insert(mysqlMembershipOrder).values(order);
        return order;
      }); } catch (error) {
        if (errorCode(error) !== "ER_DUP_ENTRY") throw error;
        const previous = (await db.select().from(mysqlMembershipOrder).where(or(eq(mysqlMembershipOrder.id, input.id), eq(mysqlMembershipOrder.paymentRef, input.paymentRef))).limit(1))[0];
        if (!previous) throw error;
        return confirmPurchase(input, previous);
      }
    },
    async activeMembership(userId, routeId, at) {
      try {
        return (await db.select().from(mysqlMembershipOrder).where(commerce.active(userId, routeId, at)).orderBy(desc(mysqlMembershipOrder.startsAt)).limit(1))[0];
      } catch (error) {
        if (errorCode(error) === "ER_NO_SUCH_TABLE") return;
        throw error;
      }
    },
    async listMemberships(filters) {
      try {
        const firstOutputAt = (type: "image" | "video") => sql<number | null>`(select min(${mysqlBillingLedger.updatedAt}) from multiTenantBillingLedger
          where ${mysqlBillingLedger.userId} = ${mysqlMembershipOrder.userId} and ${mysqlBillingLedger.createdAt} >= ${mysqlMembershipOrder.startsAt}
          and ${mysqlBillingLedger.createdAt} < ${mysqlMembershipOrder.endsAt} and ${mysqlBillingLedger.status} = 'settled'
          and json_unquote(json_extract(${mysqlBillingLedger.details}, '$.coveredOrderId')) = ${mysqlMembershipOrder.id}
          and json_unquote(json_extract(${mysqlBillingLedger.details}, '$.type')) = ${type}
          and json_extract(${mysqlBillingLedger.usage}, '$.outputs') > 0)`.mapWith(Number);
        const modelPacks = sql<number>`(select coalesce(sum(${mysqlCommerceEntry.quantity}), 0) from kairosCommerceEntry
          where ${mysqlCommerceEntry.orderId} = ${mysqlMembershipOrder.id} and ${mysqlCommerceEntry.kind} = 'model')`.mapWith(Number);
        const rows = await db.select({ order: getTableColumns(mysqlMembershipOrder), userName: mysqlUser.userName,
          firstImageAt: firstOutputAt("image"), firstVideoAt: firstOutputAt("video"), modelPacks, renewed: commerce.renewed })
          .from(mysqlMembershipOrder).leftJoin(mysqlUser, eq(mysqlUser.id, mysqlMembershipOrder.userId)).where(commerce.list(filters))
          .orderBy(desc(mysqlMembershipOrder.paidAt), desc(mysqlMembershipOrder.id)).limit(filters.limit + 1);
        return rows.map(({ order, ...extra }) => ({ ...order, ...extra }));
      } catch (error) {
        if (errorCode(error) === "ER_NO_SUCH_TABLE") return [];
        throw error;
      }
    },
    async addCommerceEntry(input) {
      try { return await db.transaction(async tx => {
        const order = (await tx.select().from(mysqlMembershipOrder).where(eq(mysqlMembershipOrder.id, input.orderId)).limit(1).for("update"))[0];
        if (!order) commerceError("月卡订单不存在", 404);
        const previous = (await tx.select().from(mysqlCommerceEntry).where(eq(mysqlCommerceEntry.id, input.id)).limit(1))[0];
        if (previous) return confirmEntry(input, previous);
        if (input.kind === "refund") {
          if (input.value > order.paidFen - order.refundedFen) commerceError("退款金额超过订单可退款余额", 400);
          await tx.update(mysqlMembershipOrder).set({ refundedFen: order.refundedFen + input.value }).where(eq(mysqlMembershipOrder.id, order.id));
        }
        const entry = { ...input, createdAt: Date.now() };
        await tx.insert(mysqlCommerceEntry).values(entry);
        return entry;
      }); } catch (error) {
        if (errorCode(error) !== "ER_DUP_ENTRY") throw error;
        const previous = (await db.select().from(mysqlCommerceEntry).where(eq(mysqlCommerceEntry.id, input.id)).limit(1))[0];
        if (!previous) throw error;
        return confirmEntry(input, previous);
      }
    },
    async listCommerceEntries(orderId, limit) {
      try {
        return await db.select().from(mysqlCommerceEntry).where(eq(mysqlCommerceEntry.orderId, orderId)).orderBy(desc(mysqlCommerceEntry.createdAt), desc(mysqlCommerceEntry.id)).limit(limit);
      } catch (error) {
        if (errorCode(error) === "ER_NO_SUCH_TABLE") return [];
        throw error;
      }
    },
    async readCommerceTotals(period) {
      const empty = { paidFen: 0, payers: 0, introEligible: 0, introRenewed: 0 };
      try {
        return await db.transaction(async tx => {
          const receipts = (await tx.select(commerce.receipt).from(mysqlMembershipOrder).where(commerce.period(mysqlMembershipOrder.paidAt, period)).limit(1))[0];
          const renewal = (await tx.select(commerce.renewalCount).from(mysqlMembershipOrder).where(commerce.introEligibility(period, Date.now())).limit(1))[0];
          const entries = await tx.select({ kind: mysqlCommerceEntry.kind,
            value: sql<number>`sum(${mysqlCommerceEntry.value})`.mapWith(Number), quantity: sql<number>`sum(${mysqlCommerceEntry.quantity})`.mapWith(Number),
          }).from(mysqlCommerceEntry).innerJoin(mysqlMembershipOrder, eq(mysqlMembershipOrder.id, mysqlCommerceEntry.orderId))
            .where(and(gte(mysqlCommerceEntry.createdAt, period.from), lt(mysqlCommerceEntry.createdAt, period.to),
              period.userId ? eq(mysqlMembershipOrder.userId, period.userId) : undefined)).groupBy(mysqlCommerceEntry.kind);
          return { ...empty, ...receipts, ...renewal, entries };
        }, { isolationLevel: "repeatable read", accessMode: "read only" });
      } catch (error) {
        if (errorCode(error) === "ER_NO_SUCH_TABLE") return { ...empty, entries: [] };
        throw error;
      }
    },
    async readModelUsage(filters) {
      const where = usage.where(filters);
      try {
        return await db.transaction(async tx => {
          const groups = await tx.select(usage.totals).from(mysqlBillingLedger).where(where).groupBy(...usage.group);
          const [users] = await tx.select(usage.activeUsers).from(mysqlBillingLedger).where(where);
          const days = await tx.select(usage.daily).from(mysqlBillingLedger).where(where).groupBy(usage.day).orderBy(usage.day);
          const [alertRows] = await tx.execute(usage.alerts(filters));
          if (!Array.isArray(alertRows)) throw new Error("异常用量查询未返回记录");
          return { groups, activeUsers: users?.count ?? 0, days, alerts: mapModelUsageAlerts(alertRows as ModelUsageAlertRow[]) };
        }, { isolationLevel: "repeatable read", accessMode: "read only" });
      } catch (error) {
        if (errorCode(error) === "ER_NO_SUCH_TABLE") return { groups: [], activeUsers: 0, days: [], alerts: [] };
        throw error;
      }
    },
    async listModelUsage(filters) {
      try {
        const rows = await db.select({ record: getTableColumns(mysqlBillingLedger), userName: mysqlUser.userName }).from(mysqlBillingLedger)
          .leftJoin(mysqlUser, eq(mysqlUser.id, mysqlBillingLedger.userId)).where(usage.where(filters, filters.before))
          .orderBy(desc(mysqlBillingLedger.createdAt), desc(mysqlBillingLedger.requestId)).limit(filters.limit + 1);
        return rows.map(({ record, userName }) => ({ ...record, userName }));
      } catch (error) {
        if (errorCode(error) === "ER_NO_SUCH_TABLE") return [];
        throw error;
      }
    },
    async getWallets(userId) {
      try {
        const wallets = await db.select().from(mysqlWallet).where(eq(mysqlWallet.userId, userId)).orderBy(asc(mysqlWallet.currency));
        return wallets.map(requireWallet);
      }
      catch (error) {
        if (errorCode(error) === "ER_NO_SUCH_TABLE") return [];
        throw error;
      }
    },
    async getBillingRecord(requestId) {
      try { return (await db.select().from(mysqlBillingLedger).where(eq(mysqlBillingLedger.requestId, requestId)).limit(1))[0]; }
      catch (error) {
        if (errorCode(error) === "ER_NO_SUCH_TABLE") return;
        throw error;
      }
    },
    async listBillingRecords(userId, limit) {
      try {
        return await db.select().from(mysqlBillingLedger).where(eq(mysqlBillingLedger.userId, userId))
          .orderBy(desc(mysqlBillingLedger.createdAt), desc(mysqlBillingLedger.requestId)).limit(limit);
      } catch (error) {
        if (errorCode(error) === "ER_NO_SUCH_TABLE") return [];
        throw error;
      }
    },
    async creditWallet(record) {
      validateWalletAmount(record.amountMicros);
      await requireBillingEngine();
      return db.transaction(async tx => {
        try {
          await tx.insert(mysqlBillingLedger).values({ ...record, kind: "credit", status: "settled", reservedMicros: 0,
            usage: null, updatedAt: record.createdAt });
        } catch (error) {
          if (errorCode(error) === "ER_DUP_ENTRY") return "duplicate" as const;
          throw error;
        }
        // 所有资金事务先锁请求流水，再锁钱包；不能反向持锁等待其他流水。
        await tx.insert(mysqlWallet).values({ userId: record.userId, currency: record.currency, balanceMicros: 0, reservedMicros: 0 })
          .onDuplicateKeyUpdate({ set: { userId: record.userId } });
        const [found] = await tx.select().from(mysqlWallet)
          .where(and(eq(mysqlWallet.userId, record.userId), eq(mysqlWallet.currency, record.currency))).limit(1).for("update");
        const wallet = requireWallet(found);
        if (wallet.balanceMicros > maxWalletMicros - record.amountMicros) walletBalanceOverflow();
        if (record.amountMicros > 0) {
          const [result] = await tx.update(mysqlWallet).set({ balanceMicros: sql`${mysqlWallet.balanceMicros} + ${record.amountMicros}` })
            .where(and(eq(mysqlWallet.userId, record.userId), eq(mysqlWallet.currency, record.currency),
              sql`${mysqlWallet.balanceMicros} <= ${maxWalletMicros - record.amountMicros}`));
          if (result.affectedRows !== 1) walletStateConflict();
        }
        return "created" as const;
      });
    },
    async reserveWallet(record) {
      validateWalletAmount(record.reservedMicros);
      await requireBillingEngine();
      try {
        return await db.transaction(async tx => {
          try {
            await tx.insert(mysqlBillingLedger).values({ ...record, kind: "model", status: "reserved", amountMicros: 0,
              usage: null, updatedAt: record.createdAt });
          } catch (error) {
            if (errorCode(error) === "ER_DUP_ENTRY") return "duplicate" as const;
            throw error;
          }
          await tx.insert(mysqlWallet).values({ userId: record.userId, currency: record.currency, balanceMicros: 0, reservedMicros: 0 })
            .onDuplicateKeyUpdate({ set: { userId: record.userId } });
          const [found] = await tx.select().from(mysqlWallet)
            .where(and(eq(mysqlWallet.userId, record.userId), eq(mysqlWallet.currency, record.currency))).limit(1).for("update");
          const wallet = requireWallet(found);
          // 抛出仅用于事务回滚；余额不足时，新流水与零钱包都不提交。
          if (wallet.balanceMicros - wallet.reservedMicros < record.reservedMicros) throw insufficientWallet;
          if (record.reservedMicros > 0) {
            const [result] = await tx.update(mysqlWallet).set({ reservedMicros: sql`${mysqlWallet.reservedMicros} + ${record.reservedMicros}` })
              .where(and(eq(mysqlWallet.userId, record.userId), eq(mysqlWallet.currency, record.currency),
                sql`${mysqlWallet.balanceMicros} - ${mysqlWallet.reservedMicros} >= ${record.reservedMicros}`));
            if (result.affectedRows !== 1) walletStateConflict();
          }
          return "created" as const;
        });
      } catch (error) {
        if (error === insufficientWallet) return "insufficient";
        throw error;
      }
    },
    async settleWallet(requestId, userId, amountMicros, usage, at) {
      validateWalletAmount(amountMicros);
      await requireBillingEngine();
      return db.transaction(async tx => {
        const [record] = await tx.select().from(mysqlBillingLedger).where(eq(mysqlBillingLedger.requestId, requestId)).limit(1).for("update");
        if (!record || record.userId !== userId || record.kind !== "model" || record.status !== "reserved") return false;
        if (!Number.isSafeInteger(record.reservedMicros) || record.reservedMicros < 0 || record.reservedMicros > maxWalletMicros
          || record.amountMicros !== 0) walletStateConflict();
        if (amountMicros > record.reservedMicros) walletSettlementExceeded();
        const [found] = await tx.select().from(mysqlWallet)
          .where(and(eq(mysqlWallet.userId, userId), eq(mysqlWallet.currency, record.currency))).limit(1).for("update");
        const wallet = requireWallet(found);
        if (wallet.reservedMicros < record.reservedMicros || wallet.balanceMicros < amountMicros) walletStateConflict();
        if (record.reservedMicros > 0 || amountMicros > 0) {
          const [result] = await tx.update(mysqlWallet).set({ balanceMicros: sql`${mysqlWallet.balanceMicros} - ${amountMicros}`,
            reservedMicros: sql`${mysqlWallet.reservedMicros} - ${record.reservedMicros}` })
            .where(and(eq(mysqlWallet.userId, userId), eq(mysqlWallet.currency, record.currency),
              sql`${mysqlWallet.balanceMicros} >= ${amountMicros}`, sql`${mysqlWallet.reservedMicros} >= ${record.reservedMicros}`));
          if (result.affectedRows !== 1) walletStateConflict();
        }
        const [result] = await tx.update(mysqlBillingLedger).set({ status: "settled", amountMicros, usage, updatedAt: at })
          .where(and(eq(mysqlBillingLedger.requestId, requestId), eq(mysqlBillingLedger.userId, userId), eq(mysqlBillingLedger.status, "reserved")));
        if (result.affectedRows !== 1) walletStateConflict();
        return true;
      });
    },
    async releaseWallet(requestId, userId, at, usage) {
      await requireBillingEngine();
      return db.transaction(async tx => {
        const [record] = await tx.select().from(mysqlBillingLedger).where(eq(mysqlBillingLedger.requestId, requestId)).limit(1).for("update");
        if (!record || record.userId !== userId || record.kind !== "model" || record.status !== "reserved") return false;
        if (!Number.isSafeInteger(record.reservedMicros) || record.reservedMicros < 0 || record.reservedMicros > maxWalletMicros
          || record.amountMicros !== 0) walletStateConflict();
        const [found] = await tx.select().from(mysqlWallet)
          .where(and(eq(mysqlWallet.userId, userId), eq(mysqlWallet.currency, record.currency))).limit(1).for("update");
        const wallet = requireWallet(found);
        if (wallet.reservedMicros < record.reservedMicros) walletStateConflict();
        if (record.reservedMicros > 0) {
          const [result] = await tx.update(mysqlWallet).set({ reservedMicros: sql`${mysqlWallet.reservedMicros} - ${record.reservedMicros}` })
            .where(and(eq(mysqlWallet.userId, userId), eq(mysqlWallet.currency, record.currency),
              sql`${mysqlWallet.reservedMicros} >= ${record.reservedMicros}`));
          if (result.affectedRows !== 1) walletStateConflict();
        }
        const [result] = await tx.update(mysqlBillingLedger).set({ status: "released", amountMicros: 0, usage: usage ?? record.usage, updatedAt: at })
          .where(and(eq(mysqlBillingLedger.requestId, requestId), eq(mysqlBillingLedger.userId, userId), eq(mysqlBillingLedger.status, "reserved")));
        if (result.affectedRows !== 1) walletStateConflict();
        return true;
      });
    },
    async initializeSettings() {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS multiTenantSettings (
        id INT PRIMARY KEY,
        registrationEnabled BOOLEAN NOT NULL DEFAULT TRUE
      )`);
      await db.insert(mysqlSettings).values({ id: 1, registrationEnabled: true }).onDuplicateKeyUpdate({ set: { id: 1 } });
    },
    async getRegistrationEnabled() {
      try {
        const [settings] = await db.select({ enabled: mysqlSettings.registrationEnabled }).from(mysqlSettings).where(eq(mysqlSettings.id, 1)).limit(1);
        return settings?.enabled ?? true;
      } catch (error) {
        const failure = error as { code?: string; cause?: { code?: string } };
        if ((failure.cause?.code ?? failure.code) === "ER_NO_SUCH_TABLE") return true;
        throw error;
      }
    },
    async setRegistrationEnabled(enabled) {
      await db.insert(mysqlSettings).values({ id: 1, registrationEnabled: enabled }).onDuplicateKeyUpdate({ set: { registrationEnabled: enabled } });
    },
    async getSourceMapping() {
      try {
        const [mapping] = await db.select({ mappings: mysqlSourceMapping.mappings, revision: mysqlSourceMapping.revision })
          .from(mysqlSourceMapping).where(eq(mysqlSourceMapping.id, 1)).limit(1);
        return mapping;
      } catch (error) {
        const failure = error as { code?: string; cause?: { code?: string } };
        if ((failure.cause?.code ?? failure.code) === "ER_NO_SUCH_TABLE") return;
        throw error;
      }
    },
    async initializeSourceMapping() {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS multiTenantSourceMapping (
        id INT PRIMARY KEY,
        mappings JSON NOT NULL,
        revision INT NOT NULL
      )`);
    },
    async writeSourceMapping(mappings, expectedRevision) {
      if (expectedRevision === 0) {
        try {
          await db.insert(mysqlSourceMapping).values({ id: 1, mappings, revision: 1 });
          return true;
        } catch (error) {
          const failure = error as { code?: string; cause?: { code?: string } };
          if ((failure.cause?.code ?? failure.code) === "ER_DUP_ENTRY") return false;
          throw error;
        }
      }
      const [result] = await db.update(mysqlSourceMapping).set({ mappings, revision: expectedRevision + 1 })
        .where(and(eq(mysqlSourceMapping.id, 1), eq(mysqlSourceMapping.revision, expectedRevision)));
      return result.affectedRows === 1;
    },
    async getModelRouting() {
      try {
        const [routing] = await db.select({ configuration: mysqlModelRouting.configuration, revision: mysqlModelRouting.revision })
          .from(mysqlModelRouting).where(eq(mysqlModelRouting.id, 1)).limit(1);
        return routing;
      } catch (error) {
        const failure = error as { code?: string; cause?: { code?: string } };
        if ((failure.cause?.code ?? failure.code) === "ER_NO_SUCH_TABLE") return;
        throw error;
      }
    },
    async initializeModelRouting() {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS multiTenantModelRouting (
        id INT PRIMARY KEY,
        configuration JSON NOT NULL,
        revision INT NOT NULL
      )`);
    },
    async writeModelRouting(configuration, expectedRevision) {
      if (expectedRevision === 0) {
        try {
          await db.insert(mysqlModelRouting).values({ id: 1, configuration, revision: 1 });
          return true;
        } catch (error) {
          const failure = error as { code?: string; cause?: { code?: string } };
          if ((failure.cause?.code ?? failure.code) === "ER_DUP_ENTRY") return false;
          throw error;
        }
      }
      const [result] = await db.update(mysqlModelRouting).set({ configuration, revision: expectedRevision + 1 })
        .where(and(eq(mysqlModelRouting.id, 1), eq(mysqlModelRouting.revision, expectedRevision)));
      return result.affectedRows === 1;
    },
    async initialize() {
      if (initialized) return;
      await db.execute(sql`CREATE TABLE IF NOT EXISTS multiTenantAdmin (
        id INT PRIMARY KEY,
        userName VARCHAR(64) NOT NULL DEFAULT 'admin',
        passwordHash VARCHAR(255) NOT NULL,
        sessionHash VARCHAR(64),
        sessionExpiresAt BIGINT NOT NULL DEFAULT 0,
        failedAttempts INT NOT NULL DEFAULT 0,
        lockedUntil BIGINT NOT NULL DEFAULT 0
      )`);
      if (!(await columns()).some(column => column.columnName === "userName")) {
        try { await db.execute(sql`ALTER TABLE multiTenantAdmin ADD COLUMN userName VARCHAR(64) NOT NULL DEFAULT 'admin'`); }
        catch (error) {
          const failure = error as { code?: string; cause?: { code?: string } };
          if ((failure.cause?.code ?? failure.code) !== "ER_DUP_FIELDNAME") throw error;
          if (!(await columns()).some(column => column.columnName === "userName")) throw error;
        }
      }
      accountColumn = true;
      await db.execute(sql`CREATE TABLE IF NOT EXISTS multiTenantUser (
        id VARCHAR(36) PRIMARY KEY,
        userName VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
        userNameKey VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL UNIQUE,
        passwordHash VARCHAR(255) NOT NULL,
        failedAttempts INT NOT NULL DEFAULT 0,
        lockedUntil BIGINT NOT NULL DEFAULT 0,
        settings JSON,
        settingsRevision INT NOT NULL DEFAULT 0,
        disabled BOOLEAN NOT NULL DEFAULT FALSE,
        authVersion INT NOT NULL DEFAULT 0,
        createdAt BIGINT NOT NULL DEFAULT 0,
        lastLoginAt BIGINT NOT NULL DEFAULT 0
      )`);
      const userColumns = await columns("multiTenantUser");
      for (const [name, migration] of [
        ["settings", sql`ALTER TABLE multiTenantUser ADD COLUMN settings JSON`],
        ["settingsRevision", sql`ALTER TABLE multiTenantUser ADD COLUMN settingsRevision INT NOT NULL DEFAULT 0`],
        ["disabled", sql`ALTER TABLE multiTenantUser ADD COLUMN disabled BOOLEAN NOT NULL DEFAULT FALSE`],
        ["authVersion", sql`ALTER TABLE multiTenantUser ADD COLUMN authVersion INT NOT NULL DEFAULT 0`],
        ["createdAt", sql`ALTER TABLE multiTenantUser ADD COLUMN createdAt BIGINT NOT NULL DEFAULT 0`],
        ["lastLoginAt", sql`ALTER TABLE multiTenantUser ADD COLUMN lastLoginAt BIGINT NOT NULL DEFAULT 0`],
      ] as const) {
        if (userColumns.some(column => column.columnName === name)) continue;
        try { await db.execute(migration); }
        catch (error) {
          const failure = error as { code?: string; cause?: { code?: string } };
          if ((failure.cause?.code ?? failure.code) !== "ER_DUP_FIELDNAME"
            || !(await columns("multiTenantUser")).some(column => column.columnName === name)) throw error;
        }
      }
      await db.execute(sql`CREATE TABLE IF NOT EXISTS multiTenantWebSession (
        tokenHash VARCHAR(64) PRIMARY KEY,
        userId VARCHAR(36) NOT NULL,
        role ENUM('admin', 'user') NOT NULL,
        expiresAt BIGINT NOT NULL,
        authVersion INT NOT NULL DEFAULT 0
      )`);
      if (!(await columns("multiTenantWebSession")).some(column => column.columnName === "authVersion")) {
        try { await db.execute(sql`ALTER TABLE multiTenantWebSession ADD COLUMN authVersion INT NOT NULL DEFAULT 0`); }
        catch (error) {
          const failure = error as { code?: string; cause?: { code?: string } };
          if ((failure.cause?.code ?? failure.code) !== "ER_DUP_FIELDNAME"
            || !(await columns("multiTenantWebSession")).some(column => column.columnName === "authVersion")) throw error;
        }
      }
      initialized = true;
    },
    async getAdmin() {
      if (accountColumn === undefined) {
        const current = await columns();
        if (!current.length) return;
        accountColumn = current.some(column => column.columnName === "userName");
      }
      return (await db.select({ ...getTableColumns(mysqlAdmin), userName: accountColumn ? mysqlAdmin.userName : sql<string>`${"admin"}` })
        .from(mysqlAdmin).where(eq(mysqlAdmin.id, 1)).limit(1))[0];
    },
    async createAdmin(userName, passwordHash) {
      await db.insert(mysqlAdmin).values({ id: 1, userName, passwordHash });
    },
    async updateAdmin(values) {
      await db.update(mysqlAdmin).set(values).where(eq(mysqlAdmin.id, 1));
    },
    async getUser(userNameKey) {
      return (await db.select().from(mysqlUser).where(eq(mysqlUser.userNameKey, userNameKey)).limit(1))[0];
    },
    async getUserById(id) {
      return (await db.select().from(mysqlUser).where(eq(mysqlUser.id, id)).limit(1))[0];
    },
    async createUser(user) {
      await db.insert(mysqlUser).values({ ...user, settings: {}, settingsRevision: 0 });
    },
    async updateUser(id, values, expectedAuthVersion) {
      await db.update(mysqlUser).set(values).where(and(eq(mysqlUser.id, id),
        expectedAuthVersion === undefined ? undefined : eq(mysqlUser.authVersion, expectedAuthVersion)));
    },
    async completeUserLogin(id, expectedAuthVersion, at) {
      const [result] = await db.update(mysqlUser).set({ failedAttempts: 0, lockedUntil: 0, lastLoginAt: at })
        .where(and(eq(mysqlUser.id, id), eq(mysqlUser.disabled, false), eq(mysqlUser.authVersion, expectedAuthVersion)));
      return result.affectedRows === 1;
    },
    async listUsers(options) {
      const pattern = `%${options.search.replace(/[!%_]/g, "!$&")}%`;
      const condition = and(options.search ? sql`${mysqlUser.userNameKey} LIKE ${pattern} ESCAPE '!'` : undefined,
        options.status === "all" ? undefined : eq(mysqlUser.disabled, options.status === "disabled"));
      const [total] = await db.select({ value: count() }).from(mysqlUser).where(condition);
      const items = await db.select({ id: mysqlUser.id, userName: mysqlUser.userName, disabled: mysqlUser.disabled,
        createdAt: mysqlUser.createdAt, lastLoginAt: mysqlUser.lastLoginAt }).from(mysqlUser).where(condition)
        .orderBy(desc(mysqlUser.createdAt), asc(mysqlUser.userNameKey)).limit(options.pageSize).offset((options.page - 1) * options.pageSize);
      return { items, total: total!.value };
    },
    async setUserDisabled(id, disabled) {
      const [result] = await db.update(mysqlUser).set({ disabled, authVersion: sql`${mysqlUser.authVersion} + 1` }).where(eq(mysqlUser.id, id));
      return result.affectedRows === 1;
    },
    async resetUserPassword(id, passwordHash) {
      const [result] = await db.update(mysqlUser).set({ passwordHash, failedAttempts: 0, lockedUntil: 0, authVersion: sql`${mysqlUser.authVersion} + 1` })
        .where(eq(mysqlUser.id, id));
      return result.affectedRows === 1;
    },
    async createWebSession(session) {
      await db.insert(mysqlWebSession).values(session);
    },
    async getWebSession(tokenHash) {
      try { return (await db.select().from(mysqlWebSession).where(eq(mysqlWebSession.tokenHash, tokenHash)).limit(1))[0]; }
      catch (error) {
        const failure = error as { code?: string; cause?: { code?: string } };
        if ((failure.cause?.code ?? failure.code) === "ER_NO_SUCH_TABLE") return;
        throw error;
      }
    },
    async expireWebSession(tokenHash) {
      await db.update(mysqlWebSession).set({ expiresAt: 0 }).where(eq(mysqlWebSession.tokenHash, tokenHash));
    },
    async writeUserSettings(userId, settings, expectedRevision) {
      const [result] = await db.update(mysqlUser).set({ settings, settingsRevision: expectedRevision + 1 })
        .where(and(eq(mysqlUser.id, userId), eq(mysqlUser.settingsRevision, expectedRevision)));
      return result.affectedRows === 1;
    },
  };
}
