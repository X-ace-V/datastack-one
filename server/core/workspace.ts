import { z } from "zod";

/** Data/project files the local data-engineering workspace understands. */
export const WORKSPACE_FILE_KINDS = [
  "csv",
  "tsv",
  "json",
  "jsonl",
  "parquet",
  "sql",
  "yaml",
  "markdown",
  "text",
] as const;
export type WorkspaceFileKind = (typeof WORKSPACE_FILE_KINDS)[number];

const EXTENSION_KIND: Readonly<Record<string, WorkspaceFileKind>> = {
  csv: "csv",
  tsv: "tsv",
  json: "json",
  jsonl: "jsonl",
  ndjson: "jsonl",
  parquet: "parquet",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  markdown: "markdown",
  txt: "text",
};

/** Return the supported kind for a filename/path, or null when it is intentionally ignored. */
export function workspaceFileKind(path: string): WorkspaceFileKind | null {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  return EXTENSION_KIND[name.slice(dot + 1).toLowerCase()] ?? null;
}

export function isQueryableWorkspaceKind(kind: WorkspaceFileKind): boolean {
  return ["csv", "tsv", "json", "jsonl", "parquet"].includes(kind);
}

export function isTextWorkspaceKind(kind: WorkspaceFileKind): boolean {
  return ["sql", "yaml", "json", "jsonl", "markdown", "text"].includes(kind);
}

/** Filenames never exposed to the agent even when their extension is otherwise supported. */
export function isSensitiveWorkspaceName(path: string): boolean {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === "profiles.yml" ||
    name === "profiles.yaml" ||
    name === "credentials.json" ||
    name === ".npmrc" ||
    name === ".pypirc"
  );
}

export const SessionFolderSchema = z.object({
  sessionId: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  /** True only when OpenCode created this session with `path` as its immutable cwd. */
  workspaceRoot: z.boolean(),
  connectedAt: z.string().min(1),
});
export type SessionFolder = z.infer<typeof SessionFolderSchema>;

export const WorkspaceFileSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(WORKSPACE_FILE_KINDS),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string().min(1),
  queryable: z.boolean(),
  sourceName: z.string().min(1).optional(),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;

export const FolderEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});
export type FolderEntry = z.infer<typeof FolderEntrySchema>;

export const ConnectFolderRequestSchema = z.object({
  path: z.string().trim().min(1),
});

export const WriteWorkspaceFileRequestSchema = z.object({
  sessionID: z.string().min(1),
  path: z.string().trim().min(1),
  content: z.string().max(1024 * 1024),
});

export const ReadWorkspaceFileRequestSchema = z.object({
  sessionID: z.string().min(1),
  path: z.string().trim().min(1),
});

export const ListWorkspaceFilesRequestSchema = z.object({
  sessionID: z.string().min(1),
});
