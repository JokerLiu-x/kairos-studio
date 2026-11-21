const rules = [
  { type: "input", field: "baseUrl" as const, title: "API 地址", value: "", props: { placeholder: "https://api.example.com/v1" } },
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
] as const;

async function referenceBytes(input: MediaInput, context: ProviderContext, signal: AbortSignal) {
  if (input.type === "binary") return Buffer.from(input.data);
  if (input.type === "base64") return Buffer.from(input.data.replace(/^data:[^,]*,/, ""), "base64");
  const response = await context.tool.fetch(input.url, { signal });
  if (!response.ok) throw new Error(`读取参考图失败（HTTP ${response.status}）`);
  return Buffer.from(await response.arrayBuffer());
}

export default {
  id: "thirdPartyImageTemplate",
  label: "第三方图像模型",
  version: "2.0.0",
  rules,
  models: [{ id: "imageModelTemplate", label: "第三方图像模型", type: "image", mode: ["text", "singleImage"], imageRatios: ["1:1", "3:2", "2:3"] }],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const baseUrl = this.config.baseUrl.trim().replace(/\/+$/, "");
    const apiKey = this.config.apiKey.trim();
    if (!baseUrl || !apiKey) throw new Error("请填写 API 地址和 API Key");
    if (request.mask || (request.images?.length ?? 0) > 1) throw new Error("当前接口支持一张参考图，不支持蒙版");
    const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const size = request.ratio === "1:1" ? "1024x1024" : request.ratio === "3:2" ? "1536x1024" : request.ratio === "2:3" ? "1024x1536" : request.size;
    const prompt = request.prompt.replace(/\{\{ref 1\}\}/g, "参考图");
    let response: Response;
    if (request.images?.length) {
      const image = request.images[0]!;
      const bytes = await referenceBytes(image, this, signal);
      const boundary = `toonflow${Date.now()}${Math.random().toString(36).slice(2)}`;
      const field = (name: string, value: string) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
      const mime = image.mimeType || "image/png";
      const parts = [field("model", request.model), field("prompt", prompt)];
      if (size) parts.push(field("size", size));
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="reference.png"\r\nContent-Type: ${mime}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
      response = await this.tool.fetch(`${baseUrl}/images/edits`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": `multipart/form-data; boundary=${boundary}` }, body: Buffer.concat(parts), signal });
    } else {
      response = await this.tool.fetch(`${baseUrl}/images/generations`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: request.model, prompt, ...(size ? { size } : {}) }), signal });
    }
    const data = await response.json().catch(() => null) as { data?: { url?: string; b64_json?: string }[] } | null;
    if (!response.ok) throw new Error(`图片生成失败（HTTP ${response.status}）：${this.tool.errorMessage(data) || "请检查接口配置"}`);
    if (!Array.isArray(data?.data) || !data.data.length) throw new Error("接口未返回图片，请确认服务支持 OpenAI 图片接口");
    return data.data.map(item => {
      if (item.b64_json) {
        const bytes = Buffer.from(item.b64_json, "base64");
        const mimeType = bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : bytes.subarray(0, 4).toString() === "RIFF" ? "image/webp" : "image/png";
        return { mediaType: "image" as const, type: "base64" as const, data: item.b64_json, mimeType };
      }
      if (item.url) {
        const url = new URL(item.url, `${baseUrl}/`);
        if (url.protocol === "http:" || url.protocol === "https:") return { mediaType: "image" as const, type: "url" as const, url: url.toString() };
      }
      throw new Error("接口返回的图片缺少可用地址或数据");
    });
  },
} satisfies ProviderDefinition<typeof rules>;
