<template>
  <div class="imageModelPanel">
    <p class="description">{{ mediaType === 'video' ? '添加 Muse 视频接口，在画布的视频生成节点中使用。' : '添加兼容 OpenAI 图片接口的第三方模型，在画布的图像生成节点中使用。' }}</p>
    <el-alert :title="mediaType === 'video' ? '支持文字生成视频和单张参考图生视频；生成会消耗服务额度。' : '支持文生图和单张参考图编辑；具体能力与费用取决于服务商。'" type="info" :closable="false" showIcon />
    <div class="modelList">
      <el-card v-for="item in providers" :key="item.id" class="modelCard" shadow="never">
        <div class="cardHeading">
          <div class="modelIcon"><icon-video v-if="mediaType === 'video'" :size="20" aria-hidden="true" /><icon-photo v-else :size="20" aria-hidden="true" /></div>
          <div class="modelInfo">
            <strong>{{ item.models[0]?.label || item.label }}</strong>
            <span>{{ item.models[0]?.id }}</span>
          </div>
          <el-tag effect="plain" size="small">{{ mediaType === 'video' ? 'Muse 接口' : 'OpenAI 兼容' }}</el-tag>
        </div>
        <el-alert v-if="item.loadError" :title="item.loadError" type="error" :closable="false" showIcon />
        <div class="cardFooter">
          <span>{{ mediaType === 'video' ? '视频生成' : '图像生成' }}</span>
          <div>
            <el-button text :icon="IconEdit" :disabled="busy" @click="edit(item)">编辑</el-button>
            <el-popconfirm :title="`确定移除这个${modelName}？`" confirmButtonText="移除" cancelButtonText="取消" @confirm="remove(item)">
              <template #reference><el-button text type="danger" :icon="IconTrash" :disabled="busy">移除</el-button></template>
            </el-popconfirm>
          </div>
        </div>
      </el-card>
    </div>
    <el-button class="addButton" :icon="IconPlus" @click="edit()">添加{{ modelName }}</el-button>

    <el-dialog v-model="dialogVisible" :title="`${editing ? '编辑' : '添加'}${modelName}`" width="min(600px, calc(100vw - 32px))" alignCenter appendToBody :closeOnClickModal="false" :showClose="!busy">
      <el-form labelPosition="top" @submit.prevent>
        <el-form-item label="显示名称" required><el-input v-model="draft.label" :placeholder="`例如：我的${modelName}`" maxlength="200" /></el-form-item>
        <el-form-item label="API 地址" required>
          <el-input v-model="draft.baseUrl" placeholder="例如：https://api.example.com/v1" />
          <span class="fieldHint">填写接口根地址，通常以 /v1 结尾。</span>
        </el-form-item>
        <el-form-item label="API Key" required><el-input v-model="draft.apiKey" type="password" showPassword autocomplete="off" placeholder="填写服务商提供的密钥" /></el-form-item>
        <el-form-item label="模型 ID" required><el-input v-model="draft.modelId" :placeholder="mediaType === 'video' ? '例如：muse-video' : '例如：gpt-image-1'" maxlength="200" /></el-form-item>
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" showIcon />
      </el-form>
      <template #footer>
        <el-button :disabled="busy" @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import axios from "axios";
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { IconEdit, IconPlus, IconTrash } from "@tabler/icons-vue";
import { invalidateNodeModels } from "@toonflow/nodes-scaffold/nodeAi";
import type { MediaProvider } from "@toonflow/provider-web/types";
import imageProviderTemplate from "@toonflow/providers/media/openAiImage?raw";
import videoProviderTemplate from "@toonflow/providers/media/museVideo?raw";
import { saveSettings, settings } from "@/stores/settings";

const { mediaType = "image" } = defineProps<{ mediaType?: "image" | "video" }>();
const modelName = mediaType === "video" ? "视频模型" : "图像模型";
const providerPrefix = mediaType === "video" ? "thirdPartyVideo" : "thirdPartyImage";
const providers = ref<MediaProvider[]>([]);
const dialogVisible = ref(false);
const editing = ref<MediaProvider>();
const busy = ref(false);
const formError = ref("");
const draft = reactive({ label: "", baseUrl: "", apiKey: "", modelId: "" });

async function refresh() {
  const { data } = await axios.get<{ code: number; data: MediaProvider[]; message?: string }>("/api/providers/media/list");
  if (data.code !== 200 || !Array.isArray(data.data)) throw new Error(data.message || `读取${modelName}失败`);
  providers.value = data.data.filter(item => item.id.startsWith(providerPrefix) && item.id !== `${providerPrefix}Template`);
}
onMounted(() => { void refresh().catch(() => ElMessage.error(`读取${modelName}失败`)); });

