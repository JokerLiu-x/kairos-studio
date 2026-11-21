import type { Asset, Episode, Film, ImageJob, Job, Shot } from "./store.ts";

type Section = "assets" | "shots" | "film";
type Studio = {
  episodes: Episode[]; assets: Asset[]; jobs: Job[]; films: Film[];
  settings: { baseUrl: string; model: string; connected: boolean; canExport: boolean };
};

const query = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document) => root.querySelector<T>(selector);
const page = query("#page")!;
const topBar = query(".topBar")!;
const episodeSelect = query<HTMLSelectElement>("#episodeSelect")!;
const modal = query<HTMLDialogElement>("#modal")!;
const modalForm = query<HTMLFormElement>("#modalForm")!;
const toast = query("#toast")!;
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]!);
const numberLabel = (index: number) => String(index + 1).padStart(2, "0");
const checked = (value: boolean) => value ? "checked" : "";
const selected = (value: boolean) => value ? "selected" : "";
const media = (id: string) => `/api/assets/${id}`;
const asset = (id: string) => state.assets.find(item => item.id === id);
const episode = () => state.episodes.find(item => item.id === episodeId);
const currentShot = () => episode()?.shots.find(item => item.id === shotId);
const episodeUrl = (suffix = "") => `/api/episodes/${episodeId}${suffix}`;
const shotUrl = (id = shotId) => episodeUrl(`/shots/${id}`);
const latestJob = (id: string) => state.jobs.findLast(job => job.kind !== "image" && job.shot === id);
const active = (job?: Job) => Boolean(job && ["queued", "submitting", "running"].includes(job.status));
const assetKinds = ["角色", "服装", "场景", "道具"];
const sections = { assets: "素材库", shots: "分镜台", film: "成片" };
let state: Studio = { episodes: [], assets: [], jobs: [], films: [], settings: { baseUrl: "", model: "muse-video", connected: false, canExport: false } };
let section: Section = "shots";
let episodeId = localStorage.getItem("dramaEpisode") || "";
let shotId = "";
let filter = "全部";
let search = "";
let muse: "ready" | "offline" | "unknown" = "unknown";
let marked = new Set<string>();
let dirty = false;
let draftRevision = 0;
let draftTimer = 0;
let busy = false;
let requestRevision = 0;
let toastTimer = 0;
let modalAction: ((data: FormData) => Promise<void>) | undefined;
let dragged = "";
let previewPosition = -1;
let previewPlaying = false;

async function api<T = unknown>(path: string, method = "GET", body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "x-drama-studio": "1" };
  if (body !== undefined && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { method, headers, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `操作失败（${response.status}）`);
  return result;
}

function announce(message: string, error = false) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = error ? "error" : "";
  toast.hidden = false;
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, error ? 6500 : 3300);
}

async function run(action: () => void | Promise<void>) {
  if (busy) return;
  busy = true;
  try { await action(); }
  catch (error) { announce(error instanceof Error ? error.message : "操作失败", true); }
  finally { busy = false; }
}

async function load() {
  const revision = ++requestRevision;
  const fresh = await api<Studio>("/api/state");
  if (revision !== requestRevision) return;
  state = fresh;
  if (!episode()) episodeId = state.episodes[0]?.id || "";
  if (!currentShot()) shotId = episode()?.shots[0]?.id || "";
}

async function refresh() { await load(); render(); }

function button(action: string, label: string, className = "", id = "", disabled = false) {
  return `<button type="button" class="${className}" data-action="${action}" data-id="${escape(id)}" ${disabled ? "disabled" : ""}>${escape(label)}</button>`;
}

function status(shot: Shot) {
  const job = latestJob(shot.id);
  if (job?.status === "running") return [`生成 ${job.progress}%`, "active"];
  if (job?.status === "queued" || job?.status === "submitting") return [job.status === "queued" ? "待生成" : "提交中", "active"];
  if (job?.status === "failed") return ["生成失败", "error"];
  if (shot.clip) return ["已选版", "success"];
  return ["待制作", ""];
}

function empty(title: string, description: string, action = "") {
  return `<div class="empty"><span class="emptyMark" aria-hidden="true"></span><h2>${title}</h2><p>${description}</p>${action}</div>`;
}

function updateRail() {
  query("#signal")!.className = `signal ${muse}`;
  query("#connectionLabel")!.textContent = muse === "ready" ? "Muse 已连接" : muse === "offline" ? "Muse 未连接" : "Muse 设置";
}

