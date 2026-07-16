import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safeArtifactFilename, type ArtifactKind, type Artifact } from "../core/artifacts.js";
import { insertArtifact } from "../store/artifacts.js";
import type { WarehouseStore } from "../store/duckdb.js";

/**
 * The `read_rules` and `write_artifact` tools (PRD FR6, ARCHITECTURE §5). Both are I/O
 * modules (fs, and `write_artifact` also DuckDB), so they live under `server/tools`, not
 * `server/core`. Neither executes generated code — `read_rules` reads a text document and
 * `write_artifact` writes one into `data/artifacts/` for human review — so both are
 * permission `allow`. The classification/validation is delegated to the pure
 * {@link file://../core/artifacts.ts}.
 */

/** Default artifact root. `data/` is gitignored; routes/tests point this at another dir. */
export const DEFAULT_ARTIFACTS_DIR = "data/artifacts";

/**
 * `read_rules` — read the plain-English transformation rules document at `path` and return
 * its text (FR6). Read-only: it never writes, so its permission is `allow`. A missing or
 * unreadable file propagates the `readFile` error to the caller, which maps it to a response.
 */
export async function readRules(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

/** Fields the `write_artifact` tool needs to persist one artifact to disk + `platform`. */
export interface WriteArtifactInput {
  /** Artifact root (e.g. `data/artifacts`). */
  dir: string;
  /** Owning project id — artifacts are grouped into a per-project subdirectory. */
  projectId: string;
  /** Owning run, or absent when generated during planning (before a run exists). */
  runId?: string | null;
  /** Which kind of artifact this is (rules, plan, transform_sql, …). */
  kind: ArtifactKind;
  /** Client/agent-supplied filename; sanitized to a safe basename before use. */
  name: string;
  /** The artifact text to write. */
  content: string;
}

/**
 * `write_artifact` — write a generated artifact (rules, SQL, DDL, DQ spec, …) to
 * `<dir>/<projectId>/<artifactId>-<safeName>` and record it in `platform.artifacts`, then
 * return the persisted {@link Artifact} (FR6). It does **not** execute anything, so its
 * permission is `allow`. The filename is sanitized ({@link safeArtifactFilename}) so a
 * malicious `../` name cannot escape the artifact root; the content is stored both on disk
 * (the `path`) and inline (the `content`) so the review UI can render it without disk access.
 */
export async function writeArtifact(
  store: WarehouseStore,
  input: WriteArtifactInput,
): Promise<Artifact> {
  const id = randomUUID();
  const filename = `${id}-${safeArtifactFilename(input.name)}`;
  const path = join(input.dir, input.projectId, filename);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, input.content);

  return insertArtifact(store, {
    id,
    projectId: input.projectId,
    runId: input.runId ?? null,
    kind: input.kind,
    path,
    content: input.content,
  });
}
