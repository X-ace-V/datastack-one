import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { createLocalWorkspaceService } from "./workspace/local.js";
import { createToolApprovalGate, type ToolApprovalGate } from "./opencode/tool-approvals.js";
import type { ApprovalAction } from "./core/approvals.js";
import { SessionManager, type SessionManagerClient } from "./opencode/sessions.js";

describe("per-session folder workspace routes", () => {
  const stores: WarehouseStore[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixtures() {
    const store = await openStore(":memory:");
    stores.push(store);
    const root = await mkdtemp(join(tmpdir(), "app-workspace-"));
    roots.push(root);
    const alpha = join(root, "alpha");
    const beta = join(root, "beta");
    await mkdir(join(alpha, "models"), { recursive: true });
    await mkdir(join(beta, "models"), { recursive: true });
    await writeFile(join(alpha, "loans.csv"), "id,amount\n1,10\n");
    await writeFile(join(alpha, "models", "daily.sql"), "select * from loans");
    await writeFile(join(beta, "loans.csv"), "id,amount\n2,20\n");
    const workspace = createLocalWorkspaceService([root]);
    const client = {
      session: {
        create: vi.fn(async ({ query }: { query?: { directory?: string } }) => ({
          data: {
            id: `ses_${basename(query?.directory ?? "scratch")}`,
            title: "New session",
          },
          error: undefined,
        })),
        update: vi.fn(async () => ({ data: {}, error: undefined })),
        delete: vi.fn(async () => ({ data: true, error: undefined })),
        prompt: vi.fn(async () => ({ data: { info: {}, parts: [] }, error: undefined })),
        abort: vi.fn(async () => ({ data: true, error: undefined })),
        status: vi.fn(async () => ({ data: {}, error: undefined })),
      },
    } as unknown as SessionManagerClient;
    const sessions = new SessionManager(client, store);
    let decision: ApprovalAction = "approve";
    let gate: ToolApprovalGate;
    gate = createToolApprovalGate((event) => {
      if (event.kind === "approval") {
        queueMicrotask(() => gate.reply(event.requestID, decision));
      }
    });
    const app = buildServer({ store, workspace, sessions, toolApprovals: gate });
    return {
      app,
      root,
      alpha,
      beta,
      decide(action: ApprovalAction) {
        decision = action;
      },
    };
  }

  async function startInFolder(app: Awaited<ReturnType<typeof buildServer>>, path: string) {
    return app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { folderPath: path },
    });
  }

  it("starts, indexes, refreshes, and deletes folder-rooted sessions independently", async () => {
    const { app, alpha, beta } = await fixtures();
    const connectAlpha = await startInFolder(app, alpha);
    expect(connectAlpha.statusCode).toBe(201);
    const alphaFolder = await app.inject({ method: "GET", url: "/api/sessions/ses_alpha/folder" });
    expect(alphaFolder.json().folder).toMatchObject({
      name: "alpha",
      workspaceRoot: true,
    });
    expect(alphaFolder.json().folder.path).toBe(await realpath(alpha));
    expect(alphaFolder.json().files.map((file: { path: string }) => file.path)).toEqual([
      "loans.csv",
      "models/daily.sql",
    ]);

    const alphaSources = await app.inject({
      method: "GET",
      url: "/api/sessions/ses_alpha/sources",
    });
    expect(alphaSources.json().sources).toEqual([
      expect.objectContaining({
        sessionId: "ses_alpha",
        name: "loans",
        origin: "folder",
        relativePath: "loans.csv",
      }),
    ]);
    expect(alphaSources.body).not.toContain(alpha);

    const betaSourcesBefore = await app.inject({
      method: "GET",
      url: "/api/sessions/ses_beta/sources",
    });
    expect(betaSourcesBefore.statusCode).toBe(404);
    await startInFolder(app, beta);
    expect(
      (await app.inject({ method: "GET", url: "/api/sessions/ses_beta/sources" })).json()
        .sources[0],
    ).toMatchObject({ sessionId: "ses_beta", name: "loans", relativePath: "loans.csv" });

    await writeFile(join(alpha, "new.json"), '[{"id":3}]');
    const refresh = await app.inject({
      method: "POST",
      url: "/api/sessions/ses_alpha/folder/refresh",
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().files.map((file: { path: string }) => file.path)).toContain("new.json");

    // OpenCode fixes cwd at session creation. Mutating/removing the workspace on an existing
    // chat would make the chip lie while tools kept running in the original directory.
    expect(
      (await app.inject({
        method: "POST",
        url: "/api/sessions/ses_alpha/folder",
        payload: { path: beta },
      })).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/sessions/ses_alpha/folder" })).statusCode,
    ).toBe(409);

    expect(
      (await app.inject({ method: "DELETE", url: "/api/sessions/ses_alpha" })).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: "/api/sessions/ses_alpha/sources" })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: "/api/sessions/ses_beta/sources" })).json()
        .sources,
    ).toHaveLength(1);
  });

  it("exposes only relative workspace paths to the agent read tools", async () => {
    const { app, alpha } = await fixtures();
    await startInFolder(app, alpha);

    const listed = await app.inject({
      method: "POST",
      url: "/api/internal/tools/list_workspace_files",
      payload: { sessionID: "ses_alpha" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().folder).toEqual({ name: "alpha" });
    expect(listed.body).not.toContain(alpha);

    const read = await app.inject({
      method: "POST",
      url: "/api/internal/tools/read_workspace_file",
      payload: { sessionID: "ses_alpha", path: "models/daily.sql" },
    });
    expect(read.json()).toEqual({
      path: "models/daily.sql",
      content: "select * from loans",
    });
    expect(read.body).not.toContain(alpha);

    const traversal = await app.inject({
      method: "POST",
      url: "/api/internal/tools/read_workspace_file",
      payload: { sessionID: "ses_alpha", path: "../escape.sql" },
    });
    expect(traversal.statusCode).toBe(422);
  });

  it("approval-gates workspace writes and reindexes the created file", async () => {
    const { app, alpha, decide } = await fixtures();
    await startInFolder(app, alpha);

    const approved = await app.inject({
      method: "POST",
      url: "/api/internal/tools/write_workspace_file",
      payload: { sessionID: "ses_alpha", path: "models/generated.sql", content: "select 42" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toEqual({ path: "models/generated.sql", bytes: 9 });
    expect(await readFile(join(alpha, "models", "generated.sql"), "utf8")).toBe("select 42");

    decide("reject");
    const rejected = await app.inject({
      method: "POST",
      url: "/api/internal/tools/write_workspace_file",
      payload: { sessionID: "ses_alpha", path: "models/rejected.sql", content: "select 0" },
    });
    expect(rejected.json()).toEqual({ approved: false });
    await expect(readFile(join(alpha, "models", "rejected.sql"), "utf8")).rejects.toThrow();
  });

  it("rejects cross-site browser access and folders outside configured roots", async () => {
    const { app } = await fixtures();
    const crossSite = await app.inject({
      method: "GET",
      url: "/api/folders",
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.statusCode).toBe(403);

    const outside = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { folderPath: tmpdir() },
    });
    expect(outside.statusCode).toBe(400);
  });
});