function render() {
  const item = episode();
  previewPosition = -1;
  previewPlaying = false;
  episodeSelect.innerHTML = state.episodes.length ? state.episodes.map(value =>
    `<option value="${value.id}" ${selected(value.id === episodeId)}>${escape(value.name)}</option>`).join("")
    : '<option value="">尚无剧集</option>';
  for (const node of document.querySelectorAll<HTMLButtonElement>('.rail nav button')) {
    if (node.dataset.id === section) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  }
  topBar.innerHTML = `<div>${item && section !== "assets" ? `<div class="crumb">${escape(item.name)} · <span class="mono">${item.ratio}</span></div>` : ""}
    <h1>${sections[section]}</h1></div>
    <div class="actions">${item && section !== "assets" ? button("editEpisode", "剧集设置", "plain") : ""}
    ${section === "assets" ? button("generateImage", "Muse 生图", "primary") : ""}
    ${section === "shots" && item ? button("addShot", "＋ 新建镜头", "primary") : ""}</div>`;
  if (section === "assets") renderAssets();
  else if (!item) page.innerHTML = empty("新建一集", "填写剧集名称和画幅，就可以开始整理分镜。", button("newEpisode", "＋ 新建一集", "primary"));
  else if (section === "shots") renderShots(item);
  else renderFilm(item);
  updateRail();
}

function renderAssets() {
  page.innerHTML = `<div class="dropZone" id="assetDrop"><div><strong>导入素材</strong><small>将图片、视频或配音从文件夹拖到这里。</small></div>
    <div class="actions"><label class="field"><select id="importKind" aria-label="导入图片分类">${assetKinds.map(kind => `<option ${selected(filter === kind)}>${kind}</option>`).join("")}</select></label>
    ${button("importAssets", "选择文件")}<input id="assetInput" type="file" multiple accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm,audio/*" hidden></div></div>
    <div id="imageTasks" class="imageTasks" aria-label="Muse 生图任务"></div>
    <div class="strip" id="assetFilters">${["全部", ...assetKinds, "视频", "配音"].map(kind =>
      `<button type="button" class="filter compact" data-action="filter" data-id="${kind}" aria-pressed="${kind === filter}">${kind}</button>`).join("")}
      <input class="search" id="assetSearch" type="search" aria-label="搜索素材" placeholder="搜索素材名称" value="${escape(search)}"></div>
    <div id="assetList"></div>`;
  updateImageTasks();
  updateGallery();
}

function updateImageTasks() {
  const target = query("#imageTasks");
  if (!target) return;
  const jobs = state.jobs.filter(job => job.kind === "image").reverse();
  const visible = [...jobs.filter(active), ...jobs.filter(job => !active(job)).slice(0, 3)];
  const html = visible.map(job => {
    const label = job.status === "done" ? "已入库" : job.status === "failed" ? "生成失败" :
      job.status === "running" ? `生成 ${job.progress}%` : job.status === "submitting" ? "提交中" : "排队中";
    const tone = job.status === "done" ? "success" : job.status === "failed" ? "error" : "active";
    return `<div class="exportRow"><strong>${escape(job.name)}</strong><span class="spacer"></span>
      <span class="status ${tone}">${label}</span>
      ${job.status === "running" ? `<progress max="100" value="${job.progress}" aria-label="生图进度"></progress>` : ""}
      ${job.status === "done" ? `<a class="button compact" href="${media(job.id)}" target="_blank" rel="noopener">查看图片</a>` : ""}
      ${job.status === "failed" ? button("generateImage", "重试", "compact", job.id) : ""}
      ${job.error ? `<p class="notice">${escape(job.error)}</p>` : ""}</div>`;
  }).join("");
  if (target.dataset.rendered !== html) { target.innerHTML = html; target.dataset.rendered = html; }
}

function updateGallery() {
  const assets = state.assets.filter(item => (filter === "全部" || item.kind === filter) && item.name.toLowerCase().includes(search.toLowerCase())).reverse();
  query("#assetList")!.innerHTML = assets.length ? `<div class="gallery">${assets.map(item => {
    const name = escape(item.name);
    const address = media(item.id);
    const preview = item.kind === "配音" ? `<div class="assetPreview audio"><audio preload="none" controls src="${address}" aria-label="${name}"></audio></div>`
      : item.kind === "视频" ? `<div class="assetPreview"><video controls playsinline preload="none" src="${address}" aria-label="${name}"></video></div>`
      : `<div class="assetPreview"><img src="${address}" alt="${name}" loading="lazy"></div>`;
    return `<article class="assetCard">${preview}<div class="assetLabel"><strong title="${name}">${name}</strong><small>${item.kind}</small>
      ${button("renameAsset", "编辑", "compact", item.id)}</div></article>`;
  }).join("")}</div>` : empty("没有符合条件的素材", "可以导入新文件，或调整搜索条件。");
}

