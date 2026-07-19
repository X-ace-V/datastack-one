import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalWorkspaceService, WorkspaceAccessError } from "./local.js";

describe("local workspace service", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function project() {
    const root = await mkdtemp(join(tmpdir(), "workspace-root-"));
    roots.push(root);
    const folder = join(root, "pipeline");
    await mkdir(join(folder, "models"), { recursive: true });
    return { root, folder, workspace: createLocalWorkspaceService([root]) };
  }

  it("indexes supported data/project files while excluding secrets, generated dirs, and symlinks", async () => {
    const { root, folder, workspace } = await project();
    await writeFile(join(folder, "loans.csv"), "id,amount\n1,10\n");
    await writeFile(join(folder, "models", "daily.sql"), "select 1");
    await writeFile(join(folder, "profiles.yml"), "password: secret");
    await writeFile(join(folder, "notes.bin"), "ignored");
    await mkdir(join(folder, "node_modules"));
    await writeFile(join(folder, "node_modules", "hidden.sql"), "select 'ignored'");
    await symlink(join(root, "outside.csv"), join(folder, "linked.csv"));

    const files = await workspace.scan(folder);
    expect(files.map((file) => file.path)).toEqual(["loans.csv", "models/daily.sql"]);
    expect(files[0]).toMatchObject({ kind: "csv", queryable: true, sourceName: "loans" });
    expect(files[1]).toMatchObject({ kind: "sql", queryable: false });
  });

  it("browses only within configured roots and returns an in-root parent", async () => {
    const { root, folder, workspace } = await project();
    const canonicalRoot = await realpath(root);
    const canonicalFolder = await realpath(folder);
    expect(await workspace.roots()).toEqual([
      { name: canonicalRoot.split("/").pop(), path: canonicalRoot },
    ]);
    const browsed = await workspace.browse(folder);
    expect(browsed.path).toBe(canonicalFolder);
    expect(browsed.parent).toBe(canonicalRoot);
    await expect(workspace.resolveFolder(tmpdir())).rejects.toBeInstanceOf(WorkspaceAccessError);
  });

  it("reads and writes bounded text files without allowing traversal or secret files", async () => {
    const { folder, workspace } = await project();
    await writeFile(join(folder, "models", "daily.sql"), "select 1");
    expect(await workspace.read(folder, "models/daily.sql")).toEqual({
      path: "models/daily.sql",
      content: "select 1",
    });

    await workspace.write(folder, "models/daily.sql", "select 2");
    expect(await readFile(join(folder, "models", "daily.sql"), "utf8")).toBe("select 2");
    await expect(workspace.read(folder, "../escape.sql")).rejects.toBeInstanceOf(
      WorkspaceAccessError,
    );
    await expect(workspace.write(folder, "profiles.yml", "secret")).rejects.toBeInstanceOf(
      WorkspaceAccessError,
    );
    await expect(workspace.write(folder, "models/output.parquet", "not parquet")).rejects.toThrow(
      /text-based/i,
    );
  });
});
