<template>
  <div class="userWeb">
    <header class="authHeader">
      <div class="brand">
        <img v-if="logoUrl" class="brandLogo" :class="{ defaultLogo: brandName === 'Toonflow' }" :src="logoUrl" alt="" />
        <span class="brandName">{{ brandName }}</span>
      </div>
      <button v-if="darkMode !== undefined" class="themeButton" type="button" :aria-label="translate('深色模式')" :aria-pressed="darkMode" @click="emit('toggleTheme')">
        <span aria-hidden="true" />
      </button>
    </header>
    <main class="authMain" :class="{ withArt: !!$slots.art }">
      <div v-if="$slots.art" class="artPanel" aria-hidden="true">
        <slot name="art" />
      </div>
      <section class="authPanel" aria-labelledby="authTitle">
        <header class="panelHeader">
          <h1 id="authTitle">{{ mode === "login" ? translate("登录") : translate("注册") }}</h1>
        </header>
        <el-form class="authForm" labelPosition="top" hideRequiredAsterisk :disabled="busy" :aria-busy="busy" @submit.prevent="submit">
          <el-form-item :label="translate('账号')" for="userAccount" :error="userNameError" required>
            <el-input id="userAccount" ref="userNameInput" v-model="userName" name="username" autocomplete="username" aria-required="true" :maxlength="64" />
          </el-form-item>
          <el-form-item :label="translate('密码')" for="userPassword" :error="passwordError" required>
            <el-input id="userPassword" ref="passwordInput" v-model="password" name="password" type="password" showPassword aria-required="true" :autocomplete="mode === 'register' ? 'new-password' : 'current-password'" :minlength="8" :maxlength="128" />
          </el-form-item>
          <el-form-item v-if="mode === 'register'" :label="translate('确认密码')" for="userPasswordConfirm" :error="confirmationError" required>
            <el-input id="userPasswordConfirm" ref="confirmationInput" v-model="passwordConfirm" type="password" showPassword autocomplete="new-password" aria-required="true" :minlength="8" :maxlength="128" />
          </el-form-item>
          <el-alert v-if="requestError" class="requestError" :title="requestError" type="error" :closable="false" showIcon />
          <el-button class="submitButton" type="primary" nativeType="submit" :loading="busy" :disabled="busy">{{ mode === "login" ? translate("登录") : translate("注册") }}</el-button>
        </el-form>
        <footer v-if="registrationEnabled" class="accountSwitch">
          <el-button class="modeButton" link type="primary" :disabled="busy" @click="switchMode">{{ mode === "login" ? translate("注册账号") : translate("返回登录") }}</el-button>
        </footer>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { translate } from "@toonflow/i18n/vue";
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ElAlert, ElButton, ElForm, ElFormItem, ElInput, type InputInstance } from "element-plus";
import type { UserIdentity, UserRequest } from "./types";
import "element-plus/es/components/alert/style/css";
import "element-plus/es/components/button/style/css";
import "element-plus/es/components/form/style/css";
import "element-plus/es/components/form-item/style/css";
import "element-plus/es/components/input/style/css";

const props = withDefaults(defineProps<{ request: UserRequest; logoUrl?: string; brandName?: string; registrationEnabled: boolean; darkMode?: boolean }>(), { brandName: "Toonflow", darkMode: undefined });
const emit = defineEmits<{ authenticated: [user: UserIdentity]; toggleTheme: [] }>();
const mode = ref<"login" | "register">("login");
const userName = ref("");
const password = ref("");
const passwordConfirm = ref("");
const busy = ref(false);
const userNameError = ref("");
const passwordError = ref("");
const confirmationError = ref("");
const requestError = ref("");
const userNameInput = ref<InputInstance>();
const passwordInput = ref<InputInstance>();
const confirmationInput = ref<InputInstance>();
const controller = new AbortController();

watch([userName, password, passwordConfirm], () => {
  userNameError.value = "";
  passwordError.value = "";
  confirmationError.value = "";
  requestError.value = "";
});

async function switchMode() {
  if (busy.value || !props.registrationEnabled) return;
  mode.value = mode.value === "login" ? "register" : "login";
  password.value = "";
  passwordConfirm.value = "";
  userNameError.value = "";
  passwordError.value = "";
  confirmationError.value = "";
  requestError.value = "";
  await nextTick();
  userNameInput.value?.focus();
}