function renderShots(item: Episode) {
  if (!item.shots.length) {
    page.innerHTML = empty("开始拆分镜头", "逐镜头填写画面和台词，或从现成的分镜文本批量导入。",
      `<div class="actions" style="justify-content:center">${button("addShot", "＋ 新建镜头", "primary")}${button("bulk", "粘贴分镜")}</div>`);
    return;
  }
  const shot = currentShot()!;
  page.innerHTML = `<div class="strip">${button("bulk", "粘贴分镜")}${button("markAll", "选择待生成")}
    <span id="shotStats" class="stats"></span><span class="spacer"></span>
    ${button("batch", "将所选加入队列", "primary")}</div>
    <div class="split"><div class="sheet"><div class="sheetHead"><h3>镜头顺序</h3><small>拖动排序</small></div><div id="shotRows" class="shotRows"></div></div>
    <article class="sheet"><div class="sheetHead"><h3>镜头 ${numberLabel(item.shots.indexOf(shot))}</h3>
      <div class="actions">${button("moveUp", "上移", "compact", shot.id, item.shots[0] === shot)}
      ${button("moveDown", "下移", "compact", shot.id, item.shots.at(-1) === shot)}
      ${button("duplicate", "复制", "compact")}${button("removeShot", "移除", "compact danger")}<span id="shotGenerate"></span></div></div>
      <div class="details">
        <form id="shotForm" class="fieldStack">
          <div class="fieldGrid"><label class="field"><span>镜头名称</span><input name="title" required maxlength="100" value="${escape(shot.title)}"></label>
            <label class="field"><span>生成秒数</span><input name="duration" type="number" min="1" max="30" required value="${shot.duration}"></label></div>
          <label class="field"><span>视频提示词</span><textarea name="prompt" maxlength="12000" rows="4" placeholder="写人物动作、景别和运镜">${escape(shot.prompt)}</textarea></label>
          <div><h3>参考图</h3><div class="refGrid">${shot.refs.map((id, index) => {
            const image = asset(id)!;
            return `<div class="refChip"><img src="${media(id)}" alt=""><button type="button" class="compact" data-action="mention" data-id="${index + 1}" title="插入引用">[图${index + 1}] ${escape(image.name)}</button>
            <button type="button" class="compact danger" aria-label="移除 ${escape(image.name)}" data-action="removeRef" data-id="${id}">×</button></div>`;
          }).join("")}</div>${button("refs", "＋ 选择参考图", "compact")}</div>
          <label class="field"><span>台词 / 字幕</span><textarea name="dialogue" rows="2" maxlength="3000" placeholder="填写此镜头的台词或字幕">${escape(shot.dialogue)}</textarea></label>
          <div class="actions">${button("saveShot", "保存镜头", "compact")}<small id="saveState">自动保存</small></div>
        </form>
        <hr class="rule">
        <div class="actions"><h3>视频版本</h3><span class="spacer"></span>${button("pickClip", "选用已有视频", "compact")}</div>
        <div id="shotResult" class="resultMeta"></div>
      </div>
    </article></div>`;
  updateShots();
}

function updateShots() {
  const item = episode();
  const shot = currentShot();
  const rows = query("#shotRows");
  if (!item || !shot || !rows) return;
  const rowsHtml = item.shots.map((value, index) => {
    const image = value.refs[0];
    const [label, tone] = status(value);
    return `<div class="shotRow ${value.id === shotId ? "selected" : ""}" draggable="true" data-shot="${value.id}">
      <input type="checkbox" aria-label="选择 ${escape(value.title)}" data-mark="${value.id}" ${checked(marked.has(value.id))}>
      <span class="mono muted">${numberLabel(index)}</span><span class="shotThumb">${image ? `<img src="${media(image)}" loading="lazy" alt="">` : "▧"}</span>
      <button type="button" class="shotName" data-action="focusShot" data-id="${value.id}" title="${escape(value.title)}">${escape(value.title)}</button>
      <span class="status ${tone}">${label}</span></div>`;
  }).join("");
  if (rows.dataset.rendered !== rowsHtml && !dragged) { rows.innerHTML = rowsHtml; rows.dataset.rendered = rowsHtml; }
  query("#shotStats")!.textContent = `${item.shots.length} 镜 · 已选版 ${item.shots.filter(value => value.clip).length} · 勾选 ${marked.size}`;
  query<HTMLButtonElement>('[data-action="batch"]', page)!.disabled = !marked.size;
  const job = latestJob(shot.id);
  const generate = query("#shotGenerate")!;
  const generateButton = button("generate", active(job) ? "已加入队列" : job?.status === "failed" ? "重试生成" : "用 Muse 生成", "primary compact", "", active(job));
  if (generate.dataset.rendered !== generateButton) {
    generate.innerHTML = generateButton;
    generate.dataset.rendered = generateButton;
  }
  const result = query("#shotResult")!;
  const resultKey = JSON.stringify([shot.versions, shot.clip, job?.status, job?.error]);
  if (result.dataset.rendered === resultKey) return;
  const playback = query<HTMLVideoElement>("video", result);
  const shownVideo = playback?.dataset.clip;
  const preserved = shownVideo && shownVideo === shot.clip ? playback : null;
  result.innerHTML = `${job?.error ? `<p class="notice">${escape(job.error)}</p>` : ""}
    ${shot.versions.length ? `<label class="field"><span>当前选用</span><select id="versionSelect">${shot.versions.map((id, index) =>
      `<option value="${id}" ${selected(shot.clip === id)}>版本 ${index + 1} · ${escape(asset(id)?.name || "视频")}</option>`).join("")}</select></label>` : ""}
    ${shot.clip ? '<div class="videoFrame" style="margin-top:10px"></div>' : '<p class="muted">Muse 生成的视频和手动选用的素材会出现在这里。</p>'}`;
  if (shot.clip) {
    const frame = query(".videoFrame", result)!;
    if (preserved) frame.append(preserved);
    else frame.innerHTML = `<video controls playsinline preload="metadata" data-clip="${shot.clip}" src="${media(shot.clip)}"></video>`;
  }
  result.dataset.rendered = resultKey;
}

