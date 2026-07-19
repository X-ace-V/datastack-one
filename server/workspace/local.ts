import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import {
  isQueryableWorkspaceKind,
  isSensitiveWorkspaceName,
  isTextWorkspaceKind,
  workspaceFileKind,
  type FolderEntry,
  type WorkspaceFile,
  type WorkspaceFileKind,
} from "../core/workspace.js";
import { sourceNameFromRelativePath } from "../core/session-sources.js";

export const MAX_WORKSPACE_FILES = 2_000;
export const MAX_WORKSPACE_DEPTH = 12;
export const MAX_WORKSPACE_READ_BYTES = 1024 * 1024;

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
]);

export class WorkspaceAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceAccessError";
  }
}

export interface LocalWorkspaceService {
  roots(): Promise<FolderEntry[]>;
  browse(path?: string): Promise<{ path: string | null; parent: string | null; folders: FolderEntry[] }>;
  resolveFolder(path: string): Promise<{ name: string; path: string }>;
  scan(folderPath: string): Promise<WorkspaceFile[]>;
  read(folderPath: string, relativePath: string): Promise<{ path: string; content: string }>;
  readRegisteredFile(filePath: string, kind: string): Promise<string>;
  write(folderPath: string, relativePath: string, content: string): Promise<void>;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function createLocalWorkspaceService(
  configuredRoots: string[] = process.env.DATASTACK_FOLDER_ROOTS
    ? process.env.DATASTACK_FOLDER_ROOTS.split(process.platform === "win32" ? ";" : ":")
    : [homedir()],
): LocalWorkspaceService {
  const rootsPromise = Promise.all(
    configuredRoots.filter(Boolean).map(async (root) => realpath(resolve(root))),
  ).then((roots) => [...new Set(roots)]);

  async function allowedRealPath(path: string): Promise<string> {
    let canonical: string;
    try {
      canonical = await realpath(resolve(path));
    } catch {
      throw new WorkspaceAccessError("folder does not exist or cannot be read");
    }
    const roots = await rootsPromise;
    if (!roots.some((root) => isWithin(root, canonical))) {
      throw new WorkspaceAccessError("folder is outside the configured local roots");
    }
    return canonical;
  }

  async function safeFile(folderPath: string, requested: string, mustExist: boolean) {
    if (!requested || isAbsolute(requested)) {
      throw new WorkspaceAccessError("workspace file path must be relative");
    }
    const root = await allowedRealPath(folderPath);
    const candidate = resolve(root, requested);
    if (!isWithin(root, candidate) || isSensitiveWorkspaceName(requested)) {
      throw new WorkspaceAccessError("workspace file path is not allowed");
    }
    if (mustExist) {
      const canonical = await allowedRealPath(candidate);
      if (!isWithin(root, canonical)) throw new WorkspaceAccessError("workspace path escaped root");
      return { root, path: canonical };
    }
    const parent = await allowedRealPath(resolve(candidate, ".."));
    if (!isWithin(root, parent)) throw new WorkspaceAccessError("workspace path escaped root");
    return { root, path: candidate };
  }

  async function scan(folderPath: string): Promise<WorkspaceFile[]> {
    const root = await allowedRealPath(folderPath);
    const files: WorkspaceFile[] = [];

    async function visit(directory: string, depth: number): Promise<void> {
      if (depth > MAX_WORKSPACE_DEPTH || files.length >= MAX_WORKSPACE_FILES) return;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.length >= MAX_WORKSPACE_FILES) return;
        if (entry.isSymbolicLink()) continue;
        const absolute = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".") && !SKIP_DIRECTORIES.has(entry.name)) {
            await visit(absolute, depth + 1);
          }
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = relative(root, absolute).split(sep).join("/");
        const kind = workspaceFileKind(rel);
        if (!kind || isSensitiveWorkspaceName(rel)) continue;
        const info = await stat(absolute);
        const queryable = isQueryableWorkspaceKind(kind);
        files.push({
          path: rel,
          name: entry.name,
          kind,
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
          queryable,
          ...(queryable ? { sourceName: sourceNameFromRelativePath(rel) } : {}),
        });
      }
    }

    await visit(root, 0);
    return files;
  }

  return {
    async roots() {
      return (await rootsPromise).map((path) => ({ name: basename(path) || path, path }));
    },
    async browse(path) {
      if (!path) return { path: null, parent: null, folders: await this.roots() };
      const canonical = await allowedRealPath(path);
      const info = await stat(canonical);
      if (!info.isDirectory()) throw new WorkspaceAccessError("path is not a directory");
      const roots = await rootsPromise;
      const entries = await readdir(canonical, { withFileTypes: true });
      const folders = entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith("."))
        .map((entry) => ({ name: entry.name, path: resolve(canonical, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const root = roots.find((candidate) => isWithin(candidate, canonical));
      const parentCandidate = resolve(canonical, "..");
      const parent = root && isWithin(root, parentCandidate) ? parentCandidate : null;
      return { path: canonical, parent, folders };
    },
    async resolveFolder(path) {
      const canonical = await allowedRealPath(path);
      const info = await stat(canonical);
      if (!info.isDirectory()) throw new WorkspaceAccessError("path is not a directory");
      return { name: basename(canonical) || canonical, path: canonical };
    },
    scan,
    async read(folderPath, relativePath) {
      const target = await safeFile(folderPath, relativePath, true);
      const kind = workspaceFileKind(relativePath);
      if (!kind || !isTextWorkspaceKind(kind)) {
        throw new WorkspaceAccessError("only text-based workspace files can be read as text");
      }
      const info = await stat(target.path);
      if (!info.isFile() || info.size > MAX_WORKSPACE_READ_BYTES) {
        throw new WorkspaceAccessError("workspace file is too large or is not a regular file");
      }
      const content = await readFile(target.path, "utf8");
      return { path: relativePath.split("\\").join("/"), content };
    },
    async readRegisteredFile(filePath, kind) {
      if (!isTextWorkspaceKind(kind as WorkspaceFileKind)) {
        throw new WorkspaceAccessError("this registered source is not a text file");
      }
      const info = await stat(filePath);
      if (!info.isFile() || info.size > MAX_WORKSPACE_READ_BYTES) {
        throw new WorkspaceAccessError("registered file is too large or is not a regular file");
      }
      return readFile(filePath, "utf8");
    },
    async write(folderPath, relativePath, content) {
      const kind = workspaceFileKind(relativePath);
      if (!kind || !isTextWorkspaceKind(kind)) {
        throw new WorkspaceAccessError("only text-based data project files can be written");
      }
      const target = await safeFile(folderPath, relativePath, false);
      await writeFile(target.path, content, "utf8");
    },
  };
}
