import { unlink } from "@toonflow/file";
import { file, write } from "@toonflow/file/bun";
import { extname, join } from "node:path";
import { z } from "zod";
import { canExport, exportFilm, filmPath, pingMuse, probe, pumpMuse } from "./media.ts";
import { assetPath, change, createShot, getMuse, imageFormat, isImage, setMuse, snapshot, StudioError } from "./store.ts";
import type { Asset, Episode, Film, ImageJob } from "./store.ts";

const port = Number(process.env.TOONFLOW_DRAMA_PORT || 18770);
const origin = `http://127.0.0.1:${port}`;
const uuid = z.uuid();
const title = z.string().trim().min(1).max(100);
const ratio = z.enum(["9:16", "16:9", "1:1"]);
const text = z.string().max(12000);
const category = z.enum(["角色", "服装", "场景", "道具"]);
const episodeInput = z.object({ name: title, ratio });
const dialogueText = z.string().max(3000);
const shotDuration = z.number().int().min(1).max(30);
const shotInput = z.object({ title, prompt: text, dialogue: dialogueText.optional(), duration: shotDuration.optional() });
const shotUpdate = shotInput.extend({
  refs: z.array(uuid).max(10),
  clip: z.union([uuid, z.literal("")]), voice: z.union([uuid, z.literal("")]),
  start: z.number().min(0).max(86400), end: z.number().min(0).max(86400), mute: z.boolean(),
}).partial();
const fileTypes: Record<string, string> = {
  png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg",
};
const mib = 1024 * 1024;

function episodeById(id: string, state = snapshot()) {
  const episode = state.episodes.find(item => item.id === id);
  if (!episode) throw new StudioError("找不到这集", 404);
  return episode;
}

function shotById(episode: Episode, id: string) {
  const shot = episode.shots.find(item => item.id === id);
  if (!shot) throw new StudioError("找不到镜头", 404);
  return shot;
}

function assetById(id: string) {
  const asset = snapshot().assets.find(item => item.id === id);
  if (!asset) throw new StudioError("找不到素材", 404);
  return asset;
}

async function jsonInput<T extends z.ZodType>(req: Request, schema: T) {
  if (!req.headers.get("content-type")?.startsWith("application/json")) throw new StudioError("请求格式错误", 415);
  const input = await req.json().catch(() => { throw new StudioError("请求内容无效"); });
  const result = schema.safeParse(input);
  if (!result.success) throw new StudioError(`请检查输入（${result.error.issues[0]?.path.join(".") || "数据格式"}）`);
  return result.data;
}

function active(status: string) { return ["queued", "submitting", "running"].includes(status); }

function queueJobs(episode: Episode, ids: string[]) {
  if (!canExport) throw new StudioError("需要 FFmpeg 和 FFprobe 才能保存生成的视频");
  const config = getMuse();
  if (!config.apiKey) throw new StudioError("请先在设置中配置 Muse");
  const shots = [...new Set(ids)].map(id => shotById(episode, id));
  const accepted = shots.filter(shot => shot.prompt.trim() && !snapshot().jobs.some(job => job.kind !== "image" && job.shot === shot.id && active(job.status)));
  if (!accepted.length) throw new StudioError("请勾选已有提示词且没有进行中任务的镜头");
  for (const shot of accepted) {
    const size = shot.refs.reduce((total, id) => total + assetById(id).bytes, 0);
    if (size > 100 * mib) throw new StudioError(`「${shot.title}」的参考图总大小超过 100 MiB`);
    for (const match of shot.prompt.matchAll(/\[图(\d+)\]/g)) {
      if (+match[1] < 1 || +match[1] > shot.refs.length) throw new StudioError(`「${shot.title}」中 ${match[0]} 没有对应的参考图`);
    }
  }
  change(draft => {
    for (const shot of accepted) draft.jobs.push({
      id: crypto.randomUUID(), episode: episode.id, shot: shot.id, status: "queued", refs: shot.refs,
      duration: shot.duration, prompt: shot.prompt.trim(), ratio: episode.ratio, baseUrl: config.baseUrl, model: config.model, progress: 0,
    });
  });
  void pumpMuse();
  return { accepted: accepted.length };
}

