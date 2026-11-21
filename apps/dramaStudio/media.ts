import { createWriteStream, rename, unlink, writeAtomic } from "@toonflow/file";
import { file } from "@toonflow/file/bun";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { assetPath, change, getMuse, imageFormat, mediaRoot, snapshot, studioRoot, StudioError } from "./store.ts";
import type { Asset, Episode, Film, ImageJob, Job, VideoJob } from "./store.ts";

const ffmpeg = process.env.TOONFLOW_FFMPEG || Bun.which("ffmpeg");
const ffprobe = process.env.TOONFLOW_FFPROBE || Bun.which("ffprobe");
export const canExport = Boolean(ffmpeg && ffprobe);

async function run(program: string, args: string[], cwd?: string, timeout = 60_000) {
  const process = Bun.spawn([program, ...args], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true, timeout });
  const [code, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  if (code !== 0) throw new StudioError(stderr.trim().split("\n").slice(-3).join(" ").slice(0, 420) || "媒体处理失败");
  return stdout;
}

export async function probe(path: string, kind: "video" | "audio") {
  if (!ffprobe) throw new StudioError("需要 FFprobe 才能读取视频和配音");
  const data = JSON.parse(await run(ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", path], undefined, 15_000));
  const video = data.streams.find((stream: { codec_type: string; disposition?: { attached_pic?: number } }) =>
    stream.codec_type === "video" && !stream.disposition?.attached_pic);
  const audio = data.streams.find((stream: { codec_type: string }) => stream.codec_type === "audio");
  const duration = Number((kind === "video" ? video : audio)?.duration || data.format?.duration);
  if (!(kind === "video" ? video : audio) || !Number.isFinite(duration) || duration <= 0) throw new StudioError("素材没有可用的音视频流");
  return { duration, audio: Boolean(audio) };
}

export async function pingMuse() {
  const { baseUrl, apiKey } = getMuse();
  if (!apiKey) throw new StudioError("请先填写 Muse API Key");
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(6000), redirect: "error",
  }).catch(() => { throw new StudioError("Muse 服务未连接，请启动 Muse2API 并检查地址"); });
  if (!response.ok) throw new StudioError(`Muse 连接失败（HTTP ${response.status}）`);
  const body = await response.json() as { data?: { id: string }[] };
  return body.data?.map(model => model.id) ?? [];
}

type MuseResult = {
  status?: string; task_id?: string; id?: string; progress?: number; url?: string; video?: { url?: string };
  result?: { url?: string }; data?: { url?: string }[]; error?: unknown;
};

