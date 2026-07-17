import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { buildServer } from "../server/app.js";

/**
 * Doc-truth tests (T6.4).
 *
 * The README and DEMO make concrete, checkable claims — these commands exist, these routes
 * answer, these files are there. Prose can't be typechecked, so it rots silently: this repo
 * shipped a README claiming "nothing here is built yet" through thirty completed tasks
 * precisely because nothing failed when it went stale. These tests fail instead.
 *
 * Conventions the parsing relies on, so the tests stay honest rather than clever:
 * - An inline-code span of the exact form `METHOD /api/...` is a **route pattern**, and every
 *   one must be registered. Concrete example URLs (`/api/serve/daily_branch_summary`) belong
 *   in fenced blocks, which are stripped before parsing.
 * - The route check runs BOTH ways: the docs may not invent a route, and a route may not go
 *   undocumented — the README claims to be the API surface, so a new route must land there.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function readDoc(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
}

/**
 * A capture group the regex shape guarantees. Under `noUncheckedIndexedAccess` every group
 * is `string | undefined`; throwing on a group that did not participate keeps a silently
 * dropped match from quietly shrinking a set these tests then assert over.
 */
function group(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`regex group ${index} did not participate in match: ${match[0]}`);
  }
  return value;
}

/** Fenced blocks hold example invocations, not claims about identifiers — strip them. */
function stripFencedCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, "");
}

function inlineCodeSpans(markdown: string): string[] {
  return [...stripFencedCode(markdown).matchAll(/`([^`\n]+)`/g)].map((m) => group(m, 1));
}

const DOCS = ["README.md"] as const;
const docText = Object.fromEntries(DOCS.map((name) => [name, readDoc(name)])) as Record<
  (typeof DOCS)[number],
  string
>;
const allDocs = DOCS.map((name) => docText[name]).join("\n");

interface PackageJson {
  readonly scripts: Record<string, string>;
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageJson;

describe("documented npm scripts exist", () => {
  const referenced = new Set<string>();
  for (const doc of DOCS) {
    // `npm run <name>` in prose or fenced examples — both are promises to the reader, so
    // unlike identifier claims these are collected from the whole document.
    for (const m of docText[doc].matchAll(/\bnpm run ([a-z][a-z:-]*)/g)) referenced.add(group(m, 1));
    if (/\bnpm test\b/.test(docText[doc])) referenced.add("test");
  }

  it("references the scripts a reader needs", () => {
    // Guards the parse itself: if this drops to zero the tests below pass vacuously.
    expect(referenced.size).toBeGreaterThanOrEqual(4);
    expect(referenced).toContain("dev");
    expect(referenced).toContain("test");
  });

  it.each([...referenced].sort())("`npm run %s` is a real script", (script) => {
    expect(Object.keys(pkg.scripts)).toContain(script);
  });
});

/**
 * Recover the registered routes from Fastify's route tree. The tree is radix-compressed —
 * a child node holds only the suffix its parent didn't ("s" under "/:id/source" is
 * "/:id/sources") — so a full URL is the concatenation of its ancestors' segments. Every
 * recovered route is then put through the real router's `hasRoute` below, which is what
 * makes this a fact about the router rather than a guess about a debug format.
 */
function parseRouteTree(tree: string): string[] {
  const routes: string[] = [];
  const segments: string[] = [];
  for (const line of tree.split("\n")) {
    const node = /^([│\s]*)(?:├──|└──)\s(.*)$/.exec(line);
    if (!node) continue;
    const depth = Math.round(group(node, 1).length / 4);
    const body = group(node, 2);
    const withMethods = /^(.*?)\s\(([A-Z,\s]+)\)$/.exec(body);
    segments.length = depth;
    segments[depth] = withMethods ? group(withMethods, 1) : body;
    if (!withMethods) continue; // a pure prefix node — not a route itself
    const url = segments.slice(0, depth + 1).join("");
    for (const method of group(withMethods, 2).split(",").map((m) => m.trim())) {
      // Fastify adds HEAD for every GET; it is not a documented part of the surface.
      if (method !== "HEAD") routes.push(`${method} ${url}`);
    }
  }
  return routes;
}

describe("documented API routes are registered", async () => {
  const documented = new Set<string>();
  for (const doc of DOCS) {
    for (const span of inlineCodeSpans(docText[doc])) {
      const m = /^(GET|POST) (\/api\/\S*)$/.exec(span.trim());
      if (m) documented.add(`${group(m, 1)} ${group(m, 2)}`);
    }
  }

  const app = buildServer();
  await app.ready();
  const registered = new Set(
    parseRouteTree(app.printRoutes({ commonPrefix: false })).filter((r) => r.includes(" /api/")),
  );
  afterAll(async () => {
    await app.close();
  });

  it("recovered a plausible API surface", () => {
    // Guards both the parse and the doc scrape: without this, an empty set on either side
    // would make the subset assertions below pass while proving nothing. The floor tracks the
    // real surface, which shrank when the wizard's pipeline routes were removed — it exists to
    // catch a parse returning nothing, not to pin a count the equality checks below already own.
    expect(registered.size).toBeGreaterThanOrEqual(14);
    expect(documented.size).toBeGreaterThanOrEqual(14);
  });

  it.each([...registered].sort())("%s is confirmed by the router", (route) => {
    // Proves parseRouteTree reconstructed real URLs rather than plausible-looking strings.
    const separator = route.indexOf(" ");
    const method = route.slice(0, separator);
    const url = route.slice(separator + 1);
    expect(app.hasRoute({ method: method as "GET" | "POST", url })).toBe(true);
  });

  it("documents no route that does not exist", () => {
    const invented = [...documented].filter((route) => !registered.has(route)).sort();
    expect(invented).toEqual([]);
  });

  it("leaves no registered route undocumented", () => {
    const undocumented = [...registered].filter((route) => !documented.has(route)).sort();
    expect(undocumented).toEqual([]);
  });
});

describe("documented relative links resolve", () => {
  const links = new Set<string>();
  for (const doc of DOCS) {
    for (const m of docText[doc].matchAll(/\]\(\.\/([^)#]+)\)/g)) links.add(group(m, 1));
  }

  it("links to the other documents", () => {
    expect(links.size).toBeGreaterThanOrEqual(4);
  });

  it.each([...links].sort())("./%s exists", (target) => {
    expect(existsSync(new URL(target, `file://${repoRoot}`))).toBe(true);
  });
});

