import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safeUploadFilename } from "../core/sources.js";

/**
 * Filesystem side of a CSV upload (PRD FR2): writes the raw bytes under `data/uploads/`.
 * An I/O module (fs), so it lives under `server/store`, not `server/core`. The `platform`
 * row that references the written path is recorded separately by
 * {@link file://./sources.ts}.
 */

/** Default upload root. `data/` is gitignored; tests point this at a tmp dir. */
export const DEFAULT_UPLOADS_DIR = "data/uploads";

export interface SaveUploadInput {
  /** Upload root (e.g. `data/uploads`). */
  dir: string;
  /** Owning project id — files are grouped into a per-project subdirectory. */
  projectId: string;
  /** Source id, prefixed onto the filename so repeat uploads never collide. */
  sourceId: string;
  /** Client-supplied filename; sanitized to a safe basename before use. */
  originalFilename: string;
  /** The raw file bytes. */
  content: Buffer;
}

/**
 * Write an uploaded file to `<dir>/<projectId>/<sourceId>-<safeName>`, creating the parent
 * directory as needed, and return the path written. The filename is sanitized
 * ({@link safeUploadFilename}) so a malicious `../` name cannot escape the upload root.
 */
export async function saveUpload(input: SaveUploadInput): Promise<string> {
  const name = `${input.sourceId}-${safeUploadFilename(input.originalFilename)}`;
  const path = join(input.dir, input.projectId, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, input.content);
  return path;
}
