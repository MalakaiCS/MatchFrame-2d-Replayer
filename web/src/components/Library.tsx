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

interface PlaylistItem { id: string; name: string; description: string | null; teamId: string | null; teamName: string | null; entries: number; mine: boolean; updatedAt: string }
interface TeamItem { id: string; name: string; role: string; members: number }

/** Two demo spaces, as in EDGE: Personal (only you) and Team (everyone on the selected team). */
export type Space = "personal" | "team";

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

export function Library({ space = "personal" }: { space?: Space }) {
  const router = useRouter();
  const params = useSearchParams();
  const base = space === "team" ? "/replays/team" : "/replays";
  const tabs: Tab[] = space === "team" ? ["replays", "playlists"] : ["replays", "playlists", "catalogue"];
  const tab = tabs.includes(params.get("tab") as Tab) ? (params.get("tab") as Tab) : "replays";
  const [teams, setTeams] = useState<TeamItem[] | null>(space === "team" ? null : []);
  const teamId = space === "team" ? (teams?.find((t) => t.id === params.get("team"))?.id ?? teams?.[0]?.id ?? null) : null;
  const team = teams?.find((t) => t.id === teamId) ?? null;
  const [q, setQ] = useState(params.get("q") ?? "");
  const [map, setMap] = useState(params.get("map") ?? "");
  const [replays, setReplays] = useState<ReplayItem[] | null>(null);
  const [catalogue, setCatalogue] = useState<CatalogueEntry[] | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (space !== "team") return;
    api<{ teams: TeamItem[] }>("/api/teams").then((r) => setTeams(r.teams)).catch((e) => {
      if (e instanceof ApiError && e.status === 401) router.push(`/login?next=${base}`);
      else setTeams([]);
    });
  }, [space, router, base]);

  const load = useCallback(async () => {
    if (space === "team" && !teamId) return;
    try {
      const qs = new URLSearchParams({ q, map, scope: space, ...(teamId ? { teamId } : {}) });
      if (tab === "replays") setReplays((await api<{ replays: ReplayItem[] }>(`/api/replays?${qs}`)).replays);
      if (tab === "catalogue") setCatalogue((await api<{ entries: CatalogueEntry[] }>(`/api/catalogue?${qs}`)).entries);
      if (tab === "playlists") setPlaylists((await api<{ playlists: PlaylistItem[] }>(`/api/playlists?${qs}`)).playlists);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.push(`/login?next=${base}`);
      else setError(e instanceof Error ? e.message : "Could not load the library.");
    }
  }, [q, map, space, teamId, tab, router, base]);

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
    router.replace(`${base}?${p}`);
  };
  const pickTeam = (id: string) => {
    const p = new URLSearchParams(params.toString());
    p.set("team", id);
    setReplays(null);
    router.replace(`${base}?${p}`);
  };
  const uploadHref = `/replays/new?to=${space === "team" && teamId ? encodeURIComponent(teamId) : "personal"}`;
  const shownPlaylists = playlists?.filter((p) => (space === "team" ? p.teamId === teamId : !p.teamId)) ?? null;

  const series = useMemo(() => {
    const m = new Map<string, ReplayItem[]>();
    for (const r of replays ?? []) if (r.seriesId) m.set(r.seriesId, [...(m.get(r.seriesId) ?? []), r]);
    return m;
  }, [replays]);

  return (
    <div className="page">
      <nav className="space-switch" aria-label="Demo spaces">
        <Link href="/replays" aria-current={space === "personal" ? "page" : undefined}>Personal</Link>
        <Link href="/replays/team" aria-current={space === "team" ? "page" : undefined}>Team</Link>
      </nav>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>{space === "team" ? (team ? `${team.name} demos` : "Team demos") : "Personal demos"}</h1>
          <p className="page-sub">
            {space === "team"
              ? "Everything uploaded to the team. Everyone on the team can see these demos, notes and playlists."
              : "Only you can see these, plus anything someone shared with you directly."}
          </p>
        </div>
        <div className="row">
          {space === "team" && teams && teams.length > 1 ? (
            <>
              <label className="sr-only" htmlFor="lib-team">Team</label>
              <select id="lib-team" className="select" value={teamId ?? ""} onChange={(e) => pickTeam(e.target.value)}>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </>
          ) : null}
          {space === "personal" || teamId ? (
            <Link className="btn btn-primary" href={uploadHref}><IconUpload /> {space === "team" ? "Upload to team" : "Upload demo"}</Link>
          ) : null}
        </div>
      </div>

      <PlanNotice />

      <div className="lib-tabs" role="tablist" aria-label="Library sections">
        {tabs.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === "replays" ? "Demos" : t === "catalogue" ? "Pro catalogue" : "Playlists"}
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
      </div>

      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}

      {space === "team" && teams && teams.length === 0 ? (
        <div className="empty">
          <p>You are not in a team yet.</p>
          <p className="faint" style={{ fontSize: 13 }}>Create a team and add your players. Anything uploaded to it shows up here for everyone on the team.</p>
          <Link className="btn" href="/teams">Create a team</Link>
        </div>
      ) : tab === "replays" ? (
        replays === null ? <p className="muted">Loading…</p> : replays.length === 0 ? (
          <div className="empty">
            <p>{q || map ? "No demos match these filters." : space === "team" ? `No demos in ${team?.name ?? "this team"} yet.` : "No personal demos yet."}</p>
            {!q && !map ? <Link className="btn" href={uploadHref}><IconUpload /> {space === "team" ? "Upload a demo to the team" : "Upload a CS2 demo"}</Link> : null}
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
                    {space === "personal" && r.teamName ? <span>Team: {r.teamName}</span> : null}
                    {space === "team" ? <span>Uploaded by {r.isOwner ? "you" : r.ownerName}</span> : !r.isOwner ? <span>Shared with you by {r.ownerName}</span> : null}
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

      {tab === "playlists" && (space === "personal" || teamId) ? <PlaylistsTab playlists={shownPlaylists} reload={load} teamId={teamId} /> : null}
    </div>
  );
}

function PlaylistsTab({ playlists, reload, teamId }: { playlists: PlaylistItem[] | null; reload: () => void; teamId: string | null }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api("/api/playlists", { method: "POST", json: { name, teamId } });
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
        <div className="empty">{teamId ? "No team playlists yet." : "No personal playlists yet."} Create one here, or add moments from the replay viewer.</div>
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