async function submit() {
  if (busy.value) return;
  if (mode.value === "register" && !props.registrationEnabled) return;
  const name = userName.value.trim();
  if (!name || name.length > 64) {
    userNameError.value = translate("账号长度应为 1 到 64 个字符");
    userNameInput.value?.focus();
    return;
  }
  if (/[\s\u0000-\u001f\u007f]/.test(name)) {
    userNameError.value = translate("账号不能包含空白或控制字符");
    userNameInput.value?.focus();
    return;
  }
  if (password.value.length < 8 || password.value.length > 128) {
    passwordError.value = translate("密码长度应为 8 到 128 个字符");
    passwordInput.value?.focus();
    return;
  }
  if (mode.value === "register" && password.value !== passwordConfirm.value) {
    confirmationError.value = translate("两次输入的密码不一致");
    confirmationInput.value?.focus();
    return;
  }
  busy.value = true;
  requestError.value = "";
  try {
    const result = await props.request<{ user: UserIdentity }>({
      method: "POST", url: `/api/multiTenant/user/${mode.value}`, data: { userName: name, password: password.value }, signal: controller.signal,
    });
    password.value = "";
    passwordConfirm.value = "";
    emit("authenticated", result.user);
  } catch (cause) {
    if (!controller.signal.aborted) requestError.value = cause instanceof Error ? cause.message : translate("账号操作失败，请重试");
  } finally { busy.value = false; }
}

onBeforeUnmount(() => {
  controller.abort();
  password.value = "";
  passwordConfirm.value = "";
});
</script>