function renderFilm(item: Episode) {
  if (!item.shots.length) {
    page.innerHTML = empty("还没有镜头", "先在分镜台添加镜头，生成或导入视频。", button("section", "去分镜台", "primary", "shots"));
    return;
  }
  const ready = item.shots.filter(shot => shot.clip).length;
  page.innerHTML = `<div class="strip"><strong>已选版 ${ready} / ${item.shots.length}</strong><span class="spacer"></span>
    <label><input type="checkbox" id="burn" checked> 将字幕压进视频</label>
    ${button("export", "导出整集", "primary", "", ready !== item.shots.length || !state.settings.canExport)}
    ${!state.settings.canExport ? '<span class="notice">请安装 FFmpeg 与 FFprobe</span>' : ""}</div>
    <div class="filmGrid"><article class="sheet"><div class="sheetHead"><h3>剪辑顺序</h3></div><ol class="filmRows">${item.shots.map((shot, index) => {
      const clip = asset(shot.clip);
      const length = clip ? ((shot.end || clip.duration || 0) - shot.start).toFixed(2) : "";
      return `<li class="filmRow" draggable="true" data-shot="${shot.id}"><span class="mono muted">${numberLabel(index)}</span>
        <div><h3>${escape(shot.title)}</h3>${shot.dialogue ? `<p>${escape(shot.dialogue)}</p>` : ""}
        <small>${clip ? `${length} 秒 · ${shot.voice ? escape(asset(shot.voice)?.name) : shot.mute ? "静音" : "原声"}` : "尚未选版"}</small></div>
        <div class="actions">${button("previewShot", "预览", "compact", shot.id, !clip)}${button("editCut", "剪辑", "compact", shot.id, !clip)}
        ${button("moveUp", "↑", "compact", shot.id, index === 0)}${button("moveDown", "↓", "compact", shot.id, index === item.shots.length - 1)}</div></li>`;
    }).join("")}</ol></article>
    <article class="sheet"><div class="sheetHead"><h3 id="previewTitle">整集预览</h3>${button("playAll", "▷ 按顺序播放", "compact", "", !ready)}</div>
    <div class="details"><div class="videoFrame"><video id="filmVideo" controls playsinline preload="metadata"></video></div><audio id="filmAudio"></audio>
    <p id="liveCaption" class="liveCaption"></p><hr class="rule"><h3>导出记录</h3><div id="exports" class="exportList"></div></div></article></div>`;
  const first = item.shots.findIndex(shot => shot.clip);
  if (first >= 0) cueFilm(first, false);
  updateExports();
}

function updateExports() {
  const target = query("#exports");
  if (!target) return;
  const exports = state.films.filter(film => film.episode === episodeId).reverse();
  const html = exports.length ? exports.map((film, index) =>
    `<div class="exportRow"><span>${escape(film.name)} · 第 ${exports.length - index} 版</span>
      ${film.status === "done" ? `<div class="actions"><a class="button compact" href="/api/films/${film.id}/mp4?download">MP4</a>
      ${film.subtitles ? `<a class="button compact" href="/api/films/${film.id}/srt">SRT</a>` : ""}</div>`
      : film.status === "running" ? `<span>导出 ${film.progress}% <progress max="100" value="${film.progress}"></progress></span>`
      : `<span class="notice">${escape(film.error || "导出失败")}</span>`}</div>`).join("")
    : '<small>导出后的文件会显示在这里。</small>';
  if (target.dataset.rendered !== html) { target.innerHTML = html; target.dataset.rendered = html; }
  const trigger = query<HTMLButtonElement>('[data-action="export"]', page)!;
  trigger.disabled = state.films.some(film => film.status === "running") || !state.settings.canExport || Boolean(episode()?.shots.some(shot => !shot.clip));
}

function cueFilm(position: number, play: boolean) {
  const shot = episode()?.shots[position];
  const video = query<HTMLVideoElement>("#filmVideo");
  const audio = query<HTMLAudioElement>("#filmAudio");
  if (!shot?.clip || !video || !audio) return;
  previewPosition = position;
  video.pause();
  audio.pause();
  video.muted = shot.mute || !!shot.voice;
  audio.removeAttribute("src");
  if (shot.voice) audio.src = media(shot.voice);
  query("#previewTitle")!.textContent = `${numberLabel(position)} · ${shot.title}`;
  query("#liveCaption")!.textContent = shot.dialogue;
  let advanced = false;
  video.onloadedmetadata = () => {
    video.currentTime = shot.start;
    if (play) void video.play().catch(() => {});
  };
  const next = () => {
    if (advanced) return;
    advanced = true;
    const nextPosition = episode()?.shots.findIndex((value, index) => index > previewPosition && value.clip) ?? -1;
    if (previewPlaying && nextPosition >= 0) cueFilm(nextPosition, true);
    else { video.pause(); audio.pause(); previewPlaying = false; }
  };
  video.onended = next;
  video.ontimeupdate = () => { if (shot.end && video.currentTime >= shot.end) next(); };
  video.onplay = () => {
    if (advanced) { advanced = false; video.currentTime = shot.start; }
    if (shot.voice) {
      audio.currentTime = Math.max(0, video.currentTime - shot.start);
      void audio.play().catch(() => {});
    }
  };
  video.onpause = () => audio.pause();
  video.onseeked = () => { if (shot.voice) audio.currentTime = Math.max(0, video.currentTime - shot.start); };
  video.src = media(shot.clip);
}

