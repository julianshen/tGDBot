// Issue #139 stage 4. The most important assertions here are about what the
// host REFUSES to claim.
import { describe, expect, it } from "vitest";
import {
  establishReachability,
  supportedRouteFrameworks,
} from "../../../../src/review/security/reachability.js";

const express = [
  'import express from "express";',
  "const app = express();",
  'app.get("/items/:id", async (req, res) => {',
  "  res.json(await lookup(req.params.id));",
  "});",
].join("\n");

describe("a host fact needs a supported pattern and positive evidence", () => {
  it("establishes a remote vector from an Express route", () => {
    const { vector } = establishReachability({ file: "src/routes.ts", headText: express });

    expect(vector).toMatchObject({ value: "remote", source: "host" });
    // The evidence names the line, so a reader can check the claim rather than
    // take it.
    expect(vector.evidence).toContain("src/routes.ts:3");
    expect(vector.evidence).toContain("Express");
  });

  it("establishes public auth scope when no guard appears in the file", () => {
    const { authScope } = establishReachability({ file: "src/routes.ts", headText: express });

    expect(authScope).toMatchObject({ value: "public", source: "host" });
  });

  it.each([
    ["Fastify", 'fastify.post("/x", handler);'],
    ["Koa router", 'router.put("/x", handler);'],
  ])("recognises %s", (_framework, line) => {
    expect(establishReachability({ file: "src/routes.ts", headText: line }).vector.value)
      .toBe("remote");
  });
});

describe("what the host refuses to claim", () => {
  // THE property. A missing grammar must never read as an absent attack path —
  // the failure `dependency-facts.ts` and `hostCheck: not-checked` were both
  // written to avoid.
  it("answers unknown for a language it has no pattern for", () => {
    const facts = establishReachability({
      file: "internal/server/handler.go",
      headText: 'func handler(w http.ResponseWriter, r *http.Request) { }\nmux.HandleFunc("/x", handler)',
    });

    expect(facts.vector.value).toBe("unknown");
    expect(facts.authScope.value).toBe("unknown");
    // And says WHY, naming the gap rather than implying the code is unreachable.
    expect(facts.vector.evidence).toMatch(/no supported route-registration pattern/u);
  });

  it("answers unknown when the file parses but registers no route", () => {
    const facts = establishReachability({
      file: "src/util.ts",
      headText: "export function add(a: number, b: number) { return a + b; }",
    });

    expect(facts.vector.value).toBe("unknown");
    expect(facts.vector.evidence).toMatch(/no supported route registration was found/u);
  });

  it("answers unknown when the head revision could not be read", () => {
    const facts = establishReachability({ file: "src/routes.ts", headText: undefined });

    expect(facts.vector.value).toBe("unknown");
    expect(facts.vector.evidence).toMatch(/could not be read/u);
  });

  it("stamps its unknowns as host, so the reason is trustworthy", () => {
    // A reader needs to know the HOST could not establish this, not that a
    // model declined to answer. The two are different facts.
    const facts = establishReachability({ file: "a.go", headText: "package main" });

    expect(facts.vector.source).toBe("host");
    expect(facts.authScope.source).toBe("host");
  });

  it("withdraws the public claim when the file shows an authorization guard", () => {
    // The host cannot say WHICH scope applies — that needs the framework's
    // composition rules — so it says `unknown` rather than a claim the file it
    // was read from contradicts.
    const guarded = [
      "const app = express();",
      'app.get("/admin", requireAuth, (req, res) => res.json({}));',
    ].join("\n");
    const facts = establishReachability({ file: "src/routes.ts", headText: guarded });

    expect(facts.vector.value).toBe("remote");
    expect(facts.authScope.value).toBe("unknown");
    expect(facts.authScope.evidence).toMatch(/authorization guard/u);
  });

  it.each([
    "app.get('/x', passport.authenticate('jwt'), handler);",
    "app.get('/x', isAuthenticated, handler);",
    "app.get('/x', requireRole('admin'), handler);",
  ])("withdraws it for %s", (line) => {
    expect(establishReachability({ file: "src/routes.ts", headText: line }).authScope.value)
      .toBe("unknown");
  });

  it("does not claim a route from app.use, which mounts middleware", () => {
    // `use` proves much less than a verb: it mounts middleware as readily as a
    // handler, and a pattern that treated it as a route would claim a vector
    // for every logger and body parser.
    expect(establishReachability({
      file: "src/app.ts",
      headText: 'app.use("/api", router);',
    }).vector.value).toBe("unknown");
  });

  it("does not claim a route from a comment or a string that merely looks like one", () => {
    // The registration must be a call. Prose describing one is documentation.
    expect(establishReachability({
      file: "src/notes.ts",
      headText: '// we should add app dot get here one day',
    }).vector.value).toBe("unknown");
  });
});

describe("the supported list is visible", () => {
  it("names the frameworks the host can currently establish", () => {
    // Published so the coverage gap is legible: a reader can see that their
    // framework is not on the list rather than concluding their code is safe.
    expect(supportedRouteFrameworks()).toContain("Express");
  });

  it("has no duplicates", () => {
    const frameworks = supportedRouteFrameworks();
    expect(new Set(frameworks).size).toBe(frameworks.length);
  });
});
