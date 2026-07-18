import { describe, expect, it } from "vitest";
import {
  ConnectionSchema,
  CreateConnectionRequestSchema,
  StoredConnectionSchema,
  isPostgresUrl,
  redactConnectionSecret,
  toConnectionView,
} from "./connections.js";

/**
 * Pure units for the connections contract (V5.1, FR5). Assert the request validation (name is an
 * identifier, url must be postgres), the safe view has no `url` field, and — the security-critical
 * one — the secret scrubber removes a credential from a driver error before it can leave the
 * backend.
 */
describe("connection request validation", () => {
  const url = "postgresql://user:pass@db.neon.tech/main?sslmode=require";

  it("accepts a valid name + postgres url and defaults the type", () => {
    const parsed = CreateConnectionRequestSchema.parse({ name: "neon_lending", url });
    expect(parsed).toEqual({ name: "neon_lending", type: "postgres", url });
  });

  it("accepts the postgres:// scheme as well as postgresql://", () => {
    const parsed = CreateConnectionRequestSchema.parse({
      name: "pg",
      url: "postgres://u:p@host:5432/db",
    });
    expect(parsed.type).toBe("postgres");
  });

  it("trims the name but keeps it as an identifier", () => {
    const parsed = CreateConnectionRequestSchema.parse({ name: "  db1  ", url });
    expect(parsed.name).toBe("db1");
  });

  it.each([
    ["a leading digit", "1db"],
    ["a dash", "my-db"],
    ["a dot", "my.db"],
    ["a space", "my db"],
    ["empty", ""],
  ])("rejects a name with %s", (_why, name) => {
    expect(CreateConnectionRequestSchema.safeParse({ name, url }).success).toBe(false);
  });

  it.each([
    ["a non-postgres scheme", "mysql://u:p@host/db"],
    ["a bare host", "db.neon.tech/main"],
    ["empty", ""],
  ])("rejects a url that is %s", (_why, badUrl) => {
    expect(
      CreateConnectionRequestSchema.safeParse({ name: "db", url: badUrl }).success,
    ).toBe(false);
  });

  it("rejects an unknown connection type", () => {
    expect(
      CreateConnectionRequestSchema.safeParse({ name: "db", type: "mysql", url }).success,
    ).toBe(false);
  });
});

describe("isPostgresUrl", () => {
  it.each([
    "postgres://u:p@h/db",
    "postgresql://u:p@h/db",
    "POSTGRESQL://u:p@h/db",
    "  postgres://u:p@h/db  ",
  ])("accepts %s", (url) => {
    expect(isPostgresUrl(url)).toBe(true);
  });

  it.each(["mysql://h/db", "http://h", "db.neon.tech/main", ""])(
    "rejects %s",
    (url) => {
      expect(isPostgresUrl(url)).toBe(false);
    },
  );
});

describe("toConnectionView", () => {
  it("projects a stored connection to a secret-free view", () => {
    const stored = StoredConnectionSchema.parse({
      name: "neon",
      type: "postgres",
      url: "postgresql://user:supersecret@host/db",
      createdAt: "2026-07-18 10:00:00",
    });
    const view = toConnectionView(stored);
    expect(view).toEqual({
      name: "neon",
      type: "postgres",
      createdAt: "2026-07-18 10:00:00",
    });
    // The view shape has no `url` key at all, so a serialized response can never carry it.
    expect("url" in view).toBe(false);
    expect(ConnectionSchema.parse(view)).toEqual(view);
  });
});

describe("redactConnectionSecret", () => {
  const url = "postgresql://admin:hunter2@db.neon.tech:5432/main?sslmode=require";

  it("removes the exact url (and its password) from a driver message", () => {
    const message = `IO Error: Unable to connect to Postgres at "${url}": connection refused`;
    const scrubbed = redactConnectionSecret(message, url);
    expect(scrubbed).not.toContain(url);
    expect(scrubbed).not.toContain("hunter2");
    expect(scrubbed).toContain("<connection>");
    expect(scrubbed).toContain("connection refused");
  });

  it("masks a reformatted credential even when the exact url did not match", () => {
    const message = "auth failed for //admin:hunter2@db.neon.tech/main";
    const scrubbed = redactConnectionSecret(message, "postgresql://different/url");
    expect(scrubbed).not.toContain("hunter2");
    expect(scrubbed).toContain("<credentials>@");
  });

  it("leaves a secret-free message untouched", () => {
    const message = "postgres extension is not installed";
    expect(redactConnectionSecret(message, url)).toBe(message);
  });
});
