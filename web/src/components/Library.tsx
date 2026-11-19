"use client";
import Link from "next/link";
import { PlanNotice } from "./BillingPage";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { mapIcon } from "@/viewer/icons";
import { listMaps, mapName } from "@/viewer/maps";
import { api, ApiError } from "./api";
import { IconUpload } from "./icons";

interface ReplayItem {
  id: string;
  title: string | null;
  status: string;
  failureCode: string | null;
  failureDetail: string | null;
  mapId: string | null;
  teamA: string | null;
  teamB: string | null;
  scoreA: number | null;
  scoreB: number | null;
  roundCount: number | null;
  sourceType: string | null;
  sourceFilename: string | null;
  sourceAvailable: boolean;
  createdAt: string;
  ownerName: string;
  teamName: string | null;
  isOwner: boolean;
  visibility: string;
  seriesId: string | null;
  seriesMapIndex: number | null;
}

interface CatalogueEntry {
  id: string; provider: string; eventName: string | null; matchName: string; seriesId: string | null; mapIndex: number | null;
  mapId: string | null; licence: string; provenanceUrl: string | null; playedAt: string | null; entitled: boolean; replayId: string | null; status: string;
}

interface PlaylistItem { id: string; name: string; description: string | null; teamName: string | null; entries: number; mine: boolean; updatedAt: string }

const STATUS: Record<string, { label: string; cls: string }> = {
  uploading: { label: "Uploading", cls: "badge-warn" },
  queued: { label: "Queued", cls: "badge-warn" },
  processing: { label: "Processing", cls: "badge-warn" },
  ready: { label: "Ready", cls: "badge-ok" },
  failed: { label: "Failed", cls: "badge-err" },
};

export function MapTile({ mapId }: { mapId: string | null | undefined }) {
  const icon = mapIcon(mapId);
  return (
    <div className="map-tile">
      {icon ? <img src={icon} alt="" /> : null}
      <span>{mapId ? mapName(mapId) : "—"}</span>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, cls: "" };
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
}

type Tab = "replays" | "catalogue" | "playlists";

