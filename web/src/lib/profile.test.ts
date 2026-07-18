import { describe, expect, it } from "vitest";
import { latestProfile, readSourceProfile } from "./profile";
import type { SourceProfile } from "./api";
import type { ChatMessage } from "../store/sessionStore";

/**
 * Unit tests for the data-panel profile selectors (V3.4, FR6): reading a `profile_source` result out
 * of a tool call's metadata defensively, and finding the latest such profile across a transcript.
 * Mirrors query.test.ts — the two selectors share the metadata seam.
 */

const PROFILE: SourceProfile = {
  rowCount: 4,
  columnCount: 2,
  columns: [
    {
      name: "loan_id",
      type: "BIGINT",
      nullCount: 0,
      nullPercent: 0,
      distinctCount: 4,
      isCandidateKey: true,
      isDateColumn: false,
    },
    {
      name: "opened_at",
      type: "DATE",
      nullCount: 0,
      nullPercent: 0,
      distinctCount: 3,
      isCandidateKey: false,
      isDateColumn: true,
    },
  ],
  candidateKeys: ["loan_id"],
  dateColumns: ["opened_at"],
};

/** An assistant turn holding a completed profile_source tool block carrying `profile` in metadata. */
function profileTurn(id: string, profile: unknown, tool = "profile_source"): ChatMessage {
  return {
    role: "assistant",
    id,
    blocks: [
      {
        kind: "tool",
        callID: `${id}-c`,
        tool,
        status: "completed",
        metadata: profile === undefined ? undefined : { profile },
      },
    ],
  };
}

describe("readSourceProfile", () => {
  it("reads a well-formed profile out of metadata", () => {
    expect(readSourceProfile({ profile: PROFILE })).toEqual(PROFILE);
  });

  it("returns null when metadata is absent or has no profile", () => {
    expect(readSourceProfile(undefined)).toBeNull();
    expect(readSourceProfile({})).toBeNull();
    expect(readSourceProfile({ result: {} })).toBeNull();
  });

  it("returns null for a malformed profile rather than throwing", () => {
    // columns not an array
    expect(readSourceProfile({ profile: { ...PROFILE, columns: "nope" } })).toBeNull();
    // a column missing a required field
    expect(
      readSourceProfile({ profile: { ...PROFILE, columns: [{ name: "x", type: "INT" }] } }),
    ).toBeNull();
    // candidateKeys not a string array
    expect(readSourceProfile({ profile: { ...PROFILE, candidateKeys: [1] } })).toBeNull();
    // rowCount missing
    expect(
      readSourceProfile({ profile: { columnCount: 0, columns: [], candidateKeys: [], dateColumns: [] } }),
    ).toBeNull();
  });
});

describe("latestProfile", () => {
  it("returns null when the transcript has no profile", () => {
    const messages: ChatMessage[] = [
      { role: "user", id: "u1", content: "hi" },
      { role: "assistant", id: "a1", blocks: [{ kind: "text", partID: "p", text: "hello" }] },
    ];
    expect(latestProfile(messages)).toBeNull();
  });

  it("returns the most recent profile_source result, not an earlier one", () => {
    const older: SourceProfile = { ...PROFILE, rowCount: 1, candidateKeys: [] };
    const messages: ChatMessage[] = [
      profileTurn("a1", older),
      { role: "user", id: "u2", content: "profile it again" },
      profileTurn("a2", PROFILE),
    ];
    expect(latestProfile(messages)).toEqual(PROFILE);
  });

  it("ignores completed tool calls that are not profile_source", () => {
    const messages: ChatMessage[] = [profileTurn("a1", PROFILE, "run_query")];
    expect(latestProfile(messages)).toBeNull();
  });

  it("skips a profile_source block with no valid profile and finds an earlier valid one", () => {
    const messages: ChatMessage[] = [profileTurn("a1", PROFILE), profileTurn("a2", undefined)];
    expect(latestProfile(messages)).toEqual(PROFILE);
  });
});
