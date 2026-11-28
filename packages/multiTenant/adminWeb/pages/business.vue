<template>
  <article class="businessPage" :aria-busy="loading">
    <div class="toolbar">
      <div class="tabs">
        <el-button :type="tab === 'usage' ? 'primary' : 'default'" :aria-pressed="tab === 'usage'" @click="tab = 'usage'">{{ translate("用量统计") }}</el-button>
        <el-button :type="tab === 'orders' ? 'primary' : 'default'" :aria-pressed="tab === 'orders'" @click="tab = 'orders'">{{ translate("月卡与成本") }}</el-button>
      </div>
      <form class="filters" @submit.prevent="refresh()">
        <label>{{ translate("时间范围") }} <select v-model.number="rangeDays"><option v-for="days in [7, 30, 90]" :key="days" :value="days">{{ days }} {{ translate("天") }}</option></select></label>
        <label>{{ translate("账号") }}
          <el-select v-model="account" clearable filterable remote :remote-method="findUsers" :loading="userLoading" class="accountSelect" :placeholder="translate('全部账号')" @visible-change="showUsers">
            <el-option v-for="user in users" :key="user.id" :label="user.userName" :value="user.id" />
          </el-select>
        </label>
        <label v-if="tab === 'usage'">{{ translate("模型类型") }} <select v-model="modelType"><option value="">{{ translate("全部") }}</option><option v-for="item in modelTypes" :value="item" :key="item">{{ modelLabel(item) }}</option></select></label>
        <label v-if="tab === 'usage'">{{ translate("来源") }} <select v-model="feature"><option value="">{{ translate("全部") }}</option><option v-for="item in features" :value="item" :key="item">{{ featureLabel(item) }}</option></select></label>
        <label v-if="tab === 'usage'">{{ translate("创作用途") }} <select v-model="purpose"><option value="">{{ translate("全部") }}</option><option v-for="item in purposes" :value="item" :key="item">{{ purposeLabel(item) }}</option></select></label>
        <el-button native-type="submit" :loading="loading">{{ translate("查询") }}</el-button>
      </form>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <template v-if="tab === 'usage' && usage">
      <dl class="metrics">
        <div><dt>{{ translate("有模型请求的账号") }}</dt><dd>{{ usage.activeUsers }}</dd></div>
        <div><dt>{{ translate("请求量") }}</dt><dd>{{ usage.requests.total }}</dd></div>
        <div><dt>{{ translate("已结算") }}</dt><dd>{{ usage.requests.settled }}</dd></div>
        <div><dt>{{ translate("已释放") }}</dt><dd>{{ usage.requests.released }}</dd></div>
        <div><dt>{{ translate("预占中") }}</dt><dd>{{ usage.requests.reserved }}</dd></div>
      </dl>
      <section class="panel">
        <h2>{{ translate("每日用量") }}</h2>
        <div class="tableScroll"><table>
          <thead><tr><th>{{ translate("日期") }}</th><th>{{ translate("使用账号") }}</th><th>{{ translate("请求量") }}</th><th>{{ translate("图片产出") }}</th><th>{{ translate("视频产出") }}</th></tr></thead>
          <tbody><tr v-for="day in usage.days" :key="day.day">
            <td>{{ formatDay(day.day) }}</td><td>{{ day.activeUsers }}</td>
            <td><meter :aria-label="translate('请求量')" :max="dayMax" :value="day.requests" /> {{ day.requests }}</td><td>{{ day.images }}</td><td>{{ day.videos }}</td>
          </tr><tr v-if="!usage.days.length"><td colspan="5">{{ translate("暂无用量") }}</td></tr></tbody>
        </table></div>
      </section>
      <section class="panel">
        <h2>{{ translate("入口与用途") }}</h2>
        <div class="tableScroll"><table>
          <thead><tr><th>{{ translate("来源") }}</th><th>{{ translate("创作用途") }}</th><th>{{ translate("模型类型") }}</th><th>{{ translate("状态") }}</th><th>{{ translate("请求量") }}</th><th>{{ translate("产出数") }}</th><th>{{ translate("视频时长（秒）") }}</th></tr></thead>
          <tbody><tr v-for="group in usage.groups" :key="[group.feature, group.purpose, group.modelType, group.status, group.releaseOutcome].join('/')">
            <td>{{ featureLabel(group.feature) }}</td><td>{{ purposeLabel(group.purpose) }}</td><td>{{ modelLabel(group.modelType) }}</td>
            <td>{{ statusLabel(group.status, group.releaseOutcome) }}</td><td>{{ group.requests }}</td><td>{{ group.outputFiles ?? "—" }}</td><td>{{ formatSeconds(group.videoSeconds) }}</td>
          </tr><tr v-if="!usage.groups.length"><td colspan="7">{{ translate("暂无用量") }}</td></tr></tbody>
        </table></div>
      </section>
      <section class="panel">
        <h2>{{ translate("异常账号") }}</h2>
        <p class="muted">{{ translate("近 7 天达到 20 次且至少翻倍、最近 3 次已结束的请求均明确失败，或预占超过 1 小时。最多显示 50 个账号。") }}</p>
        <div class="tableScroll"><table>
          <thead><tr><th>{{ translate("账号") }}</th><th>{{ translate("近 7 天请求") }}</th><th>{{ translate("前 7 天请求") }}</th><th>{{ translate("连续失败") }}</th><th>{{ translate("超时预占") }}</th></tr></thead>
          <tbody><tr v-for="item in usage.alerts" :key="item.userId">
            <td><el-button link type="primary" @click="focusAccount(item.userId, item.userName)">{{ item.userName || item.userId }}</el-button></td>
            <td>{{ item.recentRequests }}</td><td>{{ item.previousRequests }}</td><td>{{ item.failedLastThree ? translate("是") : "—" }}</td><td>{{ item.staleRequests }}</td>
          </tr><tr v-if="!usage.alerts.length"><td colspan="5">{{ translate("暂无异常账号") }}</td></tr></tbody>
        </table></div>
      </section>
      <section class="panel">
        <h2>{{ translate("请求明细") }}</h2>
        <div class="tableScroll"><table>
          <thead><tr><th>{{ translate("时间") }}</th><th>{{ translate("账号") }}</th><th>{{ translate("模型") }}</th><th>{{ translate("来源") }}</th><th>{{ translate("创作用途") }}</th><th>{{ translate("状态") }}</th><th>{{ translate("产出数") }}</th><th>{{ translate("视频时长（秒）") }}</th><th>{{ translate("实扣") }}</th></tr></thead>
          <tbody><tr v-for="item in records" :key="item.requestId">
            <td>{{ formatTime(item.createdAt) }}</td><td><el-button link type="primary" @click="focusAccount(item.userId, item.userName)">{{ item.userName || item.userId }}</el-button></td>
            <td>{{ item.model }}</td><td>{{ featureLabel(item.feature) }}</td><td>{{ purposeLabel(item.purpose) }}</td><td>{{ statusLabel(item.status, item.releaseOutcome) }}</td>
            <td>{{ item.outputFiles ?? "—" }}</td><td>{{ formatSeconds(item.videoSeconds) }}</td><td>{{ item.coveredOrderId ? translate("月卡包含") : item.chargedAmount === null ? "—" : item.chargedAmount + " " + item.currency }}</td>
          </tr><tr v-if="!records.length"><td colspan="9">{{ translate("暂无请求记录") }}</td></tr></tbody>
        </table></div>
        <el-button v-if="usageCursor" :loading="loading" @click="more()">{{ translate("加载更多") }}</el-button>
      </section>
    </template>
    <template v-if="tab === 'orders'">
      <dl v-if="business" class="metrics">
        <div><dt>{{ translate("实收") }}</dt><dd>{{ yuan(business.totals.paidFen) }}</dd></div>
        <div><dt>{{ translate("付费账号") }}</dt><dd>{{ business.totals.payers }}</dd></div>
        <div><dt>{{ translate("已退款") }}</dt><dd>{{ yuan(business.totals.refundedFen) }}</dd></div>
        <div><dt>{{ translate("模型采购") }}</dt><dd>{{ yuan(business.totals.modelFen) }}</dd><small>{{ business.totals.modelPacks }} {{ translate("份") }}</small></div>
        <div><dt>{{ translate("手续费") }}</dt><dd>{{ yuan(business.totals.feeFen) }}</dd></div>
        <div><dt>{{ translate("已记录经营结余") }}</dt><dd>{{ yuan(business.totals.contributionFen) }}</dd></div>
        <div><dt>{{ translate("售后分钟") }}</dt><dd>{{ business.totals.supportMinutes }}</dd></div>
        <div><dt>{{ translate("到期首月订单中按 199 元续费") }}</dt><dd>{{ business.totals.introEligible ? business.totals.introRenewed + " / " + business.totals.introEligible : "—" }}</dd></div>
      </dl>
      <section class="panel">
        <div class="sectionHeader"><h2>{{ translate("月卡订单") }}</h2><el-button type="primary" @click="openMembership()">{{ translate("登记已收款月卡") }}</el-button></div>
        <p class="muted">{{ translate("每期 30 天。结余按已登记的收款、退款、模型采购和手续费计算。") }}</p>
        <div class="tableScroll"><table>
          <thead><tr><th>{{ translate("账号") }}</th><th>{{ translate("客户类型") }}</th><th>{{ translate("金额") }}</th><th>{{ translate("状态") }}</th><th>{{ translate("到期时间") }}</th><th>{{ translate("付费到首次出图") }}</th><th>{{ translate("付费到首次出视频") }}</th><th>{{ translate("模型套餐份数") }}</th><th>{{ translate("199 元续费") }}</th><th>{{ translate("操作") }}</th></tr></thead>
          <tbody><tr v-for="order in orders" :key="order.id">
            <td>{{ order.userName || order.userId }}<small class="receipt">{{ order.paymentRef }}</small></td><td>{{ segmentLabel(order.segment) }}</td>
            <td>{{ yuan(order.paidFen) }}</td><td>{{ orderStatus(order) }}</td><td>{{ formatTime(order.endsAt) }}</td>
            <td>{{ order.firstImageAt === null ? "—" : formatLag(order.firstImageAt - order.paidAt) }}</td>
            <td>{{ order.firstVideoAt === null ? "—" : formatLag(order.firstVideoAt - order.paidAt) }}</td><td>{{ order.modelPacks }}</td>
            <td>{{ order.rate === "intro" ? order.renewed ? translate("已续费") : "—" : "—" }}</td>
            <td><el-button link type="primary" @click="openMembership(order)">{{ translate("续期") }}</el-button><el-button link @click="openEntries(order)">{{ translate("成本与退款") }}</el-button></td>
          </tr><tr v-if="!orders.length"><td colspan="10">{{ translate("暂无月卡订单") }}</td></tr></tbody>
        </table></div>
        <el-button v-if="business?.nextCursor" :loading="loading" @click="more()">{{ translate("加载更多") }}</el-button>
      </section>
    </template>

    <el-dialog v-model="membershipOpen" :title="translate('登记已收款月卡')" width="min(540px, 94vw)" :close-on-click-modal="false" :before-close="guardDialog">
      <form class="dialogForm" @submit.prevent="saveOrder">
        <fieldset :disabled="mutating || Boolean(pendingOrder)">
          <label>{{ translate("账号") }}<el-select v-model="orderForm.userId" filterable remote :remote-method="findUsers" :loading="userLoading" @visible-change="showUsers"><el-option v-for="user in users" :key="user.id" :label="user.userName" :value="user.id" /></el-select></label>
          <label>{{ translate("付款流水号") }}<input v-model.trim="orderForm.paymentRef" required maxlength="80" placeholder="Alipay-…" /></label>
          <label>{{ translate("月卡价格") }}<select v-model="orderForm.rate" @change="orderForm.amount = orderForm.rate === 'intro' ? '169' : '199'"><option value="intro">{{ translate("首月 169 元") }}</option><option value="standard">{{ translate("正常价 199 元") }}</option></select></label>
          <label>{{ translate("实收金额（元）") }}<input v-model.trim="orderForm.amount" required inputmode="decimal" :readonly="orderForm.rate === 'intro'" /></label>
          <label>{{ translate("收款时间（北京时间，可选）") }}<input v-model="orderForm.paidAt" type="datetime-local" /></label>
          <label>{{ translate("客户类型") }}<select v-model="orderForm.segment"><option v-for="item in segments" :key="item" :value="item">{{ segmentLabel(item) }}</option></select></label>
          <label>{{ translate("图片模型") }}<select v-model="orderForm.imageRouteId" required><option value="" disabled>{{ translate("请选择") }}</option><option v-for="model in imageRoutes" :key="model.id" :value="model.id">{{ model.label }}</option></select></label>
          <label>{{ translate("视频模型") }}<select v-model="orderForm.videoRouteId" required><option value="" disabled>{{ translate("请选择") }}</option><option v-for="model in videoRoutes" :key="model.id" :value="model.id">{{ model.label }}</option></select></label>
        </fieldset>
        <el-alert v-if="mutationError" :title="mutationError" type="error" :closable="false" />
        <div class="dialogActions"><el-button :disabled="mutating" @click="membershipOpen = false">{{ translate("关闭") }}</el-button><el-button type="primary" native-type="submit" :loading="mutating">{{ pendingOrder ? translate("重试保存") : translate("确认收款并开通") }}</el-button></div>
      </form>
    </el-dialog>

    <el-dialog v-model="entryOpen" :title="translate('成本与退款')" width="min(740px, 94vw)" :close-on-click-modal="false" :before-close="guardDialog">
      <div v-if="selectedOrder" class="dialogForm">
        <p>{{ selectedOrder.userName || selectedOrder.userId }} · {{ selectedOrder.paymentRef }} · {{ yuan(selectedOrder.paidFen) }}</p>
        <form class="dialogForm" @submit.prevent="saveEntry">
          <fieldset :disabled="mutating || Boolean(pendingEntry)">
            <label>{{ translate("类型") }}<select v-model="entryForm.kind" @change="entryForm.amount = entryForm.kind === 'model' ? String(entryForm.quantity * 70) : ''"><option v-for="item in entryKinds" :key="item" :value="item">{{ entryLabel(item) }}</option></select></label>
            <label v-if="entryForm.kind === 'model'">{{ translate("模型套餐份数") }}<input v-model.number="entryForm.quantity" type="number" min="1" max="1000" required @input="entryForm.amount = String(entryForm.quantity * 70)" /></label>
            <label>{{ entryForm.kind === "support" ? translate("分钟") : translate("金额（元）") }}<input v-model.trim="entryForm.amount" required inputmode="decimal" /></label>
            <label>{{ translate("备注") }}<input v-model.trim="entryForm.note" required maxlength="256" /></label>
          </fieldset>
          <p v-if="entryForm.kind === 'refund'" class="muted">{{ translate("仅登记已发生的退款。全额退款后，该期月卡停止覆盖新请求。") }}</p>
          <el-alert v-if="mutationError" :title="mutationError" type="error" :closable="false" />
          <div class="dialogActions"><el-button native-type="submit" type="primary" :loading="mutating">{{ pendingEntry ? translate("重试保存") : translate("保存记录") }}</el-button></div>
        </form>
        <div class="tableScroll"><table>
          <thead><tr><th>{{ translate("时间") }}</th><th>{{ translate("类型") }}</th><th>{{ translate("金额／分钟") }}</th><th>{{ translate("备注") }}</th></tr></thead>
          <tbody><tr v-for="entry in entries" :key="entry.id"><td>{{ formatTime(entry.createdAt) }}</td><td>{{ entryLabel(entry.kind) }}</td><td>{{ entry.kind === "support" ? entry.value : yuan(entry.value) }}</td><td>{{ entry.note }}</td></tr>
            <tr v-if="!entries.length"><td colspan="4">{{ translate("暂无成本或退款记录") }}</td></tr>
          </tbody>
        </table></div>
      </div>
    </el-dialog>
  </article>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElAlert, ElButton, ElDialog, ElOption, ElSelect } from "element-plus";