function showDialog(title: string, fields: string, label: string, save: (data: FormData) => Promise<void>) {
  modalAction = save;
  modalForm.innerHTML = `<h2>${escape(title)}</h2><div class="fieldStack">${fields}</div>
    <div class="actions">${button("closeModal", "取消")}<button class="primary" type="submit">${escape(label)}</button></div>`;
  modal.showModal();
}

function field(label: string, control: string) {
  return `<label class="field"><span>${escape(label)}</span>${control}</label>`;
}

function episodeDialog(item?: Episode) {
  showDialog(item ? "剧集设置" : "新建一集",
    field("剧集名称", `<input name="name" required maxlength="100" value="${escape(item?.name)}" placeholder="例如 第 01 集 · 离家" autofocus>`) +
    field("画幅", `<select name="ratio">${["9:16", "16:9", "1:1"].map(value =>
      `<option ${selected(value === item?.ratio)}>${value}</option>`).join("")}</select>`), item ? "保存" : "创建剧集", async data => {
    const saved = await api<Episode>(item ? episodeUrl() : "/api/episodes", item ? "PATCH" : "POST", Object.fromEntries(data));
    if (!item) selectEpisode(saved.id);
    section = "shots";
    modal.close();
    await refresh();
  });
}

function selectEpisode(id: string) {
  episodeId = id;
  shotId = "";
  marked = new Set();
  localStorage.setItem("dramaEpisode", id);
}

async function saveDraft() {
  const form = query<HTMLFormElement>("#shotForm");
  if (!dirty || !form) return;
  if (!form.reportValidity()) throw new Error("请完成镜头名称和时长");
  const values = new FormData(form);
  const revision = draftRevision;
  const patch = {
    title: String(values.get("title")), duration: Number(values.get("duration")),
    prompt: String(values.get("prompt")), dialogue: String(values.get("dialogue")),
  };
  const saved = await api<Shot>(shotUrl(), "PATCH", patch);
  const shot = currentShot();
  if (shot) Object.assign(shot, saved);
  if (draftRevision === revision) {
    dirty = false;
    query("#saveState")!.textContent = "已保存";
  }
  updateShots();
}

function scheduleSave() {
  dirty = true;
  draftRevision++;
  query("#saveState")!.textContent = "待保存";
  window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    if (query<HTMLFormElement>("#shotForm")?.checkValidity()) void run(saveDraft);
  }, 650);
}

async function addShots(shots: (Pick<Shot, "title" | "prompt"> & Partial<Pick<Shot, "dialogue" | "duration">>)[]) {
  const added = await api<Shot[]>(episodeUrl("/shots"), "POST", { shots });
  shotId = added[0].id;
  await refresh();
}

function bulkDialog() {
  showDialog("粘贴分镜", field("每行一镜。可用竖线或 Tab 分隔镜头名、提示词、台词和秒数",
    '<textarea name="lines" rows="9" maxlength="120000" required placeholder="雨夜街口｜女孩撑伞经过路灯，镜头缓慢推近｜你来了吗？｜6"></textarea>'),
  "导入分镜", async data => {
    const lines = String(data.get("lines")).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) throw new Error("至少输入一行");
    const shots = lines.map((line, index) => {
      const cells = line.split(/[｜|\t]/).map(cell => cell.trim());
      const fallback = `镜头 ${numberLabel((episode()?.shots.length ?? 0) + index)}`;
      if (cells.length === 1) return { title: fallback, prompt: line };
      const [title, prompt, dialogue, seconds] = cells;
      const duration = seconds ? Number(seconds) : undefined;
      if (cells.length > 4 || duration !== undefined && (!Number.isInteger(duration) || duration < 1 || duration > 30)) {
        throw new Error(`第 ${index + 1} 行的格式有误，生成秒数可留空或填写 1–30 的整数`);
      }
      return { title: title || fallback, prompt, dialogue, duration };
    });
    await addShots(shots);
    modal.close();
    announce(`已导入 ${shots.length} 个镜头`);
  });
}

async function addAsset(source: File, kind?: string) {
  const data = new FormData();
  data.set("file", source);
  if (kind) data.set("kind", kind);
  return api<Asset>("/api/assets", "POST", data);
}

