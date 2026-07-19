import { describe, expect, it } from "vitest";
import {
  ASK_TOOLS,
  DEFAULT_MODEL,
  buildOpencodeConfig,
  isAskTool,
} from "./config.js";

/**
 * Pure config assertions for the OpenCode runtime (T1.1). No server boot — these
 * verify the desired *values*: the free default model, the built-in `ask` gate, the
 * canonical write/execute ask-list, and that overrides merge without dropping the gate.
 */
describe("buildOpencodeConfig", () => {
  it("defaults to the free opencode/big-pickle model (PRD FR11)", () => {
    expect(DEFAULT_MODEL).toBe("opencode/big-pickle");
    expect(buildOpencodeConfig().model).toBe("opencode/big-pickle");
  });

  it("gates every built-in mutation surface with ask (ARCHITECTURE §6)", () => {
    const { permission } = buildOpencodeConfig();
    expect(permission).toEqual({ edit: "ask", bash: "ask", webfetch: "ask" });
  });

  it("lets a caller override the model without losing the permission gate", () => {
    const cfg = buildOpencodeConfig({ model: "anthropic/claude-opus-4-8" });
    expect(cfg.model).toBe("anthropic/claude-opus-4-8");
    expect(cfg.permission).toEqual({ edit: "ask", bash: "ask", webfetch: "ask" });
  });

  it("merges a permission override one level deep, keeping the other gates", () => {
    const cfg = buildOpencodeConfig({ permission: { webfetch: "deny" } });
    expect(cfg.permission).toEqual({ edit: "ask", bash: "ask", webfetch: "deny" });
  });

  it("passes through unrelated config keys", () => {
    const cfg = buildOpencodeConfig({ logLevel: "WARN" });
    expect(cfg.logLevel).toBe("WARN");
    expect(cfg.model).toBe("opencode/big-pickle");
  });
});

describe("ASK_TOOLS approval gate", () => {
  it("names exactly the write/execute custom tools (FR8/FR5b, ARCHITECTURE §5)", () => {
    expect([...ASK_TOOLS]).toEqual([
      "land_parquet",
      "load_warehouse",
      "run_transform",
      "publish_serving",
      "attach_source",
      "write_workspace_file",
    ]);
  });

  it("recognizes gated tools and lets read-only tools through", () => {
    expect(isAskTool("run_transform")).toBe(true);
    expect(isAskTool("publish_serving")).toBe(true);
    expect(isAskTool("attach_source")).toBe(true);
    expect(isAskTool("profile_source")).toBe(false);
    expect(isAskTool("read_rules")).toBe(false);
  });
});