<style lang="scss" scoped>
.userWeb {
  --authPaper: #f0eeea;
  --authGlass: rgb(255 255 255 / 86%);
  --authSurface: rgb(255 255 255 / 70%);
  --authShadow: 0 20px 60px rgb(19 30 38 / 12%), 0 2px 8px rgb(19 30 38 / 4%);
  --authLink: #315d84;

  min-height: 100svh;
  padding: 0 clamp(20px, 3.6vw, 56px) clamp(20px, 3.6vw, 56px);
  background: var(--kairos-grain), var(--kairos-page, var(--el-bg-color));
  color: var(--kairos-text, var(--el-text-color-primary));
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;

  html.dark & {
    --authPaper: #12161a;
    --authGlass: rgb(19 23 28 / 88%);
    --authSurface: rgb(255 255 255 / 6%);
    --authShadow: 0 20px 60px rgb(0 0 0 / 32%);
    --authLink: #aed4f3;
  }

  .authHeader,
  .authMain { width: min(100%, 1320px); margin-inline: auto; }

  .authHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 82px;
    padding-inline: 4px;

    .brand {
      display: flex;
      align-items: center;
      gap: 9px;

      .brandLogo { width: 33px; height: 33px; object-fit: contain; html.dark &.defaultLogo { filter: invert(1); } }
      .brandName { font-size: 22px; font-weight: 720; letter-spacing: -0.045em; }
    }

    .themeButton {
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      padding: 0;
      color: inherit;
      background: var(--authSurface);
      border: 1px solid var(--kairos-line);
      border-radius: 50%;
      cursor: pointer;

      span {
        width: 16px;
        height: 16px;
        border: 1.5px solid currentColor;
        border-radius: 50%;
        background: linear-gradient(90deg, currentColor 50%, transparent 50%);
        transform: rotate(-24deg);
        transition: transform 180ms ease;
      }

      &[aria-pressed="true"] span { transform: rotate(156deg); }
      &:hover { background: var(--kairos-hover); }
      &:focus-visible { outline: 2px solid var(--kairos-focus); outline-offset: 3px; }
    }
  }

  .authMain {
    position: relative;
    isolation: isolate;
    display: grid;
    align-items: center;
    justify-items: center;
    min-height: clamp(540px, calc(100svh - 138px), 820px);
    overflow: clip;
    padding: 42px clamp(26px, 5.8vw, 86px);
    border: 1px solid var(--kairos-line);
    border-radius: 28px;
    background: var(--kairos-grain), radial-gradient(ellipse at 24% 32%, var(--kairos-glow), transparent 65%), var(--authPaper);

    &.withArt { justify-items: start; }

    .artPanel {
      position: absolute;
      z-index: -1;
      inset: 0 0 0 20%;
      pointer-events: none;
      mask-image: linear-gradient(90deg, transparent, #000 36%);

      :slotted(img) { display: block; width: 100%; height: 100%; object-fit: cover; object-position: 53% 55%; }
      html.dark & :slotted(img) { filter: brightness(0.74) saturate(0.82); }
    }

    .authPanel {
      width: min(100%, 408px);
      min-width: 0;
      padding: clamp(26px, 3vw, 42px);
      border: 1px solid var(--kairos-edge);
      border-radius: 24px;
      background: var(--authGlass);
      box-shadow: inset 0 1px var(--kairos-highlight), var(--authShadow);
      backdrop-filter: blur(24px);

      .panelHeader {
        margin-bottom: 26px;

        h1 {
          margin: 0;
          font-size: 36px;
          font-weight: 700;
          line-height: 1.18;
          letter-spacing: -0.035em;
          overflow-wrap: anywhere;
        }
      }

      .authForm {
        :deep(.el-form-item) { margin-bottom: 20px; }
        :deep(.el-form-item__label) {
          height: auto;
          margin-bottom: 7px;
          padding: 0;
          color: var(--kairos-muted, var(--el-text-color-regular));
          font-weight: 600;
          line-height: 1.45;
        }
        :deep(.el-input__wrapper) {
          min-height: 48px;
          padding: 0 14px;
          border-radius: 12px;
          background: var(--authSurface);
          box-shadow: inset 0 0 0 1px var(--kairos-edge);
          transition: box-shadow 150ms ease;
        }
        :deep(.el-input__wrapper.is-focus) {
          box-shadow: inset 0 0 0 1px var(--kairos-focus), 0 0 0 3px var(--kairos-glow);
        }
        :deep(.el-form-item.is-error .el-input__wrapper) { box-shadow: inset 0 0 0 1px var(--kairos-error); }
        :deep(.el-input__inner) { height: 46px; color: inherit; font-size: 16px; }
        :deep(.el-form-item__error) { position: static; padding-top: 6px; line-height: 1.5; color: var(--kairos-error); overflow-wrap: anywhere; }

        .requestError {
          align-items: flex-start;
          margin-bottom: 16px;

          :deep(.el-alert__title) { line-height: 1.5; overflow-wrap: anywhere; }
        }

        .submitButton {
          width: 100%;
          min-height: 48px;
          margin-left: 0;
          border: 1px solid var(--kairos-edge);
          border-radius: 12px;
          color: var(--kairos-on-blue, #142437);
          background: var(--kairos-blue, #a9d4f8);
          font-weight: 700;
          transition: background 150ms ease;

          &:hover:not(:disabled) { background: var(--kairos-blue-hover); }
          &:focus-visible { outline: 2px solid var(--kairos-focus); outline-offset: 3px; }
        }
      }

      .accountSwitch {
        display: flex;
        justify-content: center;
        margin-top: 11px;

        .modeButton {
          min-height: 44px;
          margin-left: 0;
          padding: 8px 12px;
          border-radius: 8px;
          color: var(--authLink);
          font-weight: 600;
          white-space: normal;

          &:hover:not(:disabled) { text-decoration: underline; text-underline-offset: 4px; }
          &:focus-visible { outline: 2px solid var(--kairos-focus); outline-offset: 2px; }
        }
      }
    }
  }

  @media (max-width: 760px) {
    padding: 0 14px 20px;

    .authHeader { min-height: 66px; padding-inline: 8px; }

    .authMain {
      min-height: 0;
      padding: 28px 14px;
      border-radius: 22px;

      &.withArt { justify-items: center; padding-top: clamp(132px, 29vw, 204px); }

      .artPanel {
        inset: 0 0 auto;
        height: clamp(218px, 47vw, 300px);
        mask-image: linear-gradient(#000 46%, transparent 100%);

        :slotted(img) { object-position: 54% 43%; }
      }

      .authPanel {
        padding: 26px clamp(20px, 5vw, 32px) 19px;
        border-radius: 20px;

        .panelHeader { margin-bottom: 22px; }
      }
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .themeButton span, .submitButton, :deep(.el-input__wrapper) { transition: none; }
  }
}
</style>
