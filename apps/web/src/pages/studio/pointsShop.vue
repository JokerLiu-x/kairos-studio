<template>
  <section class="pointsShop" aria-labelledby="pointsTitle">
    <div class="shopHeader">
      <div>
        <h1 id="pointsTitle">积分充值</h1>
        <div class="rateList">
          <span><IconPhoto :size="18" aria-hidden="true" /> 图片 {{ rates.image }} 积分／张</span>
          <span><IconVideo :size="18" aria-hidden="true" /> {{ rates.resolution }} · {{ rates.duration }} 秒视频 {{ rates.video }} 积分／条</span>
        </div>
      </div>
      <div v-if="available !== undefined" class="balance">
        <span>可用积分</span>
        <strong>{{ formatPoints(available) }}</strong>
      </div>
    </div>

    <div class="packs">
      <article v-for="pack in packs" :key="pack.id" class="pack">
        <h2>{{ pack.label }}</h2>
        <p class="pointsCount">{{ formatPoints(pack.points) }} <span>积分</span></p>
        <p class="price">{{ formatPrice(pack.amountFen) }}</p>
        <button class="darkButton" type="button" :disabled="!canPay || !!paying" @click="checkout(pack.id)">
          {{ paying === pack.id ? "正在创建订单…" : "支付宝充值" }}
        </button>
      </article>
    </div>
    <p v-if="catalog && !catalog.online" class="hint">在线充值尚未启用。</p>
    <p v-else-if="catalog && !catalog.signedIn" class="hint">请使用创作账号登录后充值。</p>

    <div v-if="orderId && catalog?.signedIn" class="orderPanel">
      <div>
        <h2>充值订单</h2>
        <p role="status">{{ orderMessage }}</p>
      </div>
      <button class="pillButton" type="button" :disabled="checking" @click="refreshOrder">
        {{ checking ? "查询中…" : "刷新订单" }}
      </button>
    </div>
    <p v-if="error" class="errorNote" role="alert">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { IconPhoto, IconVideo } from "@tabler/icons-vue";
import { pointsPacks, pointsRates, type BillingSnapshot } from "@toonflow/multi-tenant-billing/config";
import http from "@/lib/http";
import { currentUser } from "@/stores/multiTenant";

type Catalog = { packs: typeof pointsPacks; rates: typeof pointsRates; online: boolean; signedIn: boolean };
type Order = { id: string; packId: string; amountFen: number; points: number; status: "pending" | "paid" | "expired" };
type Payment = { action: string; fields: Record<string, string> };

const route = useRoute();
const catalog = ref<Catalog>();
const packs = computed(() => catalog.value?.packs ?? pointsPacks);
const rates = computed(() => catalog.value?.rates ?? pointsRates);
const available = ref<string>();
const canPay = computed(() => catalog.value?.online && catalog.value.signedIn);
const order = ref<Order>();
const orderId = ref("");
const paying = ref("");
const checking = ref(false);
const error = ref("");
const locale = "zh-CN";
const priceFormat = new Intl.NumberFormat(locale, { style: "currency", currency: "CNY" });
const pointsFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 });
const formatPrice = (fen: number) => priceFormat.format(fen / 100);
const formatPoints = (value: number | string) => pointsFormat.format(Number(value));
const orderMessage = computed(() => {
  if (!order.value) return "正在确认支付状态。";
  if (order.value.status === "paid") return `支付成功，${formatPoints(order.value.points)} 积分已到账。`;
  if (order.value.status === "expired") return "订单付款时限已结束。若已付款，稍后刷新确认到账。";
  return "等待支付宝确认。完成付款后可刷新订单。";
});

function storageKey(packId: string) {
  return `kairosCheckout:${currentUser.value?.id}:${packId}`;
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "操作失败，请重试。";
}

async function loadBalance() {
  const wallet = await http<BillingSnapshot>({ method: "GET", url: "/api/multiTenant/user/balance" });
  available.value = wallet.wallets.find(item => item.currency === "POINTS")?.available ?? "0";
}