import { locale, translate } from "@toonflow/i18n/vue";
import type { AdminRequest } from "../types";
import "element-plus/es/components/alert/style/css";
import "element-plus/es/components/button/style/css";
import "element-plus/es/components/dialog/style/css";
import "element-plus/es/components/option/style/css";
import "element-plus/es/components/select/style/css";

type Account = { id: string; userName: string };
type UsageGroup = { feature: string; purpose: string; modelType: string; status: string; releaseOutcome: string | null; requests: number; outputFiles: number | null; videoSeconds: number | null };
type Usage = {
  from: number; to: number; activeUsers: number; requests: { total: number; settled: number; released: number; reserved: number };
  groups: UsageGroup[]; days: { day: number; requests: number; activeUsers: number; images: number; videos: number }[];
  alerts: { userId: string; userName: string | null; recentRequests: number; previousRequests: number; failedLastThree: boolean; staleRequests: number }[];
};
type UsageRow = Omit<UsageGroup, "requests"> & { requestId: string; userId: string; userName: string | null; model: string; createdAt: number; coveredOrderId: string | null; chargedAmount: string | null; currency: string };
type UsageCursor = { createdAt: number; requestId: string };
type RecordPage = { items: UsageRow[]; nextCursor: UsageCursor | null };
type Order = { id: string; userId: string; userName: string | null; paymentRef: string; segment: string; rate: string;
  paidFen: number; refundedFen: number; startsAt: number; endsAt: number; paidAt: number; firstImageAt: number | null; firstVideoAt: number | null;
  renewed: boolean; modelPacks: number;
  imageRouteId: string | null; videoRouteId: string | null };
