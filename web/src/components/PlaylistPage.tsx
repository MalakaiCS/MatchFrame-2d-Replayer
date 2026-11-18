"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { formatMs } from "@/viewer/clock";
import { MapTile } from "./Library";
import { api, ApiError } from "./api";
import { IconDown, IconEdit, IconPlay, IconTrash, IconUp } from "./icons";

interface Entry {
  id: string; position: number; label: string | null; available: boolean; reason?: string | null;
  replayId?: string; roundId?: string; tick?: number; displayNumber?: number | null; mapId?: string; teamA?: string; teamB?: string;
  title?: string | null; tickIntervalMs?: number; roundStartTick?: number | null; anchorStatus?: string;
}

const REASONS: Record<string, string> = {
  removed: "The source replay was deleted.",
  "no-access": "You no longer have access to the source replay.",
  "not-ready": "The source replay is being reprocessed.",
  "anchor-missing": "This moment no longer exists in the current replay version.",
};

export function PlaylistPage({ id }: { id: string }) {
  const router = useRouter();
  const [data, setData] = useState<{ playlist: { id: string; name: string; description: string | null; version: number }; canEdit: boolean; canDelete: boolean; entries: Entry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api(`/api/playlists/${id}`));
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.push(`/login?next=/playlists/${id}`);
      setError(e instanceof Error ? e.message : "Could not load the playlist.");
    }
  }, [id, router]);
  useEffect(() => void load(), [load]);

  if (error && !data) return <div className="page"><p className="alert alert-err" role="alert">{error}</p></div>;
  if (!data) return <div className="page"><p className="muted">Loading…</p></div>;

  const { playlist, entries } = data;
  const href = (e: Entry) => {
    const ms = e.roundStartTick != null && e.tickIntervalMs && e.tick !== undefined ? Math.round((e.tick - e.roundStartTick) * e.tickIntervalMs) : 0;
    return `/replays/${e.replayId}?r=${e.roundId}&t=${ms}&pl=${playlist.id}&e=${e.id}`;
  };

  async function move(i: number, dir: -1 | 1) {
    const order = entries.map((e) => e.id);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    try {
      await api(`/api/playlists/${id}/entries`, { method: "PUT", json: { version: playlist.version, order } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reorder.");
    }
    load();
  }

  async function removeEntry(entryId: string) {
    try {
      await api(`/api/playlists/${id}/entries/${entryId}?version=${playlist.version}`, { method: "DELETE" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove.");
    }
    load();
  }

  async function relabel(entryId: string, current: string | null) {
    const label = prompt("Label for this moment", current ?? "");
    if (label === null) return;
    await api(`/api/playlists/${id}/entries/${entryId}`, { method: "PATCH", json: { label: label || null, version: playlist.version } }).catch((e) => setError(e.message));
    load();
  }

  async function rename(e: React.FormEvent) {
    e.preventDefault();
    await api(`/api/playlists/${id}`, { method: "PATCH", json: { name } }).catch((err) => setError(err.message));
    setRenaming(false);
    load();
  }

  async function del() {
    if (!confirm("Delete this playlist? The replays themselves are not affected.")) return;
    await api(`/api/playlists/${id}`, { method: "DELETE" });
    router.push("/replays?tab=playlists");
  }

  const first = entries.find((e) => e.available);
  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="grow">
          {renaming ? (
            <form className="row" onSubmit={rename}>
              <label className="sr-only" htmlFor="pl-name">Playlist name</label>
              <input id="pl-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
              <button className="btn btn-primary">Save</button>
              <button type="button" className="btn" onClick={() => setRenaming(false)}>Cancel</button>
            </form>
          ) : <h1>{playlist.name}</h1>}
          <p className="page-sub">{entries.length} moments{playlist.description ? ` · ${playlist.description}` : ""}</p>
        </div>
        {first ? <Link className="btn btn-primary" href={href(first)}><IconPlay /> Play from start</Link> : null}
        {data.canEdit && !renaming ? <button className="btn" onClick={() => { setName(playlist.name); setRenaming(true); }}><IconEdit /> Rename</button> : null}
        {data.canDelete ? <button className="btn btn-danger" onClick={del}><IconTrash /> Delete</button> : null}
      </div>
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      {entries.length === 0 ? <div className="empty">No moments yet. Open a replay and use the Playlists tab to add the current moment.</div> : null}
      <ol className="replay-list" style={{ listStyle: "none", padding: 0 }}>
        {entries.map((e, i) => (
          <li key={e.id} className="replay-item" style={{ gridTemplateColumns: "28px 96px 1fr auto", opacity: e.available ? 1 : 0.6 }}>
            <span className="mono faint">{i + 1}</span>
            <MapTile mapId={e.available ? e.mapId : null} />
            <div style={{ minWidth: 0 }}>
              {e.available ? (
                <>
                  <Link href={href(e)} className="replay-title">{e.label || `${e.teamA} vs ${e.teamB}`}</Link>
                  <div className="replay-meta">
                    <span>Round {e.displayNumber}</span>
                    <span>{formatMs(((e.tick ?? 0) - (e.roundStartTick ?? 0)) * (e.tickIntervalMs ?? 15.625))} into round</span>
                    {e.label ? <span>{e.teamA} vs {e.teamB}</span> : null}
                    {e.anchorStatus === "migrated" ? <span>Updated replay version</span> : null}
                  </div>
                </>
              ) : (
                <>
                  <div className="replay-title">{e.label ?? "Unavailable moment"}</div>
                  <div className="replay-meta">{REASONS[e.reason ?? ""] ?? "Unavailable."}</div>
                </>
              )}
            </div>
            {data.canEdit ? (
              <div className="row">
                <button className="btn btn-ghost icon-btn btn-sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move moment ${i + 1} up`}><IconUp /></button>
                <button className="btn btn-ghost icon-btn btn-sm" onClick={() => move(i, 1)} disabled={i === entries.length - 1} aria-label={`Move moment ${i + 1} down`}><IconDown /></button>
                <button className="btn btn-ghost icon-btn btn-sm" onClick={() => relabel(e.id, e.label)} aria-label={`Edit label of moment ${i + 1}`}><IconEdit /></button>
                <button className="btn btn-ghost icon-btn btn-sm btn-danger" onClick={() => removeEntry(e.id)} aria-label={`Remove moment ${i + 1}`}><IconTrash /></button>
              </div>
            ) : <span />}
          </li>
        ))}
      </ol>
    </div>
  );
}