describe("documented fixture paths exist", () => {
  const paths = new Set([...allDocs.matchAll(/\bfixtures\/[A-Za-z0-9_.-]+/g)].map((m) => m[0]));

  it("names the demo fixtures", () => {
    expect(paths).toContain("fixtures/loans_sample.csv");
    expect(paths).toContain("fixtures/rules.txt");
  });

  it.each([...paths].sort())("%s exists", (target) => {
    expect(existsSync(new URL(target, `file://${repoRoot}`))).toBe(true);
  });
});

describe("documented ports match the code", () => {
  const indexSrc = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const viteSrc = readFileSync(new URL("../web/vite.config.ts", import.meta.url), "utf8");

  it("documents the backend port index.ts actually defaults to", () => {
    const port = /process\.env\.PORT \?\? (\d+)/.exec(indexSrc)?.[1];
    expect(port).toBeDefined();
    expect(allDocs).toContain(`:${port}`);
  });

  it("documents the web port vite actually serves", () => {
    const port = /port: (\d+)/.exec(viteSrc)?.[1];
    expect(port).toBeDefined();
    expect(allDocs).toContain(`:${port}`);
  });

  it("documents the proxy target the web app actually calls", () => {
    const target = /"\/api": "http:\/\/localhost:(\d+)"/.exec(viteSrc)?.[1];
    expect(target).toBeDefined();
    expect(allDocs).toContain(`:${target}`);
  });
});