type Entry = { id: string; kind: string; value: number; note: string; createdAt: number };
type Business = { from: number; to: number; orders: Order[]; adjustments: Entry[]; nextCursor: { paidAt: number; id: string } | null;
  totals: { paidFen: number; refundedFen: number; modelFen: number; feeFen: number; contributionFen: number; payers: number;
    introEligible: number; introRenewed: number; supportMinutes: number; modelPacks: number } };
type RouteOption = { id: string; label: string; type: string; enabled: boolean };
type EntryKind = "model" | "refund" | "fee" | "support";

const props = defineProps<{ request: AdminRequest }>();
const emit = defineEmits<{ sessionExpired: [] }>();
const dayMs = 86400000;
const tab = ref<"usage" | "orders">("usage");
const rangeDays = ref(30);
const account = ref("");
const modelType = ref("");
const feature = ref("");
const purpose = ref("");
const users = ref<Account[]>([]);
const userLoading = ref(false);
const usage = ref<Usage>();
const records = ref<UsageRow[]>([]);
const usageCursor = ref<UsageCursor | null>(null);
const business = ref<Business>();
const orders = ref<Order[]>([]);
const lastFilters = ref<Record<string, string | number>>({});
const loading = ref(false);
const error = ref("");
const mutating = ref(false);
const mutationError = ref("");
const membershipOpen = ref(false);
const entryOpen = ref(false);
const selectedOrder = ref<Order>();
const entries = ref<Entry[]>([]);
const routeOptions = ref<RouteOption[]>([]);
const imageRoutes = computed(() => routeOptions.value.filter(item => item.type === "image"));
const videoRoutes = computed(() => routeOptions.value.filter(item => item.type === "video"));
const dayMax = computed(() => Math.max(1, ...usage.value?.days.map(day => day.requests) ?? []));
const orderForm = reactive({ userId: "", paymentRef: "", rate: "intro", segment: "unknown", amount: "169", paidAt: "", imageRouteId: "", videoRouteId: "" });
const entryForm = reactive({ kind: "model" as EntryKind, quantity: 1, amount: "70", note: "" });
const pendingOrder = ref<Record<string, unknown>>();
const pendingEntry = ref<Record<string, unknown>>();
const modelTypes = ["image", "video", "audio", "text"];
const features = ["quickCreation", "canvas", "agent", "mediaApi", "textApi", "unknown"];
const purposes = ["productImage", "sceneImage", "productVideo", "inspiration", "custom", "unknown"];
const segments = ["merchant", "creator", "unknown"];
const entryKinds: EntryKind[] = ["model", "refund", "fee", "support"];
const controller = new AbortController();
let userSearch: AbortController | undefined;
let pageRequest: AbortController | undefined;
let entryRequest: AbortController | undefined;

