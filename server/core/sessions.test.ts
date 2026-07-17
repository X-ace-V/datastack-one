import { describe, expect, it } from "vitest";
import {
  CreateSessionRequestSchema,
  MessageSchema,
  RenameSessionRequestSchema,
  SessionSchema,
} from "./sessions.js";

/**
 * Unit tests for the pure session contract (V1.1, FR1). They assert the validation the
 * routes (V1.2) will rely on: create trims/optionalizes, rename requires a non-empty title,
 * and the persisted shapes reject bad roles / negative sequence numbers — not merely that a
 * valid object parses.
 */
describe("session contract", () => {
  it("trims a create title and leaves model optional", () => {
    const parsed = CreateSessionRequestSchema.parse({ title: "  Loan review  " });
    expect(parsed.title).toBe("Loan review");
    expect(parsed.model).toBeUndefined();
  });

  it("accepts an empty create body (title/model both optional)", () => {
    expect(CreateSessionRequestSchema.parse({})).toEqual({});
  });

  it("rejects a whitespace-only create title", () => {
    expect(CreateSessionRequestSchema.safeParse({ title: "   " }).success).toBe(
      false,
    );
  });

  it("requires a non-empty title to rename", () => {
    expect(RenameSessionRequestSchema.parse({ title: " Renamed " })).toEqual({
      title: "Renamed",
    });
    expect(RenameSessionRequestSchema.safeParse({}).success).toBe(false);
    expect(RenameSessionRequestSchema.safeParse({ title: " " }).success).toBe(
      false,
    );
  });

  it("allows a null session model but requires the other fields", () => {
    const ok = SessionSchema.parse({
      id: "ses_1",
      title: "Session",
      model: null,
      createdAt: "2026-07-17 00:00:00",
      updatedAt: "2026-07-17 00:00:00",
    });
    expect(ok.model).toBeNull();
    expect(SessionSchema.safeParse({ id: "ses_1" }).success).toBe(false);
  });

  it("rejects an unknown message role and a negative sequence", () => {
    const base = {
      id: "m1",
      sessionId: "ses_1",
      seq: 0,
      role: "user" as const,
      content: "hi",
      createdAt: "2026-07-17 00:00:00",
    };
    expect(MessageSchema.parse(base).seq).toBe(0);
    expect(MessageSchema.safeParse({ ...base, role: "system" }).success).toBe(
      false,
    );
    expect(MessageSchema.safeParse({ ...base, seq: -1 }).success).toBe(false);
  });
});