async function uploadAsset(req: Request) {
  const data = await req.formData().catch(() => { throw new StudioError("无法读取上传的文件"); });
  const source = data.get("file");
  if (!(source instanceof File)) throw new StudioError("请选择素材文件");
  const ext = extname(source.name).slice(1).toLowerCase();
  const mime = fileTypes[ext];
  if (!mime || !source.size) throw new StudioError("支持 PNG、JPEG、WebP、MP4、MOV、WebM 和常见配音文件");
  const image = mime.startsWith("image/");
  const limit = image ? 40 : 260;
  if (source.size > limit * mib) throw new StudioError(`单个文件最多 ${limit} MiB`);
  const imageCategory = category.safeParse(data.get("kind"));
  const kind = image ? imageCategory.data || "角色" : mime.startsWith("video/") ? "视频" : "配音";
  if (image) {
    const format = imageFormat(await source.slice(0, 16).arrayBuffer());
    if (format?.mime !== mime) throw new StudioError("扩展名与图片实际格式不符");
  }
  const name = source.name.slice(0, -(ext.length + 1)).trim().slice(0, 100) || kind;
  const asset: Asset = { id: crypto.randomUUID(), name, ext, mime, kind, bytes: source.size };
  const path = assetPath(asset);
  try {
    await write(path, source);
    if (!image) asset.duration = (await probe(path, kind === "视频" ? "video" : "audio")).duration;
    change(draft => { draft.assets.push(asset); });
    return asset;
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  }
}