function imageDialog(job?: ImageJob) {
  showDialog("Muse 生图",
    field("提示词", `<textarea name="prompt" rows="4" maxlength="12000" required autofocus placeholder="描述人物、画面和风格">${escape(job?.prompt)}</textarea>`) +
    field("素材名称（选填）", `<input name="name" maxlength="100" value="${escape(job?.name)}" placeholder="例如 雨夜街口">`) +
    `<div class="fieldGrid even">
    ${field("素材分类", `<select name="category">${assetKinds.map(kind => `<option ${selected(kind === (job?.category || filter))}>${kind}</option>`).join("")}</select>`)}
    ${field("画幅", `<select name="ratio">${["1:1", "9:16", "16:9"].map(ratio => `<option ${selected(ratio === job?.ratio)}>${ratio}</option>`).join("")}</select>`)}
    </div>`, "生成图片", async data => {
      await api("/api/muse/image", "POST", Object.fromEntries(data));
      modal.close();
      await load();
      updateImageTasks();
      updateGallery();
      announce("生图任务已加入 Muse 队列");
    });
}

async function upload(files: FileList, kind: string) {
  const rejected: string[] = [];
  let added = 0;
  for (const source of files) {
    try { await addAsset(source, kind); added++; }
    catch (error) { rejected.push(`${source.name}：${error instanceof Error ? error.message : "导入失败"}`); }
  }
  await load();
  updateGallery();
  announce(`已导入 ${added} 个素材${rejected.length ? `。失败 ${rejected.length} 个。 ${rejected[0]}` : ""}`, Boolean(rejected.length));
}

async function replaceReferences(next: string[]) {
  const shot = currentShot()!;
  const prompt = shot.prompt.replace(/\[图(\d+)\]/g, (marker, position: string) => {
    const original = shot.refs[+position - 1];
    if (!original) return marker;
    const index = next.indexOf(original);
    return index >= 0 ? `[图${index + 1}]` : asset(original)?.name || "";
  });
  await api(shotUrl(), "PATCH", { refs: next, prompt });
  await refresh();
}

function refsDialog() {
  const shot = currentShot()!;
  const assets = state.assets.filter(value => value.mime.startsWith("image/"));
  const list = assets.length ? assets.map(item =>
    `<label class="pick"><input type="checkbox" name="refs" value="${item.id}" ${checked(shot.refs.includes(item.id))}>
    <img src="${media(item.id)}" alt=""><span>${escape(item.name)}</span><small>${item.kind}</small></label>`).join("")
    : '<p class="muted">可从下方导入参考图。</p>';
  showDialog("选择参考图", `<div class="pickList">${list}</div>` + field("添加新图片",
    '<input name="newImage" type="file" accept="image/png,image/jpeg,image/webp" multiple>') +
    field("新图片分类", `<select name="kind">${assetKinds.map(kind => `<option>${kind}</option>`).join("")}</select>`),
  "应用参考图", async data => {
    const ids = data.getAll("refs").map(String);
    const pending = data.getAll("newImage").filter((source): source is File => source instanceof File && source.size > 0);
    if (ids.length + pending.length > 10) throw new Error("每个镜头最多 10 张参考图");
    for (const source of pending) ids.push((await addAsset(source, String(data.get("kind")))).id);
    const next = [...shot.refs.filter(id => ids.includes(id)), ...ids.filter(id => !shot.refs.includes(id))];
    await replaceReferences(next);
    modal.close();
  });
}

function clipDialog() {
  showDialog("选用已有视频",
    field("从素材库选用", `<select name="clip"><option value="">选择视频</option>${state.assets.filter(item => item.kind === "视频").map(item =>
      `<option value="${item.id}">${escape(item.name)} · ${item.duration?.toFixed(1)} 秒</option>`).join("")}</select>`) +
    field("或导入本地视频", '<input type="file" name="file" accept="video/mp4,video/quicktime,video/webm">'), "采用这个版本", async data => {
    const source = data.get("file");
    const clip = source instanceof File && source.size ? (await addAsset(source)).id : String(data.get("clip"));
    if (!clip) throw new Error("请选择视频");
    await api(shotUrl(), "PATCH", { clip });
    modal.close();
    await refresh();
  });
}

function cutDialog(id: string) {
  const shot = episode()?.shots.find(item => item.id === id);
  const clip = asset(shot?.clip || "");
  if (!shot || !clip) return;
  showDialog(`剪辑 · ${shot.title}`, `<p class="muted">原片 ${clip.duration?.toFixed(2)} 秒，结束留空时保留到片尾。</p>
    <div class="fieldGrid even">${field("开始（秒）", `<input type="number" name="start" min="0" step="0.01" value="${shot.start}">`)}
    ${field("结束（秒）", `<input type="number" name="end" min="0.01" step="0.01" value="${shot.end || ""}">`)}</div>` +
    field("字幕", `<textarea name="dialogue" rows="2" maxlength="3000">${escape(shot.dialogue)}</textarea>`) +
    field("选择配音", `<select name="voice"><option value="">无外部配音</option>${state.assets.filter(value => value.kind === "配音").map(value =>
      `<option value="${value.id}" ${selected(value.id === shot.voice)}>${escape(value.name)}</option>`).join("")}</select>`) +
    field("或导入配音", '<input name="file" type="file" accept="audio/*">') +
    `<label><input name="mute" type="checkbox" ${checked(shot.mute)}> 无配音时静音</label>`, "应用剪辑", async data => {
    const source = data.get("file");
    const voice = source instanceof File && source.size ? (await addAsset(source)).id : String(data.get("voice"));
    await api(shotUrl(id), "PATCH", { start: Number(data.get("start")), end: Number(data.get("end")), dialogue: String(data.get("dialogue")), voice, mute: data.has("mute") });
    modal.close();
    await refresh();
  });
}