async function museRequest(job: Job, suffix: string, body?: string): Promise<MuseResult> {
  const config = getMuse();
  if (config.baseUrl !== job.baseUrl || !config.apiKey) throw new StudioError("此任务的 Muse 地址或密钥已变更");
  const isImage = job.kind === "image";
  const headers = new Headers({ Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" });
  if (isImage && body) headers.set("Idempotency-Key", job.id);
  const response = await fetch(`${job.baseUrl}/${isImage ? "images/tasks" : "videos"}${suffix}`, {
    method: body ? "POST" : "GET", body, redirect: "error", signal: AbortSignal.timeout(body ? 60_000 : 15_000),
    headers,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new StudioError(`Muse 请求失败（HTTP ${response.status}）`, response.status);
  return data;
}

function updateJob(id: string, values: Partial<Job>) {
  change(draft => Object.assign(draft.jobs.find(job => job.id === id)!, values));
}

async function referenceImages(job: VideoJob) {
  const assets = job.refs.map(id => snapshot().assets.find(asset => asset.id === id)!);
  if (assets.some(asset => !asset)) throw new StudioError("参考图已失效");
  return Promise.all(assets.map(async asset => {
    const data = await file(assetPath(asset)).arrayBuffer();
    return `data:${asset.mime};base64,${Buffer.from(data).toString("base64")}`;
  }));
}

async function submit(job: Job) {
  const common = { model: job.model, prompt: job.prompt, aspect_ratio: job.ratio };
  const request = job.kind === "image"
    ? { ...common, response_format: "url", n: 1 }
    : { ...common, duration: job.duration, images: await referenceImages(job) };
  const payload = await museRequest(job, "", JSON.stringify(request));
  const remote = payload.task_id || payload.id;
  if (!remote || typeof remote !== "string") throw new StudioError("Muse 没有返回任务编号，请先检查 Muse 任务列表再重试");
  updateJob(job.id, { remote, status: "running", progress: job.kind === "image" ? 0 : 10, started: Date.now() });
}

async function downloadMuse(job: Job, rawUrl: string) {
  const url = new URL(rawUrl, `${job.baseUrl}/`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new StudioError("Muse 返回的下载地址无效");
  const headers = new Headers();
  if (url.origin === new URL(job.baseUrl).origin) headers.set("Authorization", `Bearer ${getMuse().apiKey}`);
  const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Muse 下载失败（HTTP ${response.status}）`);
  return response.body;
}

async function finishImage(job: ImageJob, url: string) {
  const temporary = join(mediaRoot, `${job.id}.part`);
  try {
    const stream = await downloadMuse(job, url);
    let bytes = 0;
    const image = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > 40 * 1024 * 1024) throw new StudioError("生成的图片超过 40 MiB");
        controller.enqueue(chunk);
      },
    });
    await pipeline(stream.pipeThrough(image), createWriteStream(temporary));
    const format = imageFormat(await file(temporary).slice(0, 16).arrayBuffer());
    if (!format) throw new StudioError("Muse 返回的文件不是 PNG、JPEG 或 WebP");
    const asset: Asset = { id: job.id, ...format, kind: job.category, name: job.name, bytes };
    await rename(temporary, assetPath(asset));
    change(draft => {
      draft.assets.push(asset);
      Object.assign(draft.jobs.find(item => item.id === job.id)!, { status: "done", progress: 100, error: undefined });
    });
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function finishVideo(job: VideoJob, url: string) {
  const stream = await downloadMuse(job, url);
  const asset: Asset = { id: job.id, ext: "mp4", mime: "video/mp4", kind: "视频", name: "", bytes: 0 };
  const target = assetPath(asset);
  const temporary = `${target}.part`;
  try {
    await pipeline(stream, createWriteStream(temporary));
    asset.duration = (await probe(temporary, "video")).duration;
    asset.bytes = file(temporary).size;
    await rename(temporary, target);
    change(draft => {
      const stored = draft.jobs.find(item => item.id === job.id)!;
      const shot = draft.episodes.find(episode => episode.id === job.episode)?.shots.find(item => item.id === job.shot);
      asset.name = shot?.title || "Muse 镜头";
      draft.assets.push(asset);
      Object.assign(stored, { status: "done", progress: 100, clip: asset.id, error: undefined });
      if (shot) {
        shot.versions.push(asset.id);
        if (!shot.clip) shot.clip = asset.id;
      }
    });
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

let pumping = false;
export async function pumpMuse() {
  if (pumping) return;
  const job = snapshot().jobs.find(item => item.status === "running") ?? snapshot().jobs.find(item => item.status === "queued");
  if (!job) return;
  pumping = true;
  try {
    if (!job.remote) {
      updateJob(job.id, { status: "submitting" });
      await submit(job);
      return;
    }
    const data = await museRequest(job, `/${encodeURIComponent(job.remote)}`);
    if (data.status === "failed" || data.status === "cancelled") {
      const reason = typeof data.error === "string" ? data.error : "Muse 生成失败";
      updateJob(job.id, { status: "failed", error: reason.slice(0, 420) });
      return;
    }
    if (["completed", "succeeded", "success", "done"].includes(data.status ?? "")) {
      const url = job.kind === "image" ? data.data?.[0]?.url : data.url || data.video?.url || data.result?.url;
      if (!url) throw new StudioError(job.kind === "image" ? "Muse 已完成，但未返回图片地址" : "Muse 已完成，但未返回视频地址");
      if (job.kind === "image") await finishImage(job, url);
      else await finishVideo(job, url);
      return;
    }
    const progress = typeof data.progress === "number" && Number.isFinite(data.progress)
      ? Math.min(99, Math.max(0, Math.round(data.progress))) : job.progress;
    if (job.progress !== progress || job.error) updateJob(job.id, { progress, error: undefined });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 420) : "Muse 暂时无响应";
    const expired = Date.now() > (job.started ?? Date.now()) + 60 * 60_000;
    const permanent = error instanceof StudioError && [400, 401, 403, 404, 422].includes(error.status);
    if (!job.remote || permanent || expired) {
      updateJob(job.id, {
        status: "failed", error: job.remote || permanent ? message : `${message}。提交结果未知，请先检查 Muse 任务列表。`,
      });
    } else if (job.error !== message) updateJob(job.id, { error: message });
  } finally {
    pumping = false;
  }
}

function timestamp(seconds: number) {
  const ms = Math.round(seconds * 1000);
  return [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60]
    .map(n => String(n).padStart(2, "0")).join(":") + `,${String(ms % 1000).padStart(3, "0")}`;
}

export function filmPath(id: string, ext: "mp4" | "srt") { return join(studioRoot, `${id}.${ext}`); }

export async function exportFilm(film: Film, episode: Episode, assets: Asset[], burn: boolean) {
  const segmentEntries: string[] = [];
  const listName = `${film.id}.ffconcat`;
  const intermediate = `${film.id}.joined.mp4`;
  const cleanup = [listName, intermediate];
  try {
    if (!ffmpeg || !ffprobe) throw new StudioError("请安装 FFmpeg 和 FFprobe");
    const frameSize = { "9:16": [720, 1280], "16:9": [1280, 720], "1:1": [960, 960] }[episode.ratio];
    const [width, height] = frameSize;
    let offset = 0;
    const subtitles: string[] = [];
    for (const [index, shot] of episode.shots.entries()) {
      const clip = assets.find(asset => asset.id === shot.clip)!;
      const voice = assets.find(asset => asset.id === shot.voice);
      const metadata = await probe(assetPath(clip), "video");
      const stop = shot.end ? Math.min(shot.end, metadata.duration) : metadata.duration;
      const duration = stop - shot.start;
      if (duration < 0.1) throw new StudioError(`镜头「${shot.title}」的裁剪范围无效`);
      const frames = Math.max(1, Math.round(duration * 24));
      const length = frames / 24;
      const segment = `${film.id}.${index}.mkv`;
      segmentEntries.push(`file '${segment}'\nduration ${length.toFixed(6)}`);
      cleanup.push(segment);
      const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-protocol_whitelist", "file,pipe", "-ss", String(shot.start), "-i", assetPath(clip)];
      const separateAudio = voice || shot.mute || !metadata.audio;
      if (voice) args.push("-protocol_whitelist", "file,pipe", "-i", assetPath(voice));
      else if (separateAudio) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
      args.push("-map", "0:v:0", "-map", separateAudio ? "1:a:0" : "0:a:0",
        "-vf", `fps=24,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=0.15`,
        "-af", `aresample=48000,apad=whole_dur=${length}`, "-t", String(length),
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", segment);
      await run(ffmpeg, args, studioRoot, 600_000);
      if (shot.dialogue.trim()) {
        const line = shot.dialogue.trim().replace(/\r/g, "").replace(/\n[\t ]*\n+/g, "\n").replaceAll("-->", "→");
        subtitles.push(`${subtitles.length + 1}\n${timestamp(offset)} --> ${timestamp(offset + length)}\n${line}`);
      }
      offset += length;
      change(draft => { draft.films.find(item => item.id === film.id)!.progress = Math.round((index + 1) / episode.shots.length * 85); });
    }
    await writeAtomic(filmPath(film.id, "srt"), subtitles.length ? `${subtitles.join("\n\n")}\n` : "");
    await writeAtomic(join(studioRoot, listName), `${segmentEntries.join("\n")}\n`);
    await run(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "1", "-i", listName,
      "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", intermediate], studioRoot, 600_000);
    if (burn && subtitles.length) {
      await run(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", intermediate,
        "-vf", `subtitles=${film.id}.srt:force_style='FontName=Microsoft YaHei,FontSize=19,Outline=2,MarginV=22'`,
        "-c:v", "libx264", "-preset", "veryfast", "-c:a", "copy", "-movflags", "+faststart", filmPath(film.id, "mp4")], studioRoot, 1_200_000);
    } else await rename(join(studioRoot, intermediate), filmPath(film.id, "mp4"));
    await probe(filmPath(film.id, "mp4"), "video");
    change(draft => Object.assign(draft.films.find(item => item.id === film.id)!, { status: "done", progress: 100, subtitles: subtitles.length > 0 }));
  } catch (error) {
    change(draft => Object.assign(draft.films.find(item => item.id === film.id)!, { status: "failed", error: (error instanceof Error ? error.message : "导出失败").slice(0, 420) }));
  } finally {
    await Promise.all(cleanup.map(name => unlink(join(studioRoot, name)).catch(() => {})));
  }
}
