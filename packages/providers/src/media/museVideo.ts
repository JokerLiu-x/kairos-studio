const rules = [
  { type: "input", field: "baseUrl" as const, title: "API 地址", value: "http://127.0.0.1:18610/v1", props: { placeholder: "http://127.0.0.1:18610/v1" } },
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
] as const;

function mediaUrl(input: MediaInput) {
  if (input.type === "url") return input.url;
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

function pause(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 3000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function readResponse(context: ProviderContext, response: Response) {
  const data = await response.json().catch(() => null) as Record<string, any> | null;
  if (!response.ok) throw new Error(`Muse 接口错误（HTTP ${response.status}）：${context.tool.errorMessage(data) || "请求失败"}`);
  if (!data || typeof data !== "object") throw new Error("Muse 接口返回了无效数据");
  return data;
}

async function poll(context: ProviderContext, baseUrl: string, apiKey: string, kind: "image" | "video", taskId: string, deadline: number): Promise<MediaAsset[]> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("等待 Muse 任务超时，远端任务可能仍在运行，请勿立即重复提交");
  const signal = AbortSignal.any([AbortSignal.timeout(remaining), ...(context.signal ? [context.signal] : [])]);
  const taskPath = kind === "image" ? "images/tasks" : "videos";
  while (true) {
    const response = await context.tool.fetch(`${baseUrl}/${taskPath}/${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
    const data = await readResponse(context, response);
    if (data.status === "failed") throw Object.assign(new Error(context.tool.errorMessage(data.error) || "Muse 生成失败"), { code: "MEDIA_TASK_FAILED" });
    if (["completed", "succeeded", "success", "done"].includes(data.status)) {
      const result = kind === "image" ? data.data?.[0] : data;
      const url = kind === "image" ? result?.url : result?.url || result?.video?.url || result?.result?.url;
      if (typeof url !== "string" || !url) throw new Error("Muse 任务完成但没有返回媒体地址");
      const absoluteUrl = new URL(url, `${baseUrl}/`).toString();
      return [{ mediaType: kind, type: "url", url: absoluteUrl }];
    }
    await pause(signal);
  }
}

export default {
  id: "thirdPartyVideoTemplate",
  label: "第三方视频模型",
  version: "2.0.0",
  rules,
  models: [
    { id: "videoModelTemplate", label: "第三方视频模型", type: "video", mode: ["text", "singleImage"] },
  ],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const baseUrl = this.config.baseUrl.trim().replace(/\/+$/, "");
    const apiKey = this.config.apiKey.trim();
    if (!apiKey || !baseUrl) throw new Error("请填写 Muse API 地址和 API Key");
    if (request.firstFrame || request.lastFrame || request.videos?.length || request.audios?.length || (request.images?.length ?? 0) > 1) throw new Error("当前 Muse 视频适配仅支持文生视频或单张参考图");
    const references = (request as VideoRequest & { referenceOrder?: ({ type: string; index?: number })[] }).referenceOrder;
    const prompt = request.prompt.replace(/\{\{ref (\d+)\}\}/g, (marker, number: string) => {
      const reference = references?.[Number(number) - 1];
      if (reference?.type === "text") return `参考 ${number}`;
      if (reference?.type === "image" && reference.index === 0 && request.images?.[0]) return "[图1]";
      throw new Error(`无法识别参考标记 ${marker}，请重新选择参考素材`);
    });
    const deadline = Date.now() + 20 * 60_000;
    const signal = AbortSignal.any([AbortSignal.timeout(20 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const response = await this.tool.fetch(`${baseUrl}/videos`, {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ model: request.model, prompt, aspect_ratio: request.ratio, duration: request.duration, resolution: request.resolution, images: request.images?.map(mediaUrl) }),
    });
    const data = await readResponse(this, response);
    const taskId = data.task_id || data.id;
    if (typeof taskId !== "string" || !taskId) throw new Error("Muse 未返回视频任务 ID");
    await this.saveTaskData?.({ kind: "video", taskId, deadline, baseUrlHash: String(this.tool.hash(baseUrl)) });
    return poll(this, baseUrl, apiKey, "video", taskId, deadline);
  },
  async resumeTask(data: ProviderTaskData): Promise<MediaAsset[]> {
    const baseUrl = this.config.baseUrl.trim().replace(/\/+$/, "");
    const apiKey = this.config.apiKey.trim();
    if (!apiKey || !baseUrl || data.kind !== "video" || typeof data.taskId !== "string" || typeof data.deadline !== "number" || data.baseUrlHash !== String(this.tool.hash(baseUrl))) throw new Error("Muse 任务恢复数据无效或连接配置已变更");
    return poll(this, baseUrl, apiKey, data.kind, data.taskId, data.deadline);
  },
} satisfies ProviderDefinition<typeof rules>;
