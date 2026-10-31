import { beforeEach, describe, expect, test } from "bun:test";
import { HOUR } from "../src/env";
import { VIS_FRESH_MS } from "../src/visibility";
import { finishN, makeHarness, type Harness } from "./harness";

let h: Harness;
const relay = { repository: "ProtoDurian/diene-reports", repository_id: "9000", ref: "refs/heads/main", event_name: "schedule" };
const repoRow = async (id: number) => (await h.env.DB.prepare(`SELECT * FROM repos WHERE repo_id = ?1`).bind(id).first()) as any;
const post = (body: unknown, claims: Record<string, unknown> = relay) => h.call("POST", "/api/v1/visibility", { claims, body });
const report = (pub: [number, string][], complete = true, owner = "ProtoDurian") => ({
  schema: "diene-visibility/v1",
  owner,
  complete,
  public: pub.map(([id, name]) => ({ id, full_name: `${owner}/${name}` })),
});

beforeEach(async () => {
  h = await makeHarness();
  await finishN(h, 1); // ProtoDurian/demo, public, id 1001
  await finishN(h, 2, {}, { repository: "ProtoDurian/secret-svc", repository_id: "1002", repository_visibility: "private" });
  await finishN(h, 3, {}, { repository: "ProtoDurian/was-private", repository_id: "1003", repository_visibility: "private" });
  await finishN(h, 4, {}, { repository: "OtherOrg/theirs", repository_id: "2001", repository_owner: "OtherOrg", repository_owner_id: "55664364", repository_visibility: "public" });
  h.clock.t += 1000;
});

describe("who may report", () => {
  test("a repository that is not in VISIBILITY_REPORTERS is refused", async () => {
    const r = await post(report([[1001, "demo"]]), { ...relay, repository: "ProtoDurian/demo" });
    expect(r.status).toBe(403);
    expect((await repoRow(1002)).visibility).toBe("private");
  });

  test("only main", async () => {
    expect((await post(report([[1003, "was-private"]]), { ...relay, ref: "refs/heads/feat/x" })).status).toBe(403);
    expect((await post(report([[1003, "was-private"]]), { ...relay, ref: "refs/pull/3/merge", event_name: "pull_request" })).status).toBe(403);
    expect((await repoRow(1003)).visibility).toBe("private");
  });

  test("only schedule and workflow_dispatch", async () => {
    for (const event_name of ["push", "pull_request", "workflow_run", "release"]) {
      expect((await post(report([[1003, "was-private"]]), { ...relay, event_name })).status).toBe(403);
    }
    expect((await post(report([[1003, "was-private"]]), { ...relay, event_name: "workflow_dispatch" })).status).toBe(200);
  });

  test("the list is configurable, matched case-insensitively, and an empty value means the default", async () => {
    const other = { ...relay, repository: "ProtoDurian/other-relay" };
    expect((await post(report([]), other)).status).toBe(403);
    h.env.VISIBILITY_REPORTERS = "protodurian/diene-reports, ProtoDurian/other-relay";
    expect((await post(report([]), other)).status).toBe(200);
    expect((await post(report([]), relay)).status).toBe(200);
    h.env.VISIBILITY_REPORTERS = "";
    expect((await post(report([]), relay)).status).toBe(200);
    expect((await post(report([]), other)).status).toBe(403);
  });

  test("a token is still required: no bearer 401, wrong audience 401, owner not on the allow-list 403", async () => {
    expect((await h.call("POST", "/api/v1/visibility", { token: null, body: report([]) })).status).toBe(401);
    expect((await post(report([]), { ...relay, aud: "someone-else" })).status).toBe(401);
    expect((await post(report([]), { ...relay, repository_owner_id: "1" })).status).toBe(403);
  });

  test("the token's owner must be the body's owner", async () => {
    const r = await post(report([[2001, "theirs"]], true, "OtherOrg"));
    expect(r.status).toBe(403);
    expect((await repoRow(2001)).visibility).toBe("public");
    expect((await post(report([[1001, "demo"]], true, "protodurian"))).status).toBe(403);
  });
});

