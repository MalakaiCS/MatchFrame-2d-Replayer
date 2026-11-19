/**
 * API integration tests against a running server (MF_BASE_URL) with a worker
 * that accepts SYNTHETIC fixtures (MF_ALLOW_SYNTHETIC=1).
 *
 *   MF_BASE_URL=http://localhost:3000 npx vitest run tests/api
 */
import { gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";

const BASE = process.env.MF_BASE_URL ?? "http://localhost:3000";
const run = Math.random().toString(36).slice(2, 8);

class Client {
  cookies = new Map<string, string>();
  constructor(public name: string, public share: string | null = null) {}
  async req(path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers);
    headers.set("Origin", BASE);
    if (this.cookies.size) headers.set("Cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    if (this.share) headers.set("X-Share-Token", this.share);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(init.json);
    }
    const res = await fetch(BASE + path, { ...init, headers, body, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      this.cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  }
  async json<T = any>(path: string, init: RequestInit & { json?: unknown } = {}, expectStatus?: number): Promise<T> {
    const r = await this.req(path, init);
    const t = await r.text();
    if (expectStatus !== undefined) expect(r.status, `${init.method ?? "GET"} ${path}: ${t}`).toBe(expectStatus);
    return (t ? JSON.parse(t) : null) as T;
  }
  async signup() {
    const email = `${this.name}-${run}@example.test`;
    await this.json("/api/auth/sign-up/email", { method: "POST", json: { email, password: "correct-horse-battery", name: this.name } }, 200);
    return email;
  }
}

const abs = (u: string) => (/^https?:/.test(u) ? u : BASE + u);

function synthetic(params: Record<string, unknown>) {
  return Buffer.concat([Buffer.from("MFSYNTH1"), Buffer.from(JSON.stringify(params))]);
}

async function upload(c: Client, data: Buffer, filename = "match.dem", extra: Record<string, unknown> = {}) {
  const slot = await c.json("/api/uploads", { method: "POST", json: { filename, size: data.length } }, 201);
  const put = await fetch(abs(slot.upload.url), { method: "PUT", body: new Uint8Array(data), headers: slot.upload.headers });
  expect(put.status).toBe(200);
  return { slot, done: await c.json(`/api/uploads/${slot.uploadId}/complete`, { method: "POST", json: extra }) };
}

async function waitReady(c: Client, id: string, timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await c.json(`/api/replays/${id}`);
    if (r.replay.status === "ready" || r.replay.status === "failed") return r;
    if (Date.now() - t0 > timeoutMs) throw new Error("timed out waiting for processing");
    await new Promise((res) => setTimeout(res, 1000));
  }
}

const owner = new Client("owner");
const mate = new Client("mate");
const outsider = new Client("outsider");
const anon = new Client("anon");
let mateEmail = "";
let replayId = "";
let manifest: any;
let teamId = "";

beforeAll(async () => {
  await owner.signup();
  mateEmail = await mate.signup();
  await outsider.signup();
  const { done } = await upload(owner, synthetic({ map: "de_mirage", winners: "ABABAABBABAB" + "BA" }));
  replayId = done.replayId;
  const r = await waitReady(owner, replayId);
  expect(r.replay.status).toBe("ready");
  manifest = r.manifest;
  teamId = (await owner.json("/api/teams", { method: "POST", json: { name: `Team ${run}` } }, 201)).id;
  await owner.json(`/api/teams/${teamId}/members`, { method: "POST", json: { email: mateEmail, role: "player" } }, 201);
}, 120_000);

describe("upload and processing", () => {
  it("processes asynchronously and exposes all rounds", () => {
    expect(manifest.rounds).toHaveLength(14);
    expect(manifest.map.id).toBe("de_mirage");
    expect(manifest.rounds[0].payload.key).toBe("");
  });

  it("finalisation is idempotent", async () => {
    const data = synthetic({ map: "de_dust2", winners: "AB" });
    const { slot, done } = await upload(owner, data);
    const again = await owner.json(`/api/uploads/${slot.uploadId}/complete`, { method: "POST", json: {} }, 200);
    expect(again.replayId).toBe(done.replayId);
    expect(again.duplicate).toBe(true);
  });

  it("rejects oversized, compressed and non-demo uploads with actionable errors", async () => {
    const big = await owner.json("/api/uploads", { method: "POST", json: { filename: "x.dem", size: 1100 * 2 ** 20 } }, 400);
    expect(big.error.code).toBe("TOO_LARGE");
    const sz = await owner.json("/api/uploads", { method: "POST", json: { filename: "x.7z", size: 100 } }, 400);
    expect(sz.error.code).toBe("UNSUPPORTED_ARCHIVE");
    // Compressed demos (.dem.bz2 / .dem.gz / .zip / .rar) are accepted and extracted by the worker.
    await owner.json("/api/uploads", { method: "POST", json: { filename: "x.dem.bz2", size: 100 } }, 201);
    const bad = Buffer.from("this is not a demo file at all");
    const slot = await owner.json("/api/uploads", { method: "POST", json: { filename: "bad.dem", size: bad.length } }, 201);
    await fetch(abs(slot.upload.url), { method: "PUT", body: new Uint8Array(bad), headers: slot.upload.headers });
    const r = await owner.json(`/api/uploads/${slot.uploadId}/complete`, { method: "POST", json: {} }, 400);
    expect(r.error.code).toBe("INVALID_DEMO");
  });

  it("rejects a body that does not match the declared size", async () => {
    const slot = await owner.json("/api/uploads", { method: "POST", json: { filename: "a.dem", size: 50 } }, 201);
    const put = await fetch(abs(slot.upload.url), { method: "PUT", body: new Uint8Array(80), headers: slot.upload.headers });
    // fs driver: the upload route refuses it. S3: the signed Content-Length makes the bucket refuse it
    // (emulators may not enforce this). Either way, finalisation must reject the size mismatch.
    if (put.ok) {
      const r = await owner.json(`/api/uploads/${slot.uploadId}/complete`, { method: "POST", json: {} }, 400);
      expect(r.error.code).toBe("SIZE_MISMATCH");
    } else {
      expect(put.status).toBeGreaterThanOrEqual(400);
    }
  });

  it("reports unsupported maps as a failed replay", async () => {
    const { done } = await upload(owner, synthetic({ map: "de_mirage", winners: "AB", header_map: "de_notamap" }));
    const r = await waitReady(owner, done.replayId);
    expect(r.replay.status).toBe("failed");
    expect(r.replay.failureCode).toBe("UNSUPPORTED_MAP");
  }, 60_000);

  it("requires sign-in to upload", async () => {
    await anon.json("/api/uploads", { method: "POST", json: { filename: "a.dem", size: 10 } }, 401);
  });
});

describe("access control", () => {
  it("serves round payloads only to authorised viewers, with private no-store caching", async () => {
    const r = await owner.req(`/api/replays/${replayId}/rounds/r01`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toContain("no-store");
    expect(r.headers.get("x-content-format")).toBe("application/json+gzip");
    const p = JSON.parse(gunzipSync(Buffer.from(await r.arrayBuffer())).toString());
    expect(p.roundId).toBe("r01");
    expect((await outsider.req(`/api/replays/${replayId}/rounds/r01`)).status).toBe(404);
    expect((await outsider.req(`/api/replays/${replayId}`)).status).toBe(404);
    expect((await anon.req(`/api/replays/${replayId}`)).status).toBe(401);
    expect((await owner.req(`/api/replays/${replayId}/rounds/r99`)).status).toBe(404);
    expect((await owner.req(`/api/replays/${replayId}/rounds/..%2Fmanifest`)).status).toBe(404);
  });

  it("team grant gives teammates access; removing it takes access away", async () => {
    expect((await mate.req(`/api/replays/${replayId}`)).status).toBe(404);
    await owner.json(`/api/replays/${replayId}/grants`, { method: "POST", json: { teamId } }, 201);
    expect((await mate.req(`/api/replays/${replayId}`)).status).toBe(200);
    const lib = await mate.json("/api/replays");
    expect(lib.replays.some((x: any) => x.id === replayId)).toBe(true);
    await owner.json(`/api/replays/${replayId}/grants?teamId=${teamId}`, { method: "DELETE" }, 200);
    expect((await mate.req(`/api/replays/${replayId}`)).status).toBe(404);
    await owner.json(`/api/replays/${replayId}/grants`, { method: "POST", json: { teamId } }, 201);
  });

  it("only the owner can manage sharing or delete", async () => {
    expect((await mate.req(`/api/replays/${replayId}/share`, { method: "POST" })).status).toBe(403);
    expect((await mate.req(`/api/replays/${replayId}`, { method: "DELETE" })).status).toBe(403);
  });
});

describe("read-only links", () => {
  it("opens with the token header, and revocation blocks the next request", async () => {
    const { token } = await owner.json(`/api/replays/${replayId}/share`, { method: "POST" }, 201);
    const viewer = new Client("link", token);
    const m = await viewer.json(`/api/replays/${replayId}`, {}, 200);
    expect(m.access.via).toBe("share");
    expect(m.access.canReview).toBe(false);
    expect((await viewer.req(`/api/replays/${replayId}/rounds/r02`)).status).toBe(200);
    // Token in the query string is not accepted.
    expect((await anon.req(`/api/replays/${replayId}?s=${token}`)).status).toBe(401);
    // Review data is never exposed through a link.
    const rv = await viewer.json(`/api/replays/${replayId}/review`, {}, 200);
    expect(rv.bookmarks).toEqual([]);
    expect((await viewer.req(`/api/replays/${replayId}/review`, { method: "POST", json: { kind: "note", roundId: "r01", tick: manifest.rounds[0].startTick, body: "x" } })).status).toBe(403);
    await owner.json(`/api/replays/${replayId}/share`, { method: "DELETE" }, 200);
    expect((await viewer.req(`/api/replays/${replayId}`)).status).toBe(404);
    expect((await viewer.req(`/api/replays/${replayId}/rounds/r02`)).status).toBe(404);
  });

  it("round links open one round only, are reusable, and need a manager", async () => {
    // A teammate with access through a grant cannot create public links.
    expect((await mate.req(`/api/replays/${replayId}/share`, { method: "POST", json: { roundId: "r03" } })).status).toBe(403);
    expect((await owner.req(`/api/replays/${replayId}/share`, { method: "POST", json: { roundId: "r99" } })).status).toBe(400);
    expect((await owner.req(`/api/replays/${replayId}/share`, { method: "POST", json: { roundId: "../x" } })).status).toBe(400);
    const first = await owner.json(`/api/replays/${replayId}/share`, { method: "POST", json: { roundId: "r03" } }, 201);
    const again = await owner.json(`/api/replays/${replayId}/share`, { method: "POST", json: { roundId: "r03" } }, 200);
    expect(again.token).toBe(first.token);
    expect(again.id).toBe(first.id);
    const listed = await owner.json(`/api/replays/${replayId}/share`, {}, 200);
    expect(listed.links.find((l: any) => l.id === first.id).roundId).toBe("r03");

    const viewer = new Client("roundlink", first.token);
    const m = await viewer.json(`/api/replays/${replayId}`, {}, 200);
    expect(m.access.via).toBe("share");
    expect(m.access.roundId).toBe("r03");
    expect(m.manifest.rounds.map((r: any) => r.id)).toEqual(["r03"]);
    expect((await viewer.req(`/api/replays/${replayId}/rounds/r03`)).status).toBe(200);
    expect((await viewer.req(`/api/replays/${replayId}/rounds/r02`)).status).toBe(404);
    expect((await viewer.json(`/api/replays/${replayId}/review`, {}, 200)).notes).toEqual([]);

    // Revoking all links turns the round link off; asking again issues a new one.
    await owner.json(`/api/replays/${replayId}/share`, { method: "DELETE" }, 200);
    expect((await viewer.req(`/api/replays/${replayId}`)).status).toBe(404);
    const fresh = await owner.json(`/api/replays/${replayId}/share`, { method: "POST", json: { roundId: "r03" } }, 201);
    expect(fresh.token).not.toBe(first.token);
    await owner.json(`/api/replays/${replayId}/share`, { method: "DELETE" }, 200);
  });

  it("rejects a forged token", async () => {
    const forged = new Client("forged", "A".repeat(43));
    expect((await forged.req(`/api/replays/${replayId}`)).status).toBe(404);
  });
});

describe("bookmarks and notes", () => {
  let personal = "";
  let teamNote = "";
  it("creates personal and team items anchored to a tick", async () => {
    const r = manifest.rounds[2];
    personal = (await owner.json(`/api/replays/${replayId}/review`, { method: "POST", json: { kind: "bookmark", roundId: r.id, tick: r.freezeEndTick + 100, title: "Mid take" } }, 201)).id;
    teamNote = (await owner.json(`/api/replays/${replayId}/review`, { method: "POST", json: { kind: "note", roundId: r.id, tick: r.freezeEndTick + 200, body: "Watch the A smoke", teamId } }, 201)).id;
    const bad = await owner.json(`/api/replays/${replayId}/review`, { method: "POST", json: { kind: "note", roundId: r.id, tick: r.endTick + 5, body: "x" } }, 400);
    expect(bad.error.code).toBe("BAD_ANCHOR");
  });

  it("scopes visibility: personal to the author, team items to members", async () => {
    const mine = await owner.json(`/api/replays/${replayId}/review`);
    expect(mine.bookmarks.map((b: any) => b.id)).toContain(personal);
    expect(mine.notes[0].status).toBe("current");
    const theirs = await mate.json(`/api/replays/${replayId}/review`);
    expect(theirs.bookmarks.map((b: any) => b.id)).not.toContain(personal);
    expect(theirs.notes.map((n: any) => n.id)).toContain(teamNote);
    expect((await outsider.req(`/api/replays/${replayId}/review`)).status).toBe(404);
  });

  it("edits and deletes with author / coach permissions", async () => {
    await owner.json(`/api/replays/${replayId}/review/${personal}`, { method: "PATCH", json: { title: "Mid take (fast)" } }, 200);
    expect((await mate.req(`/api/replays/${replayId}/review/${personal}`, { method: "PATCH", json: { title: "x" } })).status).toBe(404);
    expect((await mate.req(`/api/replays/${replayId}/review/${teamNote}`, { method: "DELETE" })).status).toBe(403);
    await owner.json(`/api/replays/${replayId}/review/${personal}`, { method: "DELETE" }, 200);
    const after = await owner.json(`/api/replays/${replayId}/review`);
    expect(after.bookmarks.map((b: any) => b.id)).not.toContain(personal);
  });

  it("refuses team items for a team that cannot open the replay", async () => {
    const other = (await mate.json("/api/teams", { method: "POST", json: { name: `Other ${run}` } }, 201)).id;
    const r = manifest.rounds[0];
    const res = await mate.json(`/api/replays/${replayId}/review`, { method: "POST", json: { kind: "note", roundId: r.id, tick: r.startTick, body: "x", teamId: other } }, 400);
    expect(res.error.code).toBe("TEAM_NO_ACCESS");
  });
});

describe("playlists", () => {
  let pl = "";
  let version = 0;
  it("adds entries only from replays the user can open", async () => {
    const created = await owner.json("/api/playlists", { method: "POST", json: { name: "Anti-ecos", teamId } }, 201);
    pl = created.id;
    for (const i of [0, 3, 5]) {
      const r = manifest.rounds[i];
      const e = await owner.json(`/api/playlists/${pl}/entries`, { method: "POST", json: { replayId, roundId: r.id, tick: r.freezeEndTick, label: `R${r.displayNumber}` } }, 201);
      version = e.version;
    }
    const mine = await outsider.json("/api/playlists", { method: "POST", json: { name: "Sneaky" } }, 201);
    expect((await outsider.req(`/api/playlists/${mine.id}/entries`, { method: "POST", json: { replayId, roundId: "r01", tick: manifest.rounds[0].startTick } })).status).toBe(404);
    expect((await outsider.req(`/api/playlists/${pl}`)).status).toBe(404);
  });

  it("reorders transactionally and rejects stale versions", async () => {
    const before = await owner.json(`/api/playlists/${pl}`);
    const ids = before.entries.map((e: any) => e.id);
    const r1 = await owner.json(`/api/playlists/${pl}/entries`, { method: "PUT", json: { version, order: [ids[2], ids[0], ids[1]] } }, 200);
    const stale = await mate.json(`/api/playlists/${pl}/entries`, { method: "PUT", json: { version, order: [ids[1], ids[0], ids[2]] } }, 409);
    expect(stale.error.code).toBe("VERSION_CONFLICT");
    const after = await mate.json(`/api/playlists/${pl}`);
    expect(after.entries.map((e: any) => e.label)).toEqual(["R6", "R1", "R4"]);
    version = r1.version;
  });

  it("concurrent reorders: exactly one wins", async () => {
    const cur = await owner.json(`/api/playlists/${pl}`);
    const ids = cur.entries.map((e: any) => e.id);
    const v = cur.playlist.version;
    const [a, b] = await Promise.all([
      owner.req(`/api/playlists/${pl}/entries`, { method: "PUT", json: { version: v, order: [ids[1], ids[2], ids[0]] } }),
      mate.req(`/api/playlists/${pl}/entries`, { method: "PUT", json: { version: v, order: [ids[2], ids[1], ids[0]] } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it("hides entries whose replay the viewer cannot open", async () => {
    await owner.json(`/api/replays/${replayId}/grants?teamId=${teamId}`, { method: "DELETE" }, 200);
    const seen = await mate.json(`/api/playlists/${pl}`);
    expect(seen.entries.every((e: any) => e.available === false && e.reason === "no-access" && e.replayId === undefined)).toBe(true);
    await owner.json(`/api/replays/${replayId}/grants`, { method: "POST", json: { teamId } }, 201);
  });

  it("deletes entries and the playlist", async () => {
    const cur = await owner.json(`/api/playlists/${pl}`);
    await owner.json(`/api/playlists/${pl}/entries/${cur.entries[0].id}?version=${cur.playlist.version}`, { method: "DELETE" }, 200);
    const after = await owner.json(`/api/playlists/${pl}`);
    expect(after.entries.map((e: any) => e.position)).toEqual([0, 1]);
    await owner.json(`/api/playlists/${pl}`, { method: "DELETE" }, 200);
    expect((await owner.req(`/api/playlists/${pl}`)).status).toBe(404);
  });
});

describe("voice comms", () => {
  let track = "";
  const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(2048, 0)]);
  it("uploads an MP3 privately and streams with range support", async () => {
    const slot = await owner.json(`/api/replays/${replayId}/audio`, { method: "POST", json: { filename: "comms.mp3", size: mp3.length, label: "Team comms", offsetMs: 1500 } }, 201);
    track = slot.trackId;
    await fetch(abs(slot.upload.url), { method: "PUT", body: new Uint8Array(mp3), headers: slot.upload.headers });
    await owner.json(`/api/replays/${replayId}/audio/${track}/complete`, { method: "POST" }, 200);
    const list = await owner.json(`/api/replays/${replayId}/audio`);
    expect(list.tracks[0].offsetMs).toBe(1500);
    const r = await fetch(BASE + list.tracks[0].streamUrl, { headers: { Range: "bytes=0-9" } });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe(`bytes 0-9/${mp3.length}`);
    expect(Buffer.from(await r.arrayBuffer()).subarray(0, 3).toString()).toBe("ID3");
  });

  it("rejects non-MP3 files", async () => {
    const res = await owner.json(`/api/replays/${replayId}/audio`, { method: "POST", json: { filename: "comms.wav", size: 10, label: "x" } }, 400);
    expect(res.error.code).toBe("UNSUPPORTED_AUDIO");
  });

  it("stays private to link viewers and teammates unless shared explicitly", async () => {
    const { token } = await owner.json(`/api/replays/${replayId}/share`, { method: "POST" }, 201);
    const viewer = new Client("link2", token);
    expect((await viewer.json(`/api/replays/${replayId}/audio`)).tracks).toEqual([]);
    expect((await mate.json(`/api/replays/${replayId}/audio`)).tracks).toEqual([]);
    expect((await outsider.req(`/api/replays/${replayId}/audio`)).status).toBe(404);
    await owner.json(`/api/replays/${replayId}/audio/${track}`, { method: "PATCH", json: { shareWithLink: true } }, 200);
    const shared = await viewer.json(`/api/replays/${replayId}/audio`);
    expect(shared.tracks).toHaveLength(1);
    expect(shared.tracks[0].canManage).toBe(false);
    const url = shared.tracks[0].streamUrl;
    expect((await fetch(BASE + url)).status).toBe(200);
    await owner.json(`/api/replays/${replayId}/share`, { method: "DELETE" }, 200);
    expect((await fetch(BASE + url)).status).toBe(404);
    // Tampered signature
    expect((await fetch(BASE + url.replace(/sig=[^&]+/, "sig=AAAA"))).status).toBe(403);
  });
});

describe("deletion", () => {
  it("invalidates viewer and link access immediately", async () => {
    const { done } = await upload(owner, synthetic({ map: "de_nuke", winners: "ABA" }));
    const r = await waitReady(owner, done.replayId);
    expect(r.manifest.capabilities.floors).toBe("rule-based");
    const { token } = await owner.json(`/api/replays/${done.replayId}/share`, { method: "POST" }, 201);
    const viewer = new Client("link3", token);
    expect((await viewer.req(`/api/replays/${done.replayId}`)).status).toBe(200);
    await owner.json(`/api/replays/${done.replayId}`, { method: "DELETE" }, 200);
    expect((await owner.req(`/api/replays/${done.replayId}`)).status).toBe(404);
    expect((await viewer.req(`/api/replays/${done.replayId}/rounds/r01`)).status).toBe(404);
  }, 60_000);
});

describe("payload compression", () => {
  it("is served as a single gzip layer", async () => {
    const r = await owner.req(`/api/replays/${replayId}/rounds/r01`, { headers: { "Accept-Encoding": "gzip" } });
    expect(r.headers.get("content-encoding")).toBeNull();
    const raw = Buffer.from(await r.arrayBuffer());
    // Next.js streams route responses (chunked), so Content-Length may be absent; when present it must match.
    const len = r.headers.get("content-length");
    if (len !== null) expect(Number(len)).toBe(raw.length);
    expect(raw.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(JSON.parse(gunzipSync(raw).toString()).roundId).toBe("r01");
  });
});

describe("team names", () => {
  it("owner can rename teams; the edit reaches the manifest and can be restored", async () => {
    const original = manifest.teams.A.name;
    await owner.json(`/api/replays/${replayId}`, { method: "PATCH", json: { teamAName: "Alpha Edited" } }, 200);
    const r = await owner.json(`/api/replays/${replayId}`);
    expect(r.manifest.teams.A.name).toBe("Alpha Edited");
    expect(r.manifest.teams.A.nameSource).toBe("edited");
    expect(r.replay.teamA).toBe("Alpha Edited");
    const lib = await owner.json(`/api/replays?q=Alpha%20Edited`);
    expect(lib.replays.map((x: any) => x.id)).toContain(replayId);
    expect((await outsider.req(`/api/replays/${replayId}`, { method: "PATCH", json: { teamAName: "x" } })).status).toBe(404);
    expect((await mate.req(`/api/replays/${replayId}`, { method: "PATCH", json: { teamAName: "x" } })).status).toBe(403);
    await owner.json(`/api/replays/${replayId}`, { method: "PATCH", json: { teamAName: null } }, 200);
    expect((await owner.json(`/api/replays/${replayId}`)).manifest.teams.A.name).toBe(original);
  });
});

describe("website and login gate", () => {
  it("serves the public site and sends signed-out visitors from the app to /login", async () => {
    const home = await anon.req("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("seen from above");
    for (const path of ["/replays", "/replays/new", "/teams"]) {
      const r = await anon.req(path);
      expect(r.status, path).toBe(307);
      expect(r.headers.get("location"), path).toContain(`/login?next=${encodeURIComponent(path)}`);
    }
    // Replay pages stay reachable so round and read-only links (token in the fragment) can open.
    expect((await anon.req("/replays/abcdefghijkl")).status).toBe(200);
    expect((await owner.req("/replays")).status).toBe(200);
  });
});

describe("personal and team demo pages", () => {
  it("personal lists your own non-team uploads; team lists what is uploaded to or shared with that team", async () => {
    const t2 = await mate.json("/api/teams", { method: "POST", json: { name: `Mate team ${run}` } }, 201);
    const { done } = await upload(mate, synthetic({ map: "de_dust2", winners: "AB" }), "team.dem", { teamId: t2.id });
    await waitReady(mate, done.replayId);
    const { done: own } = await upload(mate, synthetic({ map: "de_dust2", winners: "BA" }), "mine.dem");
    await waitReady(mate, own.replayId);
    const ids = (r: any) => r.replays.map((x: any) => x.id);

    const matePersonal = ids(await mate.json("/api/replays?scope=personal", {}, 200));
    expect(matePersonal).toContain(own.replayId);
    expect(matePersonal).not.toContain(done.replayId);
    const mateTeam = ids(await mate.json(`/api/replays?scope=team&teamId=${t2.id}`, {}, 200));
    expect(mateTeam).toContain(done.replayId);
    expect(mateTeam).not.toContain(own.replayId);
    // The owner's replay is shared with the first team, so it is in that team's page for the mate.
    expect(ids(await mate.json(`/api/replays?scope=team&teamId=${teamId}`, {}, 200))).toContain(replayId);
    expect(ids(await mate.json("/api/replays?scope=personal", {}, 200))).not.toContain(replayId);
    // Someone outside the team sees nothing of it, even when asking for the team id.
    expect(ids(await outsider.json(`/api/replays?scope=team&teamId=${t2.id}`, {}, 200))).toEqual([]);
    expect(ids(await owner.json("/api/replays?scope=personal", {}, 200))).toContain(replayId);
  }, 120_000);
});

describe("stats across demos", () => {
  it("lists named teams from your demos and builds a team overview; outsiders see none of it", async () => {
    await owner.json(`/api/replays/${replayId}`, { method: "PATCH", json: { teamAName: `Harbour ${run}`, teamBName: `Rivals ${run}` } }, 200);
    const hub = await owner.json("/api/stats", {}, 200);
    const harbour = hub.teams.find((t: any) => t.name === `Harbour ${run}`);
    expect(harbour).toMatchObject({ demos: 1 });
    const team = await owner.json(`/api/stats/team?name=${encodeURIComponent(`harbour ${run}`)}`, {}, 200);
    expect(team.name).toBe(`Harbour ${run}`);
    expect(team.overall.rounds.p).toBe(manifest.rounds.length);
    expect(team.opponents[0].name).toBe(`Rivals ${run}`);
    expect(team.matches[0].replayId).toBe(replayId);
    expect((await outsider.json("/api/stats", {}, 200)).teams.some((t: any) => t.name === `Harbour ${run}`)).toBe(false);
    expect((await outsider.req(`/api/stats/team?name=${encodeURIComponent(`Harbour ${run}`)}`)).status).toBe(404);
    expect((await anon.req("/api/stats")).status).toBe(401);
    await owner.json(`/api/replays/${replayId}`, { method: "PATCH", json: { teamAName: null, teamBName: null } }, 200);
  });
});

describe("heatmaps and utility", () => {
  it("serves positions and grenades for a replay to people who can open it, round links only their round", async () => {
    const pos = await owner.json(`/api/insights?replay=${replayId}&team=A&layer=pos`, {}, 200);
    expect(pos.mapId).toBe("de_mirage");
    expect(pos.points.length).toBeGreaterThan(0);
    const early = await owner.json(`/api/insights?replay=${replayId}&team=A&layer=pos&from=0&to=4`, {}, 200);
    expect(early.points.length).toBeLessThan(pos.points.length);
    expect((await owner.req(`/api/insights?replay=${replayId}&team=C`)).status).toBe(400);
    expect((await owner.req(`/api/insights?replay=${replayId}&team=A&layer=nope`)).status).toBe(400);
    expect((await outsider.req(`/api/insights?replay=${replayId}&team=A`)).status).toBe(404);
    const { token } = await owner.json(`/api/replays/${replayId}/share`, { method: "POST", json: { roundId: "r02" } }, 201);
    const one = await new Client("rl", token).json(`/api/insights?replay=${replayId}&team=A&layer=pos`, {}, 200);
    expect(one.points.length).toBeGreaterThan(0);
    expect(one.points.length).toBeLessThan(pos.points.length);
    await owner.json(`/api/replays/${replayId}/share`, { method: "DELETE" }, 200);
  });
});

describe("moving demos and invite links", () => {
  it("owner moves a demo into a team and back; others cannot", async () => {
    const t = await owner.json("/api/teams", { method: "POST", json: { name: `Move ${run}` } }, 201);
    await owner.json(`/api/replays/${replayId}`, { method: "PATCH", json: { teamId: t.id, visibility: "team" } }, 200);
    expect((await owner.json(`/api/replays?scope=team&teamId=${t.id}`)).replays.map((r: any) => r.id)).toContain(replayId);
    expect((await owner.json("/api/replays?scope=personal")).replays.map((r: any) => r.id)).not.toContain(replayId);
    expect((await mate.req(`/api/replays/${replayId}`, { method: "PATCH", json: { teamId: null, visibility: "private" } })).status).toBe(403);
    await owner.json(`/api/replays/${replayId}`, { method: "PATCH", json: { teamId: null, visibility: "private" } }, 200);
    expect((await owner.json("/api/replays?scope=personal")).replays.map((r: any) => r.id)).toContain(replayId);
  });

  it("invite links add members with the chosen role, expire on revoke, and only managers create them", async () => {
    const t = await owner.json("/api/teams", { method: "POST", json: { name: `Invite ${run}` } }, 201);
    const inv = await owner.json(`/api/teams/${t.id}/invites`, { method: "POST", json: { role: "analyst" } }, 201);
    expect((await outsider.json(`/api/invites?token=${inv.token}`, {}, 200))).toMatchObject({ teamName: `Invite ${run}`, role: "analyst", alreadyMember: false });
    expect((await anon.req(`/api/invites?token=${inv.token}`)).status).toBe(401);
    const joined = await outsider.json("/api/invites", { method: "POST", json: { token: inv.token } }, 201);
    expect(joined).toMatchObject({ teamId: t.id, joined: true, role: "analyst" });
    expect((await outsider.json("/api/invites", { method: "POST", json: { token: inv.token } }, 200)).joined).toBe(false);
    const team = await owner.json(`/api/teams/${t.id}`, {}, 200);
    expect(team.members.find((m: any) => m.role === "analyst")).toBeTruthy();
    // Analysts cannot create invites; owner role cannot be invited.
    expect((await outsider.req(`/api/teams/${t.id}/invites`, { method: "POST", json: { role: "player" } })).status).toBe(403);
    expect((await owner.req(`/api/teams/${t.id}/invites`, { method: "POST", json: { role: "owner" } })).status).toBe(400);
    await owner.json(`/api/teams/${t.id}/invites`, { method: "DELETE" }, 200);
    expect((await mate.req(`/api/invites?token=${inv.token}`)).status).toBe(404);
    expect((await mate.req("/api/invites", { method: "POST", json: { token: inv.token } })).status).toBe(404);
    expect((await mate.req("/api/invites", { method: "POST", json: { token: "x".repeat(43) } })).status).toBe(404);
  });
});

describe("round search", () => {
  it("finds tagged rounds in your demos and nothing in other people's", async () => {
    await owner.json(`/api/replays/${replayId}`, { method: "PATCH", json: { teamAName: `Seek ${run}`, teamBName: `Hide ${run}` } }, 200);
    const all = await owner.json(`/api/rounds/search?team=${encodeURIComponent(`Seek ${run}`)}`, {}, 200);
    expect(all.results.length).toBe(manifest.rounds.length);
    expect(all.results[0]).toMatchObject({ replayId, team: `Seek ${run}`, opponent: `Hide ${run}` });
    expect(Array.isArray(all.results[0].tags)).toBe(true);
    const won = await owner.json(`/api/rounds/search?team=${encodeURIComponent(`Seek ${run}`)}&result=won`, {}, 200);
    expect(won.results.every((r: any) => r.won)).toBe(true);
    const pistol = await owner.json(`/api/rounds/search?team=${encodeURIComponent(`Seek ${run}`)}&tags=pistol`, {}, 200);
    expect(pistol.results.map((r: any) => r.number).sort((a: number, b: number) => a - b)).toEqual([1, 13]);
    expect((await owner.req("/api/rounds/search?tags=nonsense")).status).toBe(400);
    expect((await outsider.json(`/api/rounds/search?team=${encodeURIComponent(`Seek ${run}`)}`, {}, 200)).results).toEqual([]);
    await owner.json(`/api/replays/${replayId}`, { method: "PATCH", json: { teamAName: null, teamBName: null } }, 200);
  });
});

describe("watchlist and tendencies", () => {
  it("watching a team lists it with new demos until its page is opened; tendencies summarise its rounds", async () => {
    await owner.json(`/api/replays/${replayId}`, { method: "PATCH", json: { teamAName: `Watch ${run}`, teamBName: `Other ${run}` } }, 200);
    await owner.json("/api/stats/watch", { method: "POST", json: { name: `Watch ${run}` } }, 201);
    // Pretend we last looked before the demo was uploaded.
    await owner.json("/api/stats/watch", {}, 200);
    const hub = await owner.json("/api/stats", {}, 200);
    const w = hub.watched.find((x: any) => x.name === `Watch ${run}`);
    expect(w).toMatchObject({ demos: 1 });
    const team = await owner.json(`/api/stats/team?name=${encodeURIComponent(`Watch ${run}`)}`, {}, 200);
    expect(team.watched).toBe(true);
    expect((await owner.json("/api/stats", {}, 200)).watched.find((x: any) => x.name === `Watch ${run}`).newDemos).toBe(0);
    const t = await owner.json(`/api/stats/tendencies?name=${encodeURIComponent(`Watch ${run}`)}`, {}, 200);
    expect(t.demos).toBe(1);
    expect(t.tSide.rounds + t.ctSide.rounds).toBe(manifest.rounds.length);
    expect(t.economy.pistol.of).toBe(2);
    expect((await outsider.req(`/api/stats/tendencies?name=${encodeURIComponent(`Watch ${run}`)}`)).status).toBe(404);
    await owner.json(`/api/stats/watch?name=${encodeURIComponent(`Watch ${run}`)}`, { method: "DELETE" }, 200);
    expect((await owner.json("/api/stats", {}, 200)).watched.some((x: any) => x.name === `Watch ${run}`)).toBe(false);
    await owner.json(`/api/replays/${replayId}`, { method: "PATCH", json: { teamAName: null, teamBName: null } }, 200);
  });
});