function edit(provider?: MediaProvider) {
  editing.value = provider;
  const configs = settings.value.mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined;
  const config = provider ? configs?.[provider.id] : undefined;
  draft.label = provider?.models[0]?.label ?? "";
  draft.modelId = provider?.models[0]?.id ?? "";
  draft.baseUrl = typeof config?.baseUrl === "string" ? config.baseUrl : "";
  draft.apiKey = typeof config?.apiKey === "string" ? config.apiKey : "";
  formError.value = "";
  dialogVisible.value = true;
}

async function save() {
  if (busy.value) return;
  formError.value = "";
  const label = draft.label.trim();
  const modelId = draft.modelId.trim();
  const apiKey = draft.apiKey.trim();
  const baseUrl = draft.baseUrl.trim().replace(/\/+$/, "");
  if (!label || !modelId || !apiKey || !baseUrl) { formError.value = "请填写全部必填项"; return; }
  try {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { formError.value = "API 地址须为不含账号、参数或锚点的 HTTP(S) 地址"; return; }
  if (apiKey.length > 8192) { formError.value = "API Key 过长"; return; }
  busy.value = true;
  let providerSaved = false;
  try {
    let provider = editing.value;
    if (provider) {
      const models = mediaType === "video" ? [{ id: modelId, label, type: "video", mode: ["text", "singleImage"] }] : [{ id: modelId, label, type: "image", mode: ["text", "singleImage"], imageRatios: ["1:1", "3:2", "2:3"] }];
      const response = await axios.put<{ code: number; data: MediaProvider; message?: string }>("/api/providers/media/save", { fileName: provider.fileName, revision: provider.revision, models });
      if (response.data.code !== 200 || !response.data.data) throw new Error(response.data.message || "保存模型失败");
      provider = response.data.data;
    } else {
      const id = `${providerPrefix}${crypto.randomUUID().replaceAll("-", "")}`;
      const template = mediaType === "video" ? videoProviderTemplate : imageProviderTemplate;
      const source = template.replace(`"${providerPrefix}Template"`, JSON.stringify(id)).replace(`"${mediaType}ModelTemplate"`, JSON.stringify(modelId)).replaceAll(`"第三方${modelName}"`, JSON.stringify(label));
      const response = await axios.post<{ code: number; data: MediaProvider; message?: string }>("/api/providers/media/add", { source });
      if (response.data.code !== 200 || !response.data.data) throw new Error(response.data.message || "添加模型失败");
      provider = response.data.data;
    }
    providerSaved = true;
    editing.value = provider;
    const providerId = provider.id;
    await saveSettings(current => {
      const configs = current.mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined;
      if (configs !== undefined && (!configs || typeof configs !== "object" || Array.isArray(configs))) throw new Error("媒体供应商配置格式无效");
      return { mediaProviderConfigs: { ...configs, [providerId]: { ...configs?.[providerId], baseUrl, apiKey } } };
    });
    invalidateNodeModels("media");
    await refresh();
    dialogVisible.value = false;
    ElMessage.success(`${modelName}已保存`);
  } catch (error) {
    const message = axios.isAxiosError(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "保存失败";
    formError.value = providerSaved ? `模型已保存，连接配置或刷新失败：${message}。可重试保存。` : message;
  } finally { busy.value = false; }
}

async function remove(provider: MediaProvider) {
  if (busy.value) return;
  busy.value = true;
  let removed = false;
  try {
    await axios.delete("/api/providers/media/delete", { data: { fileName: provider.fileName, revision: provider.revision } });
    removed = true;
    await saveSettings(current => {
      const configs = { ...(current.mediaProviderConfigs as Record<string, unknown> | undefined) };
      delete configs[provider.id];
      return { mediaProviderConfigs: configs };
    });
    invalidateNodeModels("media");
    await refresh();
  } catch (error) {
    ElMessage.error(removed ? "模型已移除，但连接配置清理失败，请刷新后重试" : axios.isAxiosError(error) ? error.response?.data?.message || error.message : "移除失败");
    if (removed) { invalidateNodeModels("media"); void refresh(); }
  } finally { busy.value = false; }
}
</script>

<style lang="scss" scoped>
.imageModelPanel {
  .description { margin: 0 0 14px; color: var(--el-text-color-secondary); line-height: 1.6; }
  .modelList { display: grid; gap: 12px; margin-top: 18px; }
  .modelCard {
    .cardHeading { display: flex; align-items: center; gap: 12px; }
    .modelIcon { display: grid; place-items: center; width: 40px; height: 40px; flex-shrink: 0; border-radius: var(--el-border-radius-base); background: var(--el-fill-color-light); color: var(--el-color-primary); }
    .modelInfo { display: grid; gap: 4px; flex: 1; min-width: 0; strong, span { overflow-wrap: anywhere; } span { color: var(--el-text-color-secondary); font-size: 12px; } }
    .cardFooter { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; color: var(--el-text-color-secondary); font-size: 12px; }
  }
  .addButton { width: 100%; margin-top: 16px; }
}
.fieldHint { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.5; margin-top: 6px; }
</style>