function modelLabel(value: string) { return ({ image: translate("图片"), video: translate("视频"), audio: translate("音频"), text: translate("文本") })[value] ?? translate("未知"); }
function featureLabel(value: string) {
  return ({ quickCreation: translate("快捷创作"), canvas: translate("画布"), agent: "Agent", mediaApi: translate("媒体 API"), textApi: translate("文本 API") })[value] ?? translate("未知");
}
function purposeLabel(value: string) {
  return ({ productImage: translate("商品主图"), sceneImage: translate("商品场景图"), productVideo: translate("商品短视频"), inspiration: translate("灵感模板"), custom: translate("自定义") })[value] ?? translate("未知");
}
function statusLabel(value: string, outcome: string | null) {
  const releases: Record<string, string> = { failed: translate("失败"), rejected: translate("上游拒绝"), notSubmitted: translate("未提交"), cancelled: translate("已取消"), manual: translate("手动释放") };
  return value === "settled" ? translate("已结算") : value === "reserved" ? translate("预占中") : releases[outcome ?? ""] ?? translate("已释放");
}
function segmentLabel(value: string) { return value === "merchant" ? translate("电商商家") : value === "creator" ? translate("个人创作者") : translate("未知"); }
function entryLabel(value: string) { return ({ model: translate("模型采购"), refund: translate("退款"), fee: translate("手续费"), support: translate("售后时间") })[value] ?? value; }
function orderStatus(order: Order) {
  if (order.refundedFen >= order.paidFen) return translate("全额退款");
  if (order.endsAt <= Date.now()) return translate("已到期");
  return order.startsAt > Date.now() ? translate("待生效") : translate("生效中");
}
const dateFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }));
const dayFormat = computed(() => new Intl.DateTimeFormat(locale.value, { month: "short", day: "numeric", timeZone: "UTC" }));
const currency = computed(() => new Intl.NumberFormat(locale.value, { style: "currency", currency: "CNY" }));
function formatTime(value: number) { return dateFormat.value.format(value); }
function formatDay(value: number) { return dayFormat.value.format(value * dayMs); }
function formatLag(value: number) { return new Intl.NumberFormat(locale.value, { style: "unit", unit: "hour", maximumFractionDigits: 1 }).format(Math.max(0, value / 3600000)); }
function formatSeconds(value: number | null) { return value === null ? "—" : value.toFixed(1); }
function yuan(value: number) { return currency.value.format(value / 100); }
function fen(value: string) { return /^\d{1,6}(?:\.\d{1,2})?$/.test(value) ? Math.round(Number(value) * 100) : 0; }
function message(cause: unknown) {
  if ((cause as { status?: number })?.status === 401) emit("sessionExpired");
  return cause instanceof Error ? cause.message : translate("请求失败");
}
function guardDialog(done: () => void) { if (!mutating.value) done(); }

