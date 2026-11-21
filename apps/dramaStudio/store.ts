import { mkdirSync, readFileSync, writeAtomicSync } from "@toonflow/file";
import { join, resolve } from "node:path";

export const repository = resolve(import.meta.dir, "../..");
export const studioRoot = resolve(process.env.TOONFLOW_DRAMA_DATA || join(repository, "data", "dramaStudio"));
export const mediaRoot = join(studioRoot, "media");
mkdirSync(mediaRoot, { recursive: true });

export type Ratio = "9:16" | "16:9" | "1:1";
export type ImageKind = "角色" | "服装" | "场景" | "道具";
export type Asset = { id: string; kind: ImageKind | "视频" | "配音"; name: string; ext: string; mime: string; bytes: number; duration?: number };
export type Shot = {
  id: string; title: string; prompt: string; dialogue: string; duration: number; refs: string[];
  versions: string[]; clip: string; voice: string; start: number; end: number; mute: boolean;
};
export type Episode = { id: string; name: string; ratio: Ratio; shots: Shot[] };
type MuseJob = {
  id: string; status: "queued" | "submitting" | "running" | "done" | "failed";
  prompt: string; ratio: Ratio; baseUrl: string; model: string;
  progress: number; remote?: string; error?: string; started?: number;
};
export type VideoJob = MuseJob & { kind?: "video"; episode: string; shot: string; duration: number; refs: string[]; clip?: string };
export type ImageJob = MuseJob & { kind: "image"; name: string; category: ImageKind };
export type Job = VideoJob | ImageJob;
export type Film = {
  id: string; episode: string; name: string; status: "running" | "done" | "failed";
  progress: number; error?: string; subtitles: boolean;
};
type State = { episodes: Episode[]; assets: Asset[]; jobs: Job[]; films: Film[] };
type MuseSettings = { baseUrl: string; model: string; apiKey: string };

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

const statePath = join(studioRoot, "studio.json");
const settingsPath = join(studioRoot, "muse.json");
let state = readJson<State>(statePath, { episodes: [], assets: [], jobs: [], films: [] });
let museSettings = readJson<MuseSettings | null>(settingsPath, null);

export function getMuse(): MuseSettings {
  if (museSettings) return museSettings;
  const saved = readJson<{ settings?: { mediaProviderConfigs?: Record<string, Partial<MuseSettings>> } }>(join(repository, "data", "settings.json"), {});
  const configs = saved.settings?.mediaProviderConfigs ?? {};
  const existing = configs.museLocal ?? Object.entries(configs).find(([id]) => id.startsWith("thirdPartyVideo"))?.[1];
  return { baseUrl: existing?.baseUrl || "http://127.0.0.1:18610/v1", model: "muse-video", apiKey: existing?.apiKey || "" };
}

export function setMuse(settings: MuseSettings) {
  writeAtomicSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  museSettings = settings;
}

export function snapshot() { return state; }

export function change<T>(apply: (draft: State) => T): T {
  // ACT: 单进程本地工作台同步提交小型结构化快照，素材文件单独保存。
  const draft = structuredClone(state);
  const result = apply(draft);
  writeAtomicSync(statePath, JSON.stringify(draft), { mode: 0o600 });
  state = draft;
  return result;
}

export function createShot(input: Pick<Shot, "title" | "prompt"> & Partial<Pick<Shot, "dialogue" | "duration">>, source?: Shot): Shot {
  return {
    id: crypto.randomUUID(), ...input, dialogue: input.dialogue ?? source?.dialogue ?? "", duration: input.duration ?? source?.duration ?? 6,
    refs: [...(source?.refs ?? [])], versions: [], clip: "", voice: "", start: 0, end: 0, mute: false,
  };
}

export function assetPath(asset: Asset) { return join(mediaRoot, `${asset.id}.${asset.ext}`); }

export function isImage(asset: Asset) { return asset.mime.startsWith("image/"); }

export function imageFormat(bytes: ArrayBuffer) {
  const head = Buffer.from(bytes);
  if (head.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return { ext: "png", mime: "image/png" };
  if (head.subarray(0, 3).toString("hex") === "ffd8ff") return { ext: "jpg", mime: "image/jpeg" };
  if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") return { ext: "webp", mime: "image/webp" };
}

export class StudioError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
