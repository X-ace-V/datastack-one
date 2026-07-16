import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRules, writeArtifact } from "./rules.js";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import { getArtifact } from "../store/artifacts.js";
import { ArtifactSchema } from "../core/artifacts.js";

/**
 * Integration tests for the `read_rules` + `write_artifact` tools (T3.1, FR6). They exercise
 * the real I/O — writing to a tmp dir and persisting to an in-memory DuckDB — and assert the
 * desired result: the bytes land on disk under the project subdir, a schema-valid row is
 * recorded with the content inline, a traversal-y name cannot escape the root, and
 * `read_rules` reads exactly what `write_artifact` wrote.
 */
describe("write_artifact + read_rules tools", () => {
  const open: WarehouseStore[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function fixtures() {
    const store = await openStore(":memory:");
    open.push(store);
    const dir = await mkdtemp(join(tmpdir(), "datastack-artifacts-"));
    tmpDirs.push(dir);
    return { store, dir };
  }

  const RULES = "Keep only active loans (status='active').\nBalance must be >= 0.\n";

  it("writes the artifact to disk under the project subdir and records the row", async () => {
    const { store, dir } = await fixtures();

    const artifact = await writeArtifact(store, {
      dir,
      projectId: "p-1",
      kind: "rules",
      name: "rules.txt",
      content: RULES,
    });

    // The returned row is schema-valid and describes what was written.
    expect(ArtifactSchema.parse(artifact)).toEqual(artifact);
    expect(artifact.projectId).toBe("p-1");
    expect(artifact.kind).toBe("rules");
    expect(artifact.runId).toBeNull();
    expect(artifact.content).toBe(RULES);

    // The file lives under <dir>/<projectId>/ and holds exactly the content.
    expect(dirname(artifact.path!)).toBe(join(dir, "p-1"));
    expect(await readFile(artifact.path!, "utf8")).toBe(RULES);

    // And it was persisted to platform.artifacts, readable back by id.
    const stored = await getArtifact(store, artifact.id);
    expect(stored?.content).toBe(RULES);
    expect(stored?.path).toBe(artifact.path);
  });

  it("read_rules reads back exactly what write_artifact wrote", async () => {
    const { store, dir } = await fixtures();
    const artifact = await writeArtifact(store, {
      dir,
      projectId: "p-1",
      kind: "rules",
      name: "rules.txt",
      content: RULES,
    });

    expect(await readRules(artifact.path!)).toBe(RULES);
  });

  it("sanitizes a traversal filename so the write stays under the root", async () => {
    const { store, dir } = await fixtures();
    const artifact = await writeArtifact(store, {
      dir,
      projectId: "p-1",
      kind: "transform_sql",
      name: "../../escape.sql",
      content: "SELECT 1;",
    });

    // The path is confined to <dir>/p-1/ and the traversal segments are gone.
    expect(dirname(artifact.path!)).toBe(join(dir, "p-1"));
    expect(artifact.path).not.toContain("..");
    expect(artifact.path!.endsWith("escape.sql")).toBe(true);
  });

  it("read_rules throws for a missing file", async () => {
    await expect(readRules(join(tmpdir(), "definitely-not-here-3f9a.txt"))).rejects.toThrow();
  });
});