async function findUsers(search = "") {
  userSearch?.abort();
  const request = userSearch = new AbortController();
  userLoading.value = true;
  try {
    const { items } = await props.request<{ items: Account[] }>({ url: "/api/multiTenant/users/list", method: "GET", params: { search, pageSize: 50 }, signal: request.signal });
    if (request.signal.aborted) return;
    const retain = users.value.filter(item => [account.value, orderForm.userId].includes(item.id));
    users.value = [...new Map([...retain, ...items].map(item => [item.id, item])).values()];
  } catch (cause) { if (!request.signal.aborted) error.value = message(cause); }
  finally { if (userSearch === request) userLoading.value = false; }
}
function showUsers(visible: boolean) { if (visible) void findUsers(); }
function rememberAccount(id: string, name: string | null) {
  if (!users.value.some(item => item.id === id)) users.value.push({ id, userName: name || id });
}
function focusAccount(id: string, name: string | null) { rememberAccount(id, name); account.value = id; void refresh(); }

async function refresh(append = false) {
  pageRequest?.abort();
  const request = pageRequest = new AbortController();
  const view = tab.value;
  loading.value = true;
  error.value = "";
  const to = Date.now() + 1;
  const filters = append ? lastFilters.value : { from: to - rangeDays.value * dayMs, to,
    ...(account.value ? { userId: account.value } : {}),
    ...(view === "usage" ? { ...(modelType.value ? { modelType: modelType.value } : {}),
      ...(feature.value ? { feature: feature.value } : {}), ...(purpose.value ? { purpose: purpose.value } : {}) } : {}) };
  try {
    if (view === "usage") {
      const cursor = append ? usageCursor.value : null;
      const [overview, list] = await Promise.all([
        append ? undefined : props.request<Usage>({ url: "/api/multiTenant/billing/usage", method: "GET", params: filters, signal: request.signal }),
        props.request<RecordPage>({ url: "/api/multiTenant/billing/usageRecords", method: "GET", signal: request.signal,
          params: { ...filters, ...(cursor ? { beforeAt: cursor.createdAt, beforeId: cursor.requestId } : {}) } }),
      ]);
      if (request.signal.aborted) return;
      if (overview) usage.value = overview;
      records.value = append ? [...records.value, ...list.items] : list.items;
      usageCursor.value = list.nextCursor;
    } else {
      const cursor = append ? business.value?.nextCursor : null;
      const data = await props.request<Business>({ url: "/api/multiTenant/billing/business", method: "GET", signal: request.signal,
        params: { ...filters, ...(cursor ? { beforeAt: cursor.paidAt, beforeId: cursor.id } : {}) } });
      if (request.signal.aborted) return;
      business.value = data;
      orders.value = append ? [...orders.value, ...data.orders] : data.orders;
    }
    lastFilters.value = filters;
  } catch (cause) { if (!request.signal.aborted) error.value = message(cause); }
  finally { if (pageRequest === request) loading.value = false; }
}
function more() { return refresh(true); }
onMounted(() => void refresh());
watch(tab, () => void refresh());
onBeforeUnmount(() => { controller.abort(); userSearch?.abort(); pageRequest?.abort(); entryRequest?.abort(); });

