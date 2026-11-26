import { computed, onScopeDispose, ref } from "vue";
import { isAxiosError } from "axios";
import { getNodeModelIdentity, getNodeModelKey, useNodeAi, type NodeMediaModel, type NodeVideoRequest } from "@toonflow/nodes-scaffold/nodeAi";
import http from "@/lib/http";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { currentUser } from "@/stores/multiTenant";

export type QuickMode = "image" | "video";
type SavedReference = { path: string; mimeType: string };
export type QuickReference = { url: string; file?: File; asset?: SavedReference };
type QuickRecipe = { prompt?: string; ratio?: string; duration?: number; images?: SavedReference[]; modelKey?: string; resolution?: string };
type WorkDetails = { name?: string; tags?: string[]; favorite?: boolean };
export type QuickWork = QuickRecipe & { path: string; mimeType: string; mediaType: QuickMode; modifiedAt?: number; size?: number; details?: WorkDetails };
type QuickTask = QuickRecipe & { id: string; mode: QuickMode };
const folder = "quickCreation";
const outputs = `${folder}/works`;
const references = `${folder}/references`;
const supportedImages: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const knownOutputs: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif", gif: "image/gif", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };
export const quickImageTypes = Object.keys(supportedImages);
export const quickImageSize = 10 * 1024 * 1024;
export const quickDurations = [5, 6, 8, 10];
const defaultRatios = ["16:9", "9:16", "1:1"];

function readRecipe(data: unknown): QuickRecipe {
  if (!data || typeof data !== "object") return {};
  const { prompt, ratio, duration, images, modelKey, resolution } = data as QuickRecipe;
  return {
    prompt: typeof prompt === "string" ? prompt.slice(0, 10000) : undefined,
    ratio: typeof ratio === "string" && /^\d{1,2}:\d{1,2}$/.test(ratio) ? ratio : undefined,
    duration: typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : undefined,
    modelKey: typeof modelKey === "string" ? modelKey : undefined,
    resolution: typeof resolution === "string" ? resolution : undefined,
    images: Array.isArray(images) ? images.slice(0, 4).filter(image =>
      image && typeof image.path === "string" && /^quickCreation\/(?:works|references)\/[\w.-]+\.(?:jpe?g|png|webp)$/i.test(image.path)
      && quickImageTypes.includes(image.mimeType)) : undefined,
  };
}

function readWorkDetails(data: unknown): WorkDetails {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const { name, tags, favorite } = data as WorkDetails;
  return {
    name: typeof name === "string" ? name.trim().slice(0, 60) : undefined,
    tags: Array.isArray(tags) ? [...new Set(tags.filter(tag => typeof tag === "string").map(tag => tag.trim().slice(0, 16)).filter(Boolean))].slice(0, 8) : undefined,
    favorite: favorite === true,
  };
}

