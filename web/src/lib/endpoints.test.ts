import { describe, expect, it } from "vitest";
import {
  latestEndpoints,
  readPublishedEndpoint,
  type PublishedEndpoint,
} from "./endpoints";
import type { ChatMessage } from "../store/sessionStore";

/**
 * Unit tests for the data panel's published-endpoint selector (TASKS V4.2, PRD FR11/FR12). The panel
 * renders endpoints from the live chat stream: `publish_serving` attaches `{name, endpoint,
 * csvEndpoint, rowCount}` to its tool call's `metadata.publish`. These assert the defensive parse and
 * the newest-first, dedup-by-name collection — the same seam lib/query and lib/profile use.
 */
describe("readPublishedEndpoint", () => {
  const GOOD = {
    name: "branch_report",
    endpoint: "/api/serve/branch_report",
    csvEndpoint: "/api/serve/branch_report.csv",
    rowCount: 4,
  };

  it("reads a well-formed published endpoint from tool metadata", () => {
    expect(readPublishedEndpoint({ publish: GOOD })).toEqual(GOOD);
  });

  it("returns null when the metadata is absent or carries no publish key", () => {
    expect(readPublishedEndpoint(undefined)).toBeNull();
    expect(readPublishedEndpoint({})).toBeNull();
    expect(readPublishedEndpoint({ result: {} })).toBeNull();
  });

  it("returns null when a required field is missing or the wrong type", () => {
    expect(readPublishedEndpoint({ publish: { ...GOOD, name: 42 } })).toBeNull();
    expect(readPublishedEndpoint({ publish: { ...GOOD, endpoint: undefined } })).toBeNull();
    expect(readPublishedEndpoint({ publish: { ...GOOD, csvEndpoint: null } })).toBeNull();
    expect(readPublishedEndpoint({ publish: { ...GOOD, rowCount: "4" } })).toBeNull();
    expect(readPublishedEndpoint({ publish: "branch_report" })).toBeNull();
  });
});

describe("latestEndpoints", () => {
  function publishBlock(
    endpoint: PublishedEndpoint,
    status: "completed" | "running" = "completed",
  ) {
    return {
      kind: "tool" as const,
      callID: `c-${endpoint.name}-${endpoint.rowCount}`,
      tool: "publish_serving",
      status,
      metadata: { publish: endpoint },
    };
  }

  function ep(name: string, rowCount: number): PublishedEndpoint {
    return {
      name,
      endpoint: `/api/serve/${name}`,
      csvEndpoint: `/api/serve/${name}.csv`,
      rowCount,
    };
  }

  it("returns an empty array when nothing has been published", () => {
    const messages: ChatMessage[] = [
      { role: "user", id: "u1", content: "hi" },
      { role: "assistant", id: "a1", blocks: [] },
    ];
    expect(latestEndpoints(messages)).toEqual([]);
  });

  it("collects every distinct published endpoint, most recently published first", () => {
    const messages: ChatMessage[] = [
      { role: "user", id: "u1", content: "publish two reports" },
      {
        role: "assistant",
        id: "a1",
        blocks: [publishBlock(ep("branch_report", 4)), publishBlock(ep("overdue_report", 9))],
      },
    ];
    expect(latestEndpoints(messages)).toEqual([ep("overdue_report", 9), ep("branch_report", 4)]);
  });

  it("dedupes by served name, keeping the most recent publish's row count", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", id: "a1", blocks: [publishBlock(ep("branch_report", 4))] },
      { role: "assistant", id: "a2", blocks: [publishBlock(ep("branch_report", 7))] },
    ];
    // A re-publish replaces the endpoint; only the newest row count survives.
    expect(latestEndpoints(messages)).toEqual([ep("branch_report", 7)]);
  });

  it("ignores non-completed publishes and other tools", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        id: "a1",
        blocks: [
          publishBlock(ep("branch_report", 4), "running"),
          {
            kind: "tool",
            callID: "q1",
            tool: "run_query",
            status: "completed",
            metadata: { result: { columns: [], rows: [], rowCount: 0, truncated: false } },
          },
        ],
      },
    ];
    expect(latestEndpoints(messages)).toEqual([]);
  });

  it("ignores a user turn and a malformed publish payload", () => {
    const messages: ChatMessage[] = [
      { role: "user", id: "u1", content: "publish it" },
      {
        role: "assistant",
        id: "a1",
        blocks: [
          {
            kind: "tool",
            callID: "bad",
            tool: "publish_serving",
            status: "completed",
            metadata: { publish: { name: "x" } },
          },
          publishBlock(ep("good_report", 2)),
        ],
      },
    ];
    expect(latestEndpoints(messages)).toEqual([ep("good_report", 2)]);
  });
});