async function openMembership(order?: Order) {
  if (order) rememberAccount(order.userId, order.userName);
  Object.assign(orderForm, { userId: order?.userId ?? account.value, paymentRef: "", rate: order ? "standard" : "intro", segment: order?.segment ?? "unknown",
    amount: order ? "199" : "169", paidAt: "", imageRouteId: order?.imageRouteId ?? "", videoRouteId: order?.videoRouteId ?? "" });
  pendingOrder.value = undefined;
  mutationError.value = "";
  membershipOpen.value = true;
  try {
    const data = await props.request<{ routes: RouteOption[] }>({ method: "GET", url: "/api/multiTenant/models/get", signal: controller.signal });
    routeOptions.value = data.routes.filter(item => item.enabled);
  } catch (cause) { if (!controller.signal.aborted) mutationError.value = message(cause); }
}

function uncertain(cause: unknown) { const status = (cause as { status?: number })?.status; return !status || status >= 500; }
async function saveOrder() {
  if (mutating.value) return;
  const paidFen = fen(orderForm.amount);
  const paidAt = orderForm.paidAt ? Date.parse(orderForm.paidAt + ":00+08:00") : undefined;
  if (!pendingOrder.value && (!paidFen || !orderForm.userId || !orderForm.imageRouteId || !orderForm.videoRouteId || Number.isNaN(paidAt))) {
    mutationError.value = translate("请填写金额、账号和月卡模型");
    return;
  }
  pendingOrder.value ??= { id: crypto.randomUUID(), userId: orderForm.userId, paymentRef: orderForm.paymentRef, paidFen,
    rate: orderForm.rate, segment: orderForm.segment, paidAt, imageRouteId: orderForm.imageRouteId, videoRouteId: orderForm.videoRouteId };
  mutating.value = true;
  mutationError.value = "";
  try {
    await props.request({ method: "POST", url: "/api/multiTenant/billing/membership", data: pendingOrder.value, signal: controller.signal });
    pendingOrder.value = undefined;
    membershipOpen.value = false;
    await refresh();
  } catch (cause) {
    if (!controller.signal.aborted) mutationError.value = message(cause);
    if (!uncertain(cause)) pendingOrder.value = undefined;
  } finally { mutating.value = false; }
}