export default function useQuickMedia() {
  const controller = new AbortController();
  const identity = currentUser.value?.id ?? "local";
  const taskKey = `toonflow.quickCreation.${identity}`;
  const resultKey = `${taskKey}.lastResult`;
  const directory = ref("");
  const models = ref<NodeMediaModel[]>([]);
  const works = ref<QuickWork[]>([]);
  const loadingWorks = ref(false);
  const catalogLoading = ref(true);
  const workError = ref("");
  const generationError = ref("");
  const busy = ref(false);
  const activeMode = ref<QuickMode>();
  const latest = ref<QuickWork>();
  const nodeAi = useNodeAi({ onModelsChanged: loadCatalog });
  const selectedKeys = ref<Record<QuickMode, string>>({ image: "", video: "" });
  const modelsByMode = computed(() => ({
    image: models.value.filter(model => model.type === "image"),
    video: models.value.filter(model => model.type === "video"),
  }));
  function modelFor(type: QuickMode) {
    const choices = modelsByMode.value[type];
    return choices.find(model => getNodeModelKey(model) === selectedKeys.value[type])
      ?? choices.find(model => model.modelId === `muse-${type}`)
      ?? choices[0];
  }
  const choices = computed(() => ({ image: modelFor("image"), video: modelFor("video") }));
  const durations = computed(() => {
    const values = [...new Set((choices.value.video?.durationResolutionMap ?? []).flatMap(option => option.duration))];
    return values.length ? values.sort((left, right) => left - right) : quickDurations;
  });
  const resolutionsFor = (duration: number) => [...new Set((choices.value.video?.durationResolutionMap ?? [])
    .filter(option => option.duration.includes(duration)).flatMap(option => option.resolution))];
  const imageRatios = computed(() => choices.value.image?.imageRatios?.length ? choices.value.image.imageRatios : defaultRatios);
  const ratiosFor = (mode: QuickMode) => mode === "image" ? imageRatios.value : defaultRatios;
  function videoModeFor(count: number): NodeVideoRequest["mode"] {
    const modes = choices.value.video?.mode;
    if (!modes?.length) return count === 1 ? "singleImage" : count === 0 ? "text" : undefined;
    if (!count) return modes.includes("text") ? "text" : undefined;
    if (count === 1 && modes.includes("singleImage")) return "singleImage";
    const frames = (count === 2 && modes.includes("startEndRequired")) ? "startEndRequired"
      : modes.includes("endFrameOptional") ? "endFrameOptional" : modes.includes("startFrameOptional") ? "startFrameOptional" : undefined;
    if (count <= 2 && frames) return frames;
    return modes.find(mode => Array.isArray(mode) && mode.some(item => item.startsWith("imageReference:") && Number(item.split(":")[1]) >= count)) as NodeVideoRequest["mode"];
  }
  function referenceLimitFor(mode: QuickMode) {
    if (mode === "video") return [4, 3, 2, 1].find(count => videoModeFor(count)) ?? 0;
    const modes = choices.value.image?.mode;
    if (!modes?.length) return 1;
    if (modes.includes("multiReference")) return 4;
    return modes.includes("singleImage") ? 1 : 0;
  }
  function supportsReferences(mode: QuickMode, count: number) {
    if (mode === "video") return Boolean(videoModeFor(count));
    const modes = choices.value.image?.mode;
    if (!modes?.length) return count <= 1;
    return count === 0 ? modes.includes("text") : count <= referenceLimitFor(mode);
  }
  function videoReferenceLabel(index: number, count: number) {
    const inputMode = videoModeFor(Math.max(count, 1)) ?? videoModeFor(2);
    if (Array.isArray(inputMode)) return `参考图 ${index + 1}`;
    if (inputMode === "startFrameOptional" && count === 1) return "结束画面";
    return index === 0 ? "起始画面" : "结束画面";
  }
  let rootRequest: Promise<string> | undefined;
  let worksRequest: Promise<void> | undefined;
  const pendingTask = ref<QuickTask>();

  onScopeDispose(() => controller.abort());

  function root() {
    return rootRequest ??= http<{ absolutePath: string }>({ method: "GET", url: "/api/workspaces/list", signal: controller.signal })
      .then(result => directory.value = result.absolutePath)
      .catch(error => { rootRequest = undefined; throw error; });
  }

  async function ensureFolder(files: ReturnType<typeof useWorkspaceFiles>, path: string) {
    const segments = path.split("/");
    const name = segments.pop();
    const { entries } = await files.list(segments.join("/"), controller.signal);
    if (entries.some(entry => entry.name === name && entry.type === "directory")) return;
    try { await files.mkdir(path); }
    catch (error) {
      const { entries } = await files.list(segments.join("/"), controller.signal);
      if (!entries.some(entry => entry.name === name && entry.type === "directory")) throw error;
    }
  }

  async function loadCatalog() {
    catalogLoading.value = true;
    try { models.value = await nodeAi.getMediaModels(undefined, true); }
    catch { models.value = []; }
    finally { catalogLoading.value = false; }
  }

  function loadWorks() {
    return worksRequest ??= readWorks().finally(() => { worksRequest = undefined; });
  }

  async function readWorks() {
    loadingWorks.value = true;
    workError.value = "";
    try {
      const files = useWorkspaceFiles(await root());
      const top = await files.list("", controller.signal);
      if (!top.entries.some(entry => entry.name === folder && entry.type === "directory")) { works.value = []; return; }
      const studio = await files.list(folder, controller.signal);
      if (!studio.entries.some(entry => entry.path === outputs && entry.type === "directory")) { works.value = []; return; }
      const { entries } = await files.list(outputs, controller.signal, true);
      const previous = new Map(works.value.map(work => [work.path, work]));
      const names = new Set(entries.map(entry => entry.name));
      const assets = entries.flatMap<QuickWork>(entry => {
        const mimeType = knownOutputs[entry.name.split(".").pop()?.toLowerCase() ?? ""];
        if (entry.type !== "file" || !mimeType) return [];
        return [{ ...previous.get(entry.path), path: entry.path, mimeType, mediaType: mimeType.startsWith("image/") ? "image" : "video", modifiedAt: entry.modifiedAt, size: entry.size }];
      }).sort((left, right) => (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0));
      works.value = assets;
      for (let offset = 0; offset < assets.length; offset += 8) {
        const metadata = await Promise.all(assets.slice(offset, offset + 8).map(async asset => {
          const name = asset.path.split("/").at(-1);
          const hasDetails = names.has(`${name}.details.json`);
          const [recipe, details] = await Promise.all([
            names.has(`${name}.json`) ? files.readJson(`${asset.path}.json`, controller.signal).catch(() => asset) : null,
            hasDetails ? files.readJson(`${asset.path}.details.json`, controller.signal).catch(() => asset.details) : null,
          ]);
          return [asset.path, { ...readRecipe(recipe), details: hasDetails ? readWorkDetails(details) : undefined }] as const;
        }));
        if (controller.signal.aborted) return;
        const updates = new Map(metadata);
        works.value = works.value.map(asset => ({ ...asset, ...updates.get(asset.path) }));
      }
    } catch {
      if (!controller.signal.aborted) workError.value = "暂时无法读取作品，请重试。";
    } finally { loadingWorks.value = false; }
  }

  async function saveWorkDetails(work: QuickWork, patch: WorkDetails) {
    const files = useWorkspaceFiles(await root());
    const path = `${work.path}.details.json`;
    let hasDetails = !!work.details;
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = hasDetails ? await files.readTextSnapshot(path, { maxBytes: 16 * 1024, signal: controller.signal }).catch(error => {
        if (isAxiosError(error) && error.response?.status === 404) return null;
        throw error;
      }) : null;
      const stored: unknown = snapshot ? JSON.parse(snapshot.text) : {};
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new Error("作品资料格式有误，无法保存。");
      const updated = { ...stored, ...patch };
      const details = readWorkDetails(updated);
      try {
        if (snapshot) await files.writeTextSnapshot(path, `${JSON.stringify(updated, null, 2)}\n`, snapshot);
        else await files.writeJson(path, updated, true);
      } catch (error) {
        if (attempt < 2 && isAxiosError(error) && error.response?.status === 409) {
          hasDetails = true;
          continue;
        }
        throw error;
      }
      if (worksRequest) await worksRequest;
      works.value = works.value.map(asset => asset.path === work.path ? { ...asset, details } : asset);
      return;
    }
  }

  function remember(task?: QuickTask) {
    pendingTask.value = task;
    try {
      if (task) sessionStorage.setItem(taskKey, JSON.stringify(task));
      else sessionStorage.removeItem(taskKey);
    } catch { return; }
  }

  async function run(mode: QuickMode, prompt: string, ratio: string, duration: number, inputReferences: readonly QuickReference[], resolution: string) {
    if (busy.value || !prompt.trim()) return;
    const model = choices.value[mode];
    if (!model) return;
    if (pendingTask.value) { await resume(); return; }
    busy.value = true;
    activeMode.value = mode;
    generationError.value = "";
    latest.value = undefined;
    let terminal = false;
    try {
      if (!supportsReferences(mode, inputReferences.length)) throw new Error("参考图数量与当前模型不匹配");
      const videoMode = mode === "video" ? videoModeFor(inputReferences.length) : undefined;
      const sources = await Promise.all(inputReferences.map(async (reference): Promise<SavedReference | Blob> => {
        if (reference.asset) return reference.asset;
        const blob = reference.file ?? await fetch(reference.url, { signal: controller.signal }).then(response => {
          if (!response.ok) throw new Error("无法读取参考图");
          return response.blob();
        });
        if (!blob || !supportedImages[blob.type] || !blob.size || blob.size > quickImageSize) throw new Error("请选用不超过 10 MB 的 JPG、PNG 或 WebP 参考图");
        return blob;
      }));
      const rootDirectory = await root();
      const files = useWorkspaceFiles(rootDirectory);
      await ensureFolder(files, folder);
      const id = crypto.randomUUID();
      if (sources.some(source => source instanceof Blob)) await ensureFolder(files, references);
      const images = await Promise.all(sources.map(async (source, index) => {
        if (!(source instanceof Blob)) return source;
        const path = `${references}/${id}-${index + 1}.${supportedImages[source.type]}`;
        await files.write(path, source, true, controller.signal);
        return { path, mimeType: source.type };
      }));
      const input = { ...getNodeModelIdentity(model), directory: rootDirectory, outputDirectory: outputs, prompt: prompt.trim(), ratio, images: images.length ? images : undefined };
      remember({ id, mode, prompt: input.prompt, ratio, duration: mode === "video" ? duration : undefined, images, modelKey: getNodeModelKey(model), resolution: resolution || undefined });
      const options = { taskId: id, onStatus: (status: { result?: unknown }) => { terminal = Boolean(status.result); } };
      const frameMode = videoMode === "startEndRequired" || videoMode === "endFrameOptional" || videoMode === "startFrameOptional";
      const onlyLastFrame = videoMode === "startFrameOptional" && images.length === 1;
      const referenceOrder: NodeVideoRequest["referenceOrder"] = images.map((_, index) => frameMode
        ? { type: index === 0 && !onlyLastFrame ? "firstFrame" : "lastFrame" }
        : { type: "image", index });
      const results = mode === "image"
        ? await nodeAi.generateImage(input, controller.signal, options)
        : await nodeAi.generateVideo({
            ...input, duration, resolution: resolution || undefined, mode: videoMode, generateAudio: model.audio === true,
            images: frameMode ? undefined : input.images,
            firstFrame: frameMode && !onlyLastFrame ? images[0] : undefined,
            lastFrame: frameMode ? images[onlyLastFrame ? 0 : 1] : undefined,
            referenceOrder: referenceOrder.length ? referenceOrder : undefined,
          }, controller.signal, options);
      await finish(results);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (terminal || (error as { mediaTaskRejected?: boolean })?.mediaTaskRejected) remember();
      generationError.value = pendingTask.value ? "无法确认任务状态。请查询任务，不要重复提交。" : error instanceof Error ? error.message : "生成失败，请重试。";
    } finally { busy.value = false; }
  }

  async function finish(results: { mediaType: string; path: string; mimeType: string }[]) {
    const recipe = readRecipe(pendingTask.value);
    const assets = results.filter((item): item is QuickWork => item.mediaType === "image" || item.mediaType === "video");
    const result = assets[0] && { ...assets[0], ...recipe };
    if (result) {
      try { sessionStorage.setItem(resultKey, JSON.stringify(result)); }
      catch { latest.value = result; }
    }
    if (!result) {
      remember();
      throw new Error("任务结束，但没有可预览的作品");
    }
    if (recipe.prompt && directory.value) {
      const files = useWorkspaceFiles(directory.value);
      await Promise.all(assets.map(asset => files.writeJson(`${asset.path}.json`, recipe, true).catch(() => undefined)));
    }
    remember();
    latest.value = result;
    if (worksRequest) await worksRequest;
    await loadWorks();
  }

  async function resume() {
    const task = pendingTask.value;
    if (busy.value || !task) return;
    busy.value = true;
    activeMode.value = task.mode;
    generationError.value = "";
    let terminal = false;
    try {
      const results = await nodeAi.resumeMedia(await root(), task.id, controller.signal, { onStatus: status => { terminal = Boolean(status.result); } });
      await finish(results);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (terminal) remember();
      generationError.value = terminal && error instanceof Error ? error.message : "任务状态暂不可用，请稍后再查。";
    } finally { busy.value = false; }
  }

  function restore() {
    try {
      const stored = JSON.parse(sessionStorage.getItem(taskKey) ?? "null");
      if (stored && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(stored.id) && (stored.mode === "image" || stored.mode === "video")) pendingTask.value = { id: stored.id, mode: stored.mode, ...readRecipe(stored) };
    } catch { return; }
    if (pendingTask.value) { void resume(); return; }
    try {
      const result = JSON.parse(sessionStorage.getItem(resultKey) ?? "null");
      if (result && typeof result.path === "string" && /^quickCreation\/works\/(?:image|video)[a-f0-9]+\.[a-z0-9]+$/i.test(result.path)
        && (result.mediaType === "image" || result.mediaType === "video") && typeof result.mimeType === "string" && result.mimeType.startsWith(`${result.mediaType}/`)) {
        latest.value = { path: result.path, mediaType: result.mediaType, mimeType: result.mimeType, ...readRecipe(result) };
        void root().catch(() => { latest.value = undefined; });
      }
    } catch { return; }
  }

  return {
    directory, choices, modelsByMode, selectedKeys, durations, resolutionsFor, ratiosFor, referenceLimitFor, supportsReferences, videoReferenceLabel,
    works, loadingWorks, catalogLoading, workError, generationError, busy, activeMode, latest, pendingTask,
    loadCatalog, loadWorks, saveWorkDetails, run, restore, resume,
  };
}
