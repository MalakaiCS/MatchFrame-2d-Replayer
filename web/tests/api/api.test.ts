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

function synthetic(params: Record<string, unknown>) {
  return Buffer.concat([Buffer.from("MFSYNTH1"), Buffer.from(JSON.stringify(params))]);
}

async function upload(c: Client, data: Buffer, filename = "match.dem", extra: Record<string, unknown> = {}) {
  const slot = await c.json("/api/uploads", { method: "POST", json: { filename, size: data.length } }, 201);
  const put = await fetch(BASE + slot.upload.url, { method: "PUT", body: new Uint8Array(data), headers: slot.upload.headers });
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
    const big = await owner.json("/api/uploads", { method: "POST", json: { filename: "x.dem", size: 600 * 2 ** 20 } }, 400);
    expect(big.error.code).toBe("TOO_LARGE");
    const gz = await owner.json("/api/uploads", { method: "POST", json: { filename: "x.dem.gz", size: 100 } }, 400);
    expect(gz.error.code).toBe("COMPRESSED_ARCHIVE");
    const bad = Buffer.from("this is not a demo file at all");
    const slot = await owner.json("/api/uploads", { method: "POST", json: { filename: "bad.dem", size: bad.length } }, 201);
    await fetch(BASE + slot.upload.url, { method: "PUT", body: new Uint8Array(bad), headers: slot.upload.headers });
    const r = await owner.json(`/api/uploads/${slot.uploadId}/complete`, { method: "POST", json: {} }, 400);
    expect(r.error.code).toBe("INVALID_DEMO");
  });

  it("rejects a body that does not match the declared size", async () => {
    const slot = await owner.json("/api/uploads", { method: "POST", json: { filename: "a.dem", size: 50 } }, 201);
    const put = await fetch(BASE + slot.upload.url, { method: "PUT", body: new Uint8Array(80), headers: slot.upload.headers });
    expect(put.status).toBe(400);
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
    await fetch(BASE + slot.upload.url, { method: "PUT", body: new Uint8Array(mp3), headers: slot.upload.headers });
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