async function serveFile(req: Request, path: string, mime: string, downloadName?: string) {
  const media = file(path);
  if (!(await media.exists())) throw new StudioError("文件未找到", 404);
  const headers = new Headers({ "Content-Type": mime, "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" });
  if (downloadName) headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(downloadName).replaceAll("'", "%27")}`);
  const range = req.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const size = media.size;
    const start = match?.[1] ? Number(match[1]) : Math.max(0, size - Number(match?.[2]));
    const end = match?.[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(media.slice(start, end + 1, mime), { status: 206, headers });
  }
  return new Response(media, { headers });
}

async function api(req: Request, path: string[]): Promise<unknown> {
  const [area, id, action, target, operation] = path;
  const method = req.method;
  if (area === "state" && method === "GET") {
    const { baseUrl, model, apiKey } = getMuse();
    const { episodes, assets, jobs, films } = snapshot();
    return { episodes, assets, jobs, films, settings: { baseUrl, model, connected: Boolean(apiKey), canExport } };
  }
  if (area === "settings" && method === "PUT") {
    const input = await jsonInput(req, z.object({ baseUrl: z.url(), model: title, apiKey: z.string().trim().max(1024) }));
    const url = new URL(input.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new StudioError("请输入 HTTP(S) API 地址");
    const previous = getMuse();
    const baseUrl = url.href.replace(/\/+$/, "");
    if (baseUrl !== previous.baseUrl && !input.apiKey) throw new StudioError("更换地址时请填写对应的 API Key");
    if (snapshot().jobs.some(job => active(job.status))) throw new StudioError("Muse 有进行中的任务，请等队列结束再改配置");
    setMuse({ ...input, baseUrl, apiKey: input.apiKey || previous.apiKey });
    return { saved: true };
  }
  if (area === "muse" && id === "check" && method === "POST") return { models: await pingMuse() };
  if (area === "muse" && id === "image" && method === "POST") {
    const input = await jsonInput(req, z.object({
      name: z.string().trim().max(100), prompt: text.trim().min(1), ratio, category,
    }));
    const config = getMuse();
    if (!config.apiKey) throw new StudioError("请先在设置中配置 Muse");
    const job: ImageJob = {
      ...input, id: crypto.randomUUID(), kind: "image", status: "queued", progress: 0,
      name: input.name || input.prompt.replace(/\s+/g, " ").slice(0, 32),
      model: "muse-image", baseUrl: config.baseUrl,
    };
    change(draft => { draft.jobs.push(job); });
    void pumpMuse();
    return job;
  }
  if (area === "assets") {
    if (!id && method === "POST") return uploadAsset(req);
    const asset = assetById(uuid.parse(id));
    if (method === "GET") return serveFile(req, assetPath(asset), asset.mime, new URL(req.url).searchParams.has("download") ? `${asset.name}.${asset.ext}` : undefined);
    if (method === "PATCH") {
      const input = await jsonInput(req, z.object({ name: title, kind: category.optional() }));
      if (input.kind && !isImage(asset)) throw new StudioError("只可调整图片分类");
      return change(draft => Object.assign(draft.assets.find(item => item.id === id)!, input));
    }
  }
  if (area === "films" && method === "GET" && (action === "mp4" || action === "srt")) {
    const film = snapshot().films.find(item => item.id === id && item.status === "done");
    if (!film) throw new StudioError("成片尚未生成", 404);
    const download = action === "srt" || new URL(req.url).searchParams.has("download");
    return serveFile(req, filmPath(film.id, action), action === "mp4" ? "video/mp4" : "text/plain; charset=utf-8", download ? `${film.name}.${action}` : undefined);
  }
  if (area !== "episodes") throw new StudioError("找不到接口", 404);
  if (!id && method === "POST") {
    const input = await jsonInput(req, episodeInput);
    const episode: Episode = { id: crypto.randomUUID(), ...input, shots: [] };
    return change(draft => { draft.episodes.push(episode); return episode; });
  }
  const episode = episodeById(uuid.parse(id));
  if (!action && method === "PATCH") {
    const input = await jsonInput(req, episodeInput);
    return change(draft => Object.assign(episodeById(id, draft), input));
  }
  if (action === "generate" && method === "POST") {
    const input = await jsonInput(req, z.object({ ids: z.array(uuid).min(1).max(100) }));
    return queueJobs(episodeById(id), input.ids);
  }
  if (action === "export" && method === "POST") {
    const { burn } = await jsonInput(req, z.object({ burn: z.boolean() }));
    const current = episodeById(id);
    if (!canExport) throw new StudioError("未找到 FFmpeg 和 FFprobe");
    if (!current.shots.length || current.shots.some(shot => !shot.clip)) throw new StudioError("请给每个镜头选定视频版本");
    if (snapshot().films.some(film => film.status === "running")) throw new StudioError("已有成片正在导出");
    const film: Film = { id: crypto.randomUUID(), episode: id, name: current.name, status: "running", progress: 0, subtitles: false };
    const assets = snapshot().assets;
    change(draft => { draft.films.push(film); });
    void exportFilm(film, current, assets, burn);
    return film;
  }
  if (action === "order" && method === "PUT") {
    const { ids } = await jsonInput(req, z.object({ ids: z.array(uuid).max(250) }));
    return change(draft => {
      const current = episodeById(id, draft);
      if (ids.length !== current.shots.length || new Set(ids).size !== ids.length) throw new StudioError("镜头顺序已更改，请刷新后再试", 409);
      current.shots = ids.map(shotId => shotById(current, shotId));
      return current;
    });
  }
  if (action === "shots" && !target && method === "POST") {
    const { shots } = await jsonInput(req, z.object({ shots: z.array(shotInput).min(1).max(100) }));
    return change(draft => {
      const current = episodeById(id, draft);
      if (current.shots.length + shots.length > 250) throw new StudioError("单集最多 250 个镜头");
      const added = shots.map(input => createShot(input));
      current.shots.push(...added);
      return added;
    });
  }
  if (action === "shots" && target) {
    shotById(episode, uuid.parse(target));
    if (operation === "duplicate" && method === "POST") {
      return change(draft => {
        const current = episodeById(id, draft);
        if (current.shots.length >= 250) throw new StudioError("单集最多 250 个镜头");
        const source = shotById(current, target);
        const shot = createShot({ title: `${source.title.slice(0, 97)} 副本`, prompt: source.prompt }, source);
        current.shots.splice(current.shots.indexOf(source) + 1, 0, shot);
        return shot;
      });
    }
    if (method === "PATCH") {
      const parsed = await jsonInput(req, shotUpdate);
      return change(draft => {
        const shot = shotById(episodeById(id, draft), target);
        const values = { ...shot, ...parsed };
        if (values.refs.length !== new Set(values.refs).size || values.refs.some(ref => !isImage(assetById(ref)))) throw new StudioError("请选择不同的图片作为参考");
        if (values.clip && assetById(values.clip).kind !== "视频") throw new StudioError("请选择视频素材");
        if (values.voice && assetById(values.voice).kind !== "配音") throw new StudioError("请选择配音素材");
        if (parsed.clip !== undefined && parsed.clip !== shot.clip) { values.start = 0; values.end = 0; }
        const duration = values.clip ? assetById(values.clip).duration! : 0;
        if (values.start > 0 && values.start >= duration || values.end && (values.end <= values.start || values.end > duration + 0.05)) throw new StudioError("裁剪时间超出视频范围");
        if (values.clip && !values.versions.includes(values.clip)) values.versions.push(values.clip);
        return Object.assign(shot, values);
      });
    }
    if (method === "DELETE") {
      if (snapshot().jobs.some(job => job.kind !== "image" && job.shot === target && active(job.status))) throw new StudioError("请等镜头生成结束再移除");
      return change(draft => {
        const current = episodeById(id, draft);
        current.shots = current.shots.filter(shot => shot.id !== target);
        return current;
      });
    }
  }
  throw new StudioError("找不到接口", 404);
}

const builtClient = file(join(import.meta.dir, "studio.js"));
let client: string;
if (await builtClient.exists()) client = await builtClient.text();
else {
  const browser = await Bun.build({ entrypoints: [join(import.meta.dir, "studio.ts")], target: "browser", minify: true });
  if (!browser.success) throw new Error(browser.logs.join("\n"));
  client = await browser.outputs[0].text();
}
const html = await file(join(import.meta.dir, "index.html")).text();
const css = await file(join(import.meta.dir, "studio.css")).text();
const secure = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

Bun.serve({
  hostname: "127.0.0.1", port, maxRequestBodySize: 264 * mib, idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.origin !== origin) return new Response("Host denied", { status: 403 });
    if (url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && (req.headers.get("origin") !== origin || req.headers.get("x-drama-studio") !== "1")) {
        return Response.json({ error: "请从本地工作台操作" }, { status: 403, headers: secure });
      }
      try {
        const result = await api(req, url.pathname.split("/").slice(2));
        return result instanceof Response ? result : Response.json(result, { headers: secure });
      } catch (error) {
        const status = error instanceof StudioError ? error.status : error instanceof z.ZodError ? 400 : 500;
        const message = error instanceof StudioError ? error.message : status === 400 ? "输入内容无效" : "操作失败，请检查本地工作台日志";
        if (status === 500) console.error(error);
        return Response.json({ error: message }, { status: status >= 400 && status <= 599 ? status : 500, headers: secure });
      }
    }
    if (req.method !== "GET") return new Response(null, { status: 405, headers: secure });
    if (url.pathname === "/") return new Response(html, { headers: { ...secure, "Content-Type": "text/html; charset=utf-8" } });
    if (url.pathname === "/studio.js") return new Response(client, { headers: { ...secure, "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/studio.css") return new Response(css, { headers: { ...secure, "Content-Type": "text/css; charset=utf-8" } });
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204, headers: secure });
    return new Response(null, { status: 404, headers: secure });
  },
});

if (snapshot().jobs.some(job => job.status === "submitting") || snapshot().films.some(film => film.status === "running")) {
  change(draft => {
    for (const job of draft.jobs.filter(item => item.status === "submitting")) {
      if (job.kind === "image") job.status = "queued";
      else Object.assign(job, { status: "failed", error: "提交时程序退出。请先检查 Muse 任务列表再重试。" });
    }
    for (const film of draft.films.filter(item => item.status === "running")) Object.assign(film, { status: "failed", error: "工作台关闭，导出中断。可以重新导出。" });
  });
}
setInterval(() => { void pumpMuse().catch(console.error); }, 3500);
console.log(`漫剧工作台 ${origin}`);