async function loadEntries(orderId: string) {
  entryRequest?.abort();
  const request = entryRequest = new AbortController();
  try {
    const data = await props.request<Business>({ method: "GET", url: "/api/multiTenant/billing/business", params: { orderId }, signal: request.signal });
    if (!request.signal.aborted) entries.value = data.adjustments;
  } catch (cause) { if (!request.signal.aborted) mutationError.value = message(cause); }
}
function openEntries(order: Order) {
  selectedOrder.value = order;
  Object.assign(entryForm, { kind: "model", quantity: 1, amount: "70", note: "" });
  pendingEntry.value = undefined;
  mutationError.value = "";
  entries.value = [];
  entryOpen.value = true;
  void loadEntries(order.id);
}
async function saveEntry() {
  const order = selectedOrder.value;
  if (!order || mutating.value) return;
  const value = entryForm.kind === "support" ? Number(entryForm.amount) : fen(entryForm.amount);
  if (!pendingEntry.value && (!value || !Number.isInteger(value) || value < 1 || !entryForm.note)) { mutationError.value = translate("请填写有效的数量与备注"); return; }
  pendingEntry.value ??= { id: crypto.randomUUID(), orderId: order.id, kind: entryForm.kind, value, quantity: entryForm.kind === "model" ? entryForm.quantity : 0, note: entryForm.note };
  mutating.value = true;
  mutationError.value = "";
  try {
    await props.request({ method: "POST", url: "/api/multiTenant/billing/adjustment", data: pendingEntry.value, signal: controller.signal });
    pendingEntry.value = undefined;
    entryForm.note = "";
    await Promise.all([loadEntries(order.id), refresh()]);
  } catch (cause) {
    if (!controller.signal.aborted) mutationError.value = message(cause);
    if (!uncertain(cause)) pendingEntry.value = undefined;
  } finally { mutating.value = false; }
}
</script>