async function assessMuse() {
  try { await api("/api/muse/check", "POST"); muse = "ready"; }
  catch { muse = "offline"; }
  updateRail();
}

function settingsDialog() {
  const config = state.settings;
  showDialog("Muse 设置",
    field("Base URL", `<input name="baseUrl" type="url" required value="${escape(config.baseUrl)}">`) +
    field("视频模型", `<input name="model" required value="${escape(config.model)}">`) +
    field("API Key", `<input name="apiKey" type="password" autocomplete="off" placeholder="${config.connected ? "已设置，留空沿用" : "填写 Muse API Key"}">`),
  "保存并测试", async data => {
    await api("/api/settings", "PUT", Object.fromEntries(data));
    modal.close();
    await load();
    await assessMuse();
    announce(muse === "ready" ? "Muse 连接成功" : "设置已保存。Muse 当前未连接，请核对地址和服务状态。", muse !== "ready");
  });
}

async function queue(ids: string[]) {
  const { accepted } = await api<{ accepted: number }>(episodeUrl("/generate"), "POST", { ids });
  ids.forEach(id => marked.delete(id));
  await load();
  updateShots();
  announce(`已将 ${accepted} 个镜头加入 Muse 队列`);
}

async function moveShot(id: string, position: number) {
  const ids = episode()!.shots.map(shot => shot.id);
  if (position < 0 || position >= ids.length) return;
  ids.splice(ids.indexOf(id), 1);
  ids.splice(position, 0, id);
  await api(episodeUrl("/order"), "PUT", { ids });
  await refresh();
}

const actions: Record<string, (id: string) => unknown> = {
  newEpisode: () => episodeDialog(),
  editEpisode: () => episodeDialog(episode()),
  settings: settingsDialog,
  section: id => { section = id as Section; render(); },
  closeModal: () => modal.close(),
  filter: id => {
    filter = id;
    for (const node of page.querySelectorAll<HTMLElement>(".filter")) node.setAttribute("aria-pressed", String(node.dataset.id === id));
    if (assetKinds.includes(id)) query<HTMLSelectElement>("#importKind")!.value = id;
    updateGallery();
  },
  importAssets: () => query<HTMLInputElement>("#assetInput")?.click(),
  generateImage: id => {
    const job = state.jobs.find(item => item.id === id);
    imageDialog(job?.kind === "image" ? job : undefined);
  },
  renameAsset: id => {
    const item = asset(id)!;
    showDialog("编辑素材", field("名称", `<input name="name" required maxlength="100" value="${escape(item.name)}">`) +
      (assetKinds.includes(item.kind) ? field("分类", `<select name="kind">${assetKinds.map(kind => `<option ${selected(item.kind === kind)}>${kind}</option>`).join("")}</select>`) : ""),
    "保存", async data => {
      await api(media(id), "PATCH", Object.fromEntries(data));
      modal.close();
      await load();
      updateGallery();
    });
  },
  addShot: () => addShots([{ title: `镜头 ${numberLabel(episode()!.shots.length)}`, prompt: "" }]).then(() => query<HTMLInputElement>('#shotForm [name="title"]')?.select()),
  bulk: bulkDialog,
  focusShot: id => { if (shotId !== id) { shotId = id; render(); } },
  saveShot: () => announce("镜头已保存"),
  refs: refsDialog,
  removeRef: id => replaceReferences(currentShot()!.refs.filter(value => value !== id)),
  mention: id => {
    const prompt = query<HTMLTextAreaElement>('#shotForm [name="prompt"]')!;
    prompt.setRangeText(`[图${id}]`, prompt.selectionStart, prompt.selectionEnd, "end");
    prompt.focus();
    scheduleSave();
  },
  duplicate: async () => {
    const added = await api<Shot>(`${shotUrl()}/duplicate`, "POST");
    shotId = added.id;
    await refresh();
  },
  removeShot: () => {
    const id = shotId;
    showDialog("移除镜头", `<p>从本集移除「${escape(currentShot()?.title)}」及其分镜设置。视频素材仍可在素材库选用。</p>`, "移除", async () => {
      await api(shotUrl(id), "DELETE");
      marked.delete(id);
      modal.close();
      await refresh();
    });
  },
  moveUp: id => moveShot(id, episode()!.shots.findIndex(shot => shot.id === id) - 1),
  moveDown: id => moveShot(id, episode()!.shots.findIndex(shot => shot.id === id) + 1),
  markAll: () => {
    marked = new Set(episode()!.shots.filter(shot => shot.prompt.trim() && !shot.clip && !active(latestJob(shot.id))).map(shot => shot.id));
    updateShots();
  },
  batch: () => queue([...marked]),
  generate: () => queue([shotId]),
  pickClip: clipDialog,
  editCut: cutDialog,
  previewShot: id => {
    previewPlaying = false;
    cueFilm(episode()!.shots.findIndex(shot => shot.id === id), true);
  },
  playAll: () => {
    previewPlaying = true;
    cueFilm(episode()!.shots.findIndex(shot => shot.clip), true);
  },
  export: async () => {
    const burn = query<HTMLInputElement>("#burn")!.checked;
    await api(episodeUrl("/export"), "POST", { burn });
    await load();
    updateExports();
    announce("正在导出整集");
  },
};