export function Library() {
  const router = useRouter();
  const params = useSearchParams();
  const tab = (params.get("tab") as Tab) || "replays";
  const [q, setQ] = useState(params.get("q") ?? "");
  const [map, setMap] = useState(params.get("map") ?? "");
  const [scope, setScope] = useState("all");
  const [replays, setReplays] = useState<ReplayItem[] | null>(null);
  const [catalogue, setCatalogue] = useState<CatalogueEntry[] | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ q, map, scope });
      if (tab === "replays") setReplays((await api<{ replays: ReplayItem[] }>(`/api/replays?${qs}`)).replays);
      if (tab === "catalogue") setCatalogue((await api<{ entries: CatalogueEntry[] }>(`/api/catalogue?${qs}`)).entries);
      if (tab === "playlists") setPlaylists((await api<{ playlists: PlaylistItem[] }>(`/api/playlists?${qs}`)).playlists);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.push("/login?next=/replays");
      else setError(e instanceof Error ? e.message : "Could not load the library.");
    }
  }, [q, map, scope, tab, router]);

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  // Poll while anything is still processing.
  const busy = replays?.some((r) => ["queued", "processing", "uploading"].includes(r.status));
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [busy, load]);

  const setTab = (t: Tab) => {
    const p = new URLSearchParams(params.toString());
    p.set("tab", t);
    router.replace(`/replays?${p}`);
  };

  const series = useMemo(() => {
    const m = new Map<string, ReplayItem[]>();
    for (const r of replays ?? []) if (r.seriesId) m.set(r.seriesId, [...(m.get(r.seriesId) ?? []), r]);
    return m;
  }, [replays]);

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>Replay library</h1>
          <p className="page-sub">Your uploads, team replays, the match catalogue and playlists.</p>
        </div>
        <Link className="btn btn-primary" href="/replays/new"><IconUpload /> Upload demo</Link>
      </div>

      <PlanNotice />

      <div className="lib-tabs" role="tablist" aria-label="Library sections">
        {(["replays", "catalogue", "playlists"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === "replays" ? "Replays" : t === "catalogue" ? "Catalogue" : "Playlists"}
          </button>
        ))}
      </div>

      <div className="lib-toolbar">
        <label className="sr-only" htmlFor="lib-search">Search</label>
        <input id="lib-search" className="input grow" placeholder={tab === "playlists" ? "Search playlists" : "Search teams, titles, files"}
          value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} />
        {tab !== "playlists" ? (
          <>
            <label className="sr-only" htmlFor="lib-map">Map</label>
            <select id="lib-map" className="select" value={map} onChange={(e) => setMap(e.target.value)}>
              <option value="">All maps</option>
              {listMaps().map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </select>
          </>
        ) : null}
        {tab === "replays" ? (
          <>
            <label className="sr-only" htmlFor="lib-scope">Show</label>
            <select id="lib-scope" className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">All accessible</option>
              <option value="mine">My uploads</option>
              <option value="team">Team replays</option>
            </select>
          </>
        ) : null}
      </div>

      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}

      {tab === "replays" ? (
        replays === null ? <p className="muted">Loading…</p> : replays.length === 0 ? (
          <div className="empty">
            <p>No replays yet{q || map ? " match these filters" : ""}.</p>
            {!q && !map ? <Link className="btn" href="/replays/new"><IconUpload /> Upload a CS2 demo</Link> : null}
          </div>
        ) : (
          <div className="replay-list">
            {replays.map((r) => (
              <Link key={r.id} href={`/replays/${r.id}`} className="replay-item" aria-label={`${r.title ?? `${r.teamA ?? "Team A"} vs ${r.teamB ?? "Team B"}`}, ${mapName(r.mapId)}, ${r.status}`}>
                <MapTile mapId={r.mapId} />
                <div style={{ minWidth: 0 }}>
                  <div className="replay-title">
                    {r.title || (r.teamA ? `${r.teamA} vs ${r.teamB}` : r.sourceFilename ?? "Untitled demo")}
                  </div>
                  <div className="replay-meta">
                    <span>{new Date(r.createdAt).toLocaleString()}</span>
                    {r.sourceType ? <span>{r.sourceType === "pov" ? "POV demo" : "GOTV demo"}</span> : null}
                    {r.roundCount ? <span>{r.roundCount} rounds</span> : null}
                    {r.teamName ? <span>Team: {r.teamName}</span> : null}
                    {!r.isOwner ? <span>Shared by {r.ownerName}</span> : null}
                    {r.seriesId ? <span>Series map {r.seriesMapIndex ?? "?"} of {series.get(r.seriesId)?.length ?? 1}</span> : null}
                  </div>
                  {r.status === "failed" ? (
                    <div className="replay-meta" style={{ color: "var(--danger)" }}>
                      {r.failureDetail ?? r.failureCode}
                      {r.failureCode === "SOURCE_MISSING" || !r.sourceAvailable ? " Upload the demo again to retry." : ""}
                    </div>
                  ) : null}
                </div>
                <div className="row">
                  {r.status === "ready" && r.scoreA !== null ? <span className="score">{r.scoreA}–{r.scoreB}</span> : null}
                  <StatusBadge status={r.status} />
                </div>
              </Link>
            ))}
          </div>
        )
      ) : null}

      {tab === "catalogue" ? (
        catalogue === null ? <p className="muted">Loading…</p> : catalogue.length === 0 ? (
          <div className="empty">
            <p>No catalogue matches are available yet.</p>
            <p className="faint" style={{ fontSize: 13 }}>The catalogue only lists demos from licensed, project-owned or approved provider feeds.</p>
          </div>
        ) : (
          <div className="replay-list">
            {catalogue.map((c) => {
              const inner = (
                <>
                  <MapTile mapId={c.mapId} />
                  <div style={{ minWidth: 0 }}>
                    <div className="replay-title">{c.matchName}{c.mapIndex ? ` · map ${c.mapIndex}` : ""}</div>
                    <div className="replay-meta">
                      {c.eventName ? <span>{c.eventName}</span> : null}
                      {c.playedAt ? <span>{new Date(c.playedAt).toLocaleDateString()}</span> : null}
                      <span>Source: {c.provider} · {c.licence}</span>
                    </div>
                  </div>
                  <div className="row">
                    {c.entitled ? <StatusBadge status={c.status} /> : <span className="badge">Not included in your access</span>}
                  </div>
                </>
              );
              return c.replayId ? (
                <Link key={c.id} href={`/replays/${c.replayId}`} className="replay-item">{inner}</Link>
              ) : (
                <div key={c.id} className="replay-item" aria-disabled="true" style={{ opacity: c.entitled ? 1 : 0.6 }}>{inner}</div>
              );
            })}
          </div>
        )
      ) : null}

      {tab === "playlists" ? <PlaylistsTab playlists={playlists} reload={load} /> : null}
    </div>
  );
}

function PlaylistsTab({ playlists, reload }: { playlists: PlaylistItem[] | null; reload: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api("/api/playlists", { method: "POST", json: { name } });
      setName("");
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the playlist.");
    }
  }
  return (
    <div className="stack">
      <form className="row" onSubmit={create}>
        <label className="sr-only" htmlFor="new-playlist">New playlist name</label>
        <input id="new-playlist" className="input" placeholder="New playlist name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        <button className="btn">Create playlist</button>
      </form>
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      {playlists === null ? <p className="muted">Loading…</p> : playlists.length === 0 ? (
        <div className="empty">No playlists yet. Create one here, or add moments from the replay viewer.</div>
      ) : (
        <div className="replay-list">
          {playlists.map((p) => (
            <Link key={p.id} href={`/playlists/${p.id}`} className="replay-item" style={{ gridTemplateColumns: "1fr auto" }}>
              <div>
                <div className="replay-title">{p.name}</div>
                <div className="replay-meta">
                  <span>{p.entries} moments</span>
                  {p.teamName ? <span>Team: {p.teamName}</span> : <span>Personal</span>}
                  <span>Updated {new Date(p.updatedAt).toLocaleString()}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
