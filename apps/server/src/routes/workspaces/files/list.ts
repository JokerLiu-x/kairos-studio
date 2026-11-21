import { lstat, readdir } from "@toonflow/file";
import { join, relative, sep } from "node:path";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.get("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().max(4096).optional(), details: z.enum(["true"]).optional() }, "query"), async (req, res) => {
  const { directory, path } = await u.workspaceFile.resolveWorkspaceFile(req, req.query.directory as string, (req.query.path as string | undefined) ?? "");
  const entries = await readdir(path, { withFileTypes: true });
  const items = await Promise.all(entries.filter(entry => entry.isFile() || entry.isDirectory()).map(async entry => {
    const absolutePath = join(path, entry.name);
    const base = { name: entry.name, path: relative(directory, absolutePath).split(sep).join("/"), type: entry.isDirectory() ? "directory" : "file" };
    if (req.query.details !== "true" || !entry.isFile()) return base;
    const info = await lstat(absolutePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    return info?.isFile() ? { ...base, modifiedAt: info.mtimeMs, size: info.size } : base;
  }));
  res.set("Cache-Control", "no-store").json(success({
    directory,
    empty: entries.length === 0,
    entries: items.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true })),
  }));
});