function rememberOrder(result: Order) {
  orderId.value = result.id;
  order.value = result;
  if (result.status !== "pending" && sessionStorage.getItem(storageKey(result.packId)) === result.id) sessionStorage.removeItem(storageKey(result.packId));
}

async function refreshOrder() {
  if (!orderId.value || checking.value) return;
  checking.value = true;
  error.value = "";
  try {
    rememberOrder(await http<Order>({ method: "GET", url: "/api/points/order", params: { id: orderId.value } }));
    if (order.value?.status === "paid") await loadBalance();
  } catch (cause) {
    error.value = message(cause);
  } finally { checking.value = false; }
}

function submitToAlipay(payment: Payment) {
  if (payment.action !== "https://openapi.alipay.com/gateway.do?charset=UTF-8") throw new Error("支付地址无效。");
  const form = document.createElement("form");
  form.action = payment.action;
  form.method = "POST";
  form.hidden = true;
  for (const [name, value] of Object.entries(payment.fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  form.submit();
}

async function checkout(packId: string) {
  if (!canPay.value || paying.value) return;
  paying.value = packId;
  error.value = "";
  const key = storageKey(packId);
  let submitted = false;
  try {
    const id = sessionStorage.getItem(key) || crypto.randomUUID();
    sessionStorage.setItem(key, id);
    const result = await http<Order & { payment: Payment | null }>({ method: "POST", url: "/api/points/checkout", data: { packId, id } });
    rememberOrder(result);
    if (result.payment) {
      submitToAlipay(result.payment);
      submitted = true;
    } else if (result.status === "paid") await loadBalance();
  } catch (cause) {
    if ((cause as { status?: number } | null)?.status === 409) sessionStorage.removeItem(key);
    error.value = message(cause);
  } finally {
    if (!submitted) paying.value = "";
  }
}

onMounted(async () => {
  try {
    catalog.value = await http<Catalog>({ method: "GET", url: "/api/points/catalog" });
    if (!catalog.value.signedIn) return;
    const returnedOrder = route.query.order ?? new URLSearchParams(location.search).get("out_trade_no");
    if (typeof returnedOrder === "string" && /^[0-9a-f-]{36}$/i.test(returnedOrder)) orderId.value = returnedOrder;
    await loadBalance();
    await refreshOrder();
  } catch (cause) { error.value = message(cause); }
});
</script>

<style scoped lang="scss">
.pointsShop {
  width: min(100%, 1120px);
  margin: clamp(14px, 5vw, 68px) auto;

  .shopHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 22px;
    margin-bottom: 34px;
  }
  .rateList {
    display: flex;
    flex-wrap: wrap;
    gap: 9px;
    margin-top: 18px;
    span {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 12px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--kairos-panel);
      color: var(--muted);
      font-size: 13px;
    }
  }
  .balance {
    min-width: 140px;
    display: grid;
    gap: 3px;
    padding: 12px 18px;
    border: 1px solid var(--line);
    border-radius: 16px;
    background: var(--kairos-panel);
    span { color: var(--muted); font-size: 13px; }
    strong { font-size: 24px; font-variant-numeric: tabular-nums; }
  }
  .packs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 218px), 1fr));
    gap: 14px;
  }
  .pack, .orderPanel {
    border: 1px solid var(--line);
    border-radius: 22px;
    background: var(--kairos-panel);
    box-shadow: inset 0 1px var(--kairos-highlight), var(--kairos-shadow);
    backdrop-filter: blur(24px);
  }
  .pack {
    padding: 23px;
    h2 { font-size: 17px; }
    .pointsCount {
      margin-top: 21px;
      font-size: 36px;
      font-weight: 750;
      letter-spacing: -.04em;
      span { color: var(--muted); font-size: 15px; font-weight: 500; letter-spacing: 0; }
    }
    .price { margin: 4px 0 22px; color: var(--muted); font-size: 16px; }
    button { width: 100%; justify-content: center; }
  }
  .hint, .errorNote { margin-top: 16px; }
  .hint, .orderPanel p { color: var(--muted); font-size: 14px; }
  .orderPanel {
    margin-top: 24px;
    padding: 18px 22px;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    h2 { font-size: 17px; margin-bottom: 5px; }
  }
}
</style>