document.addEventListener("click", event => {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLElement>("[data-action]");
  const row = target.closest<HTMLElement>(".shotRow");
  const action = button?.dataset.action || (row && !target.closest("input") ? "focusShot" : "");
  const id = button?.dataset.id || row?.dataset.shot || "";
  if (!state || !action || !actions[action]) return;
  void run(async () => {
    if (action !== "mention" && action !== "closeModal") await saveDraft();
    await actions[action](id);
  });
});

document.addEventListener("input", event => {
  const target = event.target as HTMLInputElement;
  if (target.closest("#shotForm")) scheduleSave();
  if (target.id === "assetSearch") { search = target.value; updateGallery(); }
});

document.addEventListener("change", event => {
  const target = event.target as HTMLInputElement;
  if (target.id === "episodeSelect") void run(async () => {
    try { await saveDraft(); }
    catch (error) { episodeSelect.value = episodeId; throw error; }
    selectEpisode(target.value);
    render();
  });
  if (target.dataset.mark) {
    if (target.checked) marked.add(target.dataset.mark); else marked.delete(target.dataset.mark);
    updateShots();
  }
  if (target.id === "assetInput" && target.files?.length) {
    const input = target.files;
    const kind = query<HTMLSelectElement>("#importKind")!.value;
    void run(async () => { await upload(input, kind); target.value = ""; });
  }
  if (target.id === "versionSelect") void run(async () => {
    const clip = target.value;
    await saveDraft();
    await api(shotUrl(), "PATCH", { clip });
    await load();
    updateShots();
  });
});

document.addEventListener("submit", event => {
  event.preventDefault();
  if (event.target === modalForm && modalAction) {
    const save = modalAction;
    void run(() => save(new FormData(modalForm)));
  } else if ((event.target as HTMLElement).id === "shotForm") void run(async () => { await saveDraft(); announce("镜头已保存"); });
});

page.addEventListener("dragstart", event => {
  const row = (event.target as HTMLElement).closest<HTMLElement>("[data-shot]");
  if (!row || !event.dataTransfer) return;
  dragged = row.dataset.shot!;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", dragged);
});
page.addEventListener("dragover", event => {
  const target = event.target as HTMLElement;
  const zone = target.closest("#assetDrop");
  const row = target.closest<HTMLElement>("[data-shot]");
  if (zone && event.dataTransfer?.types.includes("Files")) { event.preventDefault(); zone.classList.add("over"); }
  if (dragged && row) {
    event.preventDefault();
    page.querySelector(".dragOver")?.classList.remove("dragOver");
    row.classList.add("dragOver");
  }
});
page.addEventListener("dragleave", event => {
  const zone = (event.target as HTMLElement).closest("#assetDrop");
  if (zone && !zone.contains(event.relatedTarget as Node)) zone.classList.remove("over");
});
page.addEventListener("dragend", () => { dragged = ""; page.querySelector(".dragOver")?.classList.remove("dragOver"); });
page.addEventListener("drop", event => {
  const target = event.target as HTMLElement;
  const zone = target.closest("#assetDrop");
  const row = target.closest<HTMLElement>("[data-shot]");
  if (zone && event.dataTransfer?.files.length) {
    event.preventDefault();
    zone.classList.remove("over");
    const input = event.dataTransfer.files;
    const kind = query<HTMLSelectElement>("#importKind")!.value;
    const files = new DataTransfer();
    for (const source of input) files.items.add(source);
    void run(() => upload(files.files, kind));
  } else if (dragged && row) {
    event.preventDefault();
    const id = dragged;
    dragged = "";
    row.classList.remove("dragOver");
    if (id !== row.dataset.shot) void run(async () => {
      await saveDraft();
      await moveShot(id, episode()!.shots.findIndex(shot => shot.id === row.dataset.shot));
    });
  }
});

window.addEventListener("beforeunload", event => {
  if (dirty) event.preventDefault();
});
window.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && !modal.open) {
    event.preventDefault();
    if (query("#shotForm")) void run(async () => { await saveDraft(); announce("镜头已保存"); });
  }
});

await refresh().catch(error => announce(error.message, true));
if (state?.settings.connected) void assessMuse();
window.setInterval(() => {
  if (!state || busy || document.hidden) return;
  const pending = state.jobs.some(active) || state.films.some(film => film.status === "running");
  if (!pending) return;
  const previousAssetCount = state.assets.length;
  void load().then(() => {
    if (section === "shots") updateShots();
    if (section === "film") updateExports();
    if (section === "assets") {
      updateImageTasks();
      if (state.assets.length !== previousAssetCount) updateGallery();
    }
  }).catch(() => {});
}, 2400);
