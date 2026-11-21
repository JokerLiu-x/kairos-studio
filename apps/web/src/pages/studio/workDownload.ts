import { zip } from "fflate";
import saveFile from "@/lib/saveFile";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import type { QuickWork } from "./useQuickMedia";

const archiveLimit = 90 * 1024 * 1024;

export function workFileName(work: QuickWork) {
  const original = work.path.split("/").at(-1) ?? "work";
  const name = work.details?.name?.replace(/[<>:"/\\|?*\p{Cc}]/gu, "_").trim().replace(/[\s.]+$/u, "");
  if (!name) return original;
  const safeName = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name) ? "_" + name : name;
  return safeName + original.slice(original.lastIndexOf("."));
}

export function downloadWorkArchive(directory: string, selected: readonly QuickWork[]) {
  const tooLarge = "所选作品超过单次打包上限（90 MB），请分批下载。";
  if (selected.reduce((total, work) => total + (work.size ?? 0), 0) > archiveLimit) throw new Error(tooLarge);

  return saveFile(async () => {
    const files = useWorkspaceFiles(directory);
    const entries: Record<string, Uint8Array> = Object.create(null);
    const names = new Set<string>();
    let size = 0;
    for (const work of selected) {
      const content = new Uint8Array(await files.read(work.path));
      size += content.byteLength;
      if (size > archiveLimit) throw new Error(tooLarge);
      const name = workFileName(work);
      const extension = name.lastIndexOf(".");
      let uniqueName = name;
      for (let count = 2; names.has(uniqueName.toLowerCase()); count++) {
        uniqueName = name.slice(0, extension) + " (" + count + ")" + name.slice(extension);
      }
      names.add(uniqueName.toLowerCase());
      entries[uniqueName] = content;
    }
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      zip(entries, { level: 0 }, (error, content) => error ? reject(error) : resolve(content));
    });
    return new Blob([new Uint8Array(bytes)], { type: "application/zip" });
  }, "Toonflow-作品.zip");
}