describe("what a report does", () => {
  test("complete=true: listed repos become public, unlisted ones private; counts and vis_checked_at", async () => {
    const r = await post(report([[1001, "demo"], [1003, "was-private"]]));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ updated: 3, madePublic: 1, madePrivate: 0 });
    const all = await Promise.all([1001, 1002, 1003].map(repoRow));
    expect(all.map((x) => x.visibility)).toEqual(["public", "private", "public"]);
    expect(all.every((x) => x.vis_checked_at === h.clock.t)).toBe(true);

    h.clock.t += 1000;
    const r2 = await post(report([[1003, "was-private"]]));
    expect(r2.json).toEqual({ updated: 3, madePublic: 0, madePrivate: 1 });
    expect((await repoRow(1001)).visibility).toBe("private");
    expect((await repoRow(1003)).visibility).toBe("public");
  });

  test("complete=false never marks anything private and leaves unlisted rows unchecked", async () => {
    const before = (await repoRow(1001)).vis_checked_at;
    const r = await post(report([[1003, "was-private"]], false));
    expect(r.json).toEqual({ updated: 1, madePublic: 1, madePrivate: 0 });
    expect((await repoRow(1001)).visibility).toBe("public");
    expect((await repoRow(1001)).vis_checked_at).toBe(before);
    expect((await repoRow(1003)).visibility).toBe("public");
    expect((await repoRow(1003)).vis_checked_at).toBe(h.clock.t);
    expect((await post(report([], false))).json).toEqual({ updated: 0, madePublic: 0, madePrivate: 0 });
    expect((await repoRow(1001)).visibility).toBe("public");
  });

  test("a rename in full_name updates owner/name", async () => {
    const r = await post(report([[1001, "demo-renamed"]]));
    expect(r.status).toBe(200);
    const row = await repoRow(1001);
    expect([row.owner, row.name, row.visibility]).toEqual(["ProtoDurian", "demo-renamed", "public"]);
  });

  test("other owners' rows are never touched", async () => {
    const before = await repoRow(2001);
    await post(report([]));
    expect(await repoRow(2001)).toEqual(before);
    expect((await repoRow(1001)).visibility).toBe("private");
  });

  test("a fresh report keeps the 6 h inline re-check away", async () => {
    h.clock.t += VIS_FRESH_MS - HOUR;
    await post(report([[1001, "demo"]]));
    h.clock.t += HOUR + 60_000;
    const calls = h.gh.calls.length;
    const page = await h.view("/ProtoDurian/demo");
    expect(page.status).toBe(200);
    expect(h.gh.calls.length).toBe(calls);
  });

  test("a rewritten row (unlisted, complete) is hidden from anonymous visitors at once", async () => {
    expect((await h.view("/ProtoDurian/demo")).status).toBe(200);
    await post(report([]));
    expect((await h.view("/ProtoDurian/demo")).status).toBe(404);
  });

  test("uses a few D1 statements regardless of list size", async () => {
    const before = h.db.statements;
    const pub: [number, string][] = Array.from({ length: 10_000 }, (_, i) => [100_000 + i, `r${i}`]);
    expect((await post(report(pub))).status).toBe(200);
    expect(h.db.statements - before).toBeLessThanOrEqual(5);
  });
});

describe("validation", () => {
  const bad = (name: string, body: unknown) => test(name, async () => expect((await post(body)).status).toBe(400));
  bad("wrong schema", { ...report([]), schema: "x" });
  bad("complete is not a boolean", { ...report([]), complete: "true" });
  bad("public is not an array", { ...report([]), public: {} });
  bad("id is not a positive integer", { ...report([]), public: [{ id: "1001", full_name: "ProtoDurian/demo" }] });
  bad("id is fractional", { ...report([]), public: [{ id: 1.5, full_name: "ProtoDurian/demo" }] });
  bad("full_name is for another owner", { ...report([]), public: [{ id: 1001, full_name: "OtherOrg/demo" }] });
  bad("full_name is not owner/name", { ...report([]), public: [{ id: 1001, full_name: "demo" }] });
  bad("an entry is not an object", { ...report([]), public: [1001] });
  bad("body is an array", []);
  bad("more than 10 000 entries", report(Array.from({ length: 10_001 }, (_, i) => [i + 1, `r${i}`] as [number, string])));

  test("a bad report changes nothing", async () => {
    const before = await repoRow(1001);
    await post({ ...report([]), complete: 1 });
    expect(await repoRow(1001)).toEqual(before);
  });

  test("duplicate ids are tolerated", async () => {
    const r = await post(report([[1003, "was-private"], [1003, "was-private"]], false));
    expect(r.json).toEqual({ updated: 1, madePublic: 1, madePrivate: 0 });
  });
});