<style scoped lang="scss">
.businessPage { display: grid; gap: 16px; min-width: 0; color: var(--el-text-color-primary); }
.toolbar, .panel {
  padding: 20px; border: 1px solid var(--el-border-color-light); border-radius: 14px;
  background: var(--el-bg-color); min-width: 0;
}
.tabs, .filters, .sectionHeader, .dialogActions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.filters { margin-top: 14px; }
.filters label { display: flex; gap: 8px; align-items: center; }
.accountSelect { width: min(180px, 55vw); }
.sectionHeader { justify-content: space-between; }
.panel h2 { font-size: 16px; margin: 0 0 12px; }
.sectionHeader h2 { margin: 0; }
.metrics {
  margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(155px, 100%), 1fr)); gap: 12px;
  div { border: 1px solid var(--el-border-color-light); background: var(--el-fill-color-blank); padding: 14px; border-radius: 12px; }
  dt, small { color: var(--el-text-color-secondary); }
  dd { font-size: 25px; margin: 6px 0 0; font-weight: 650; font-variant-numeric: tabular-nums; }
}
.tableScroll { overflow: auto; max-height: 440px; margin-bottom: 8px; }
table {
  width: 100%; border-collapse: collapse; font-size: 13px;
  th { position: sticky; top: 0; background: var(--el-bg-color); color: var(--el-text-color-secondary); }
  th, td { padding: 10px; text-align: start; border-bottom: 1px solid var(--el-border-color-lighter); white-space: nowrap; }
}
.muted, .receipt { color: var(--el-text-color-secondary); }
.receipt { display: block; margin-top: 3px; }
meter { width: 72px; vertical-align: middle; }
select, input {
  min-height: 35px; border: 1px solid var(--el-border-color); padding: 4px 8px; border-radius: 6px;
  background: var(--el-fill-color-blank); color: var(--el-text-color-primary); max-width: 100%;
}
.dialogForm {
  display: grid; gap: 12px;
  fieldset { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(175px, 100%), 1fr)); gap: 12px; border: 0; padding: 0; margin: 0; min-width: 0; }
  label { display: grid; gap: 5px; }
}
.dialogActions { justify-content: end; }
</style>
