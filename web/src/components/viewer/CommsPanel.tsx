"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatMs } from "@/viewer/clock";
import { AudioSync } from "@/viewer/audioSync";
import { api, putWithProgress } from "../api";
import { IconAudio, IconTrash } from "../icons";

export interface Track {
  id: string; label: string; offsetMs: number; durationMs: number | null; teamId: string | null;
  shareWithLink: boolean; canManage: boolean; streamUrl: string;
}

/**
 * Voice comms. Each enabled track gets an <audio> element driven by AudioSync
 * from the replay clock (see viewer/audioSync.ts). `registerSync` lets the
 * viewer's animation loop update every active track each frame.
 */
export function CommsPanel({
  replayId, tickIntervalMs, tick, teams, viaShare, registerSync,
}: {
  replayId: string;
  tickIntervalMs: number;
  tick: number;
  teams: { id: string; name: string }[];
  viaShare: boolean;
  registerSync: (id: string, s: AudioSync | null) => void;
}) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [canUpload, setCanUpload] = useState(false);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ tracks: Track[]; canUpload: boolean }>(`/api/replays/${replayId}/audio`);
      setTracks(r.tracks);
      setCanUpload(r.canUpload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load recordings.");
    }
  }, [replayId]);
  useEffect(() => void load(), [load]);

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const file = f.get("file") as File;
    if (!file?.name) return;
    setError(null);
    try {
      const slot = await api<{ trackId: string; upload: { url: string; headers: Record<string, string> } }>(`/api/replays/${replayId}/audio`, {
        method: "POST",
        json: { filename: file.name, size: file.size, label: String(f.get("label") || file.name), teamId: String(f.get("teamId") || "") || null, offsetMs: Math.round(Number(f.get("offset") || 0) * 1000) },
      });
      setProgress(0);
      await putWithProgress(slot.upload.url, file, slot.upload.headers, setProgress);
      await api(`/api/replays/${replayId}/audio/${slot.trackId}/complete`, { method: "POST" });
      setProgress(null);
      (e.target as HTMLFormElement).reset();
      load();
    } catch (err) {
      setProgress(null);
      setError(err instanceof Error ? err.message : "Upload failed.");
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    try {
      await api(`/api/replays/${replayId}/audio/${id}`, { method: "PATCH", json: body });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update.");
    }
  }

  return (
    <div>
      <p className="faint" style={{ fontSize: 12, marginTop: 0 }}>
        Recordings follow the replay: play, pause, seeking and speed changes keep them in sync. They are private to the uploader and the chosen team
        {viaShare ? "." : " and are never included in a read-only link unless you allow it per recording."}
      </p>
      {tracks.length === 0 ? <p className="faint">No recordings available to you for this replay.</p> : null}
      {tracks.map((t) => (
        <TrackRow key={t.id} t={t} tick={tick} tickIntervalMs={tickIntervalMs} enabled={!!enabled[t.id]}
          setEnabled={(on) => setEnabled((s) => ({ ...s, [t.id]: on }))}
          registerSync={registerSync} patch={(b) => patch(t.id, b)}
          remove={async () => { if (confirm("Delete this recording?")) { await api(`/api/replays/${replayId}/audio/${t.id}`, { method: "DELETE" }); load(); } }} />
      ))}
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      {canUpload ? (
        <form onSubmit={upload} className="stack" style={{ marginTop: 12 }}>
          <div className="dock-section-title">Add a recording (MP3)</div>
          <input className="input" name="label" placeholder="Label, e.g. Team comms" maxLength={120} aria-label="Recording label" />
          <input type="file" name="file" accept=".mp3,audio/mpeg" required aria-label="MP3 file" />
          <div className="row">
            <label className="muted" style={{ fontSize: 12 }} htmlFor="audio-offset">Starts at demo time (s)</label>
            <input id="audio-offset" className="input" name="offset" type="number" step="0.1" defaultValue={0} style={{ width: 100 }} />
          </div>
          <select className="select" name="teamId" aria-label="Who can listen" defaultValue="">
            <option value="">Only me</option>
            {teams.map((x) => <option key={x.id} value={x.id}>Team: {x.name}</option>)}
          </select>
          {progress !== null ? <div className="progress"><div style={{ width: `${progress * 100}%` }} /></div> : null}
          <div><button className="btn">Upload recording</button></div>
        </form>
      ) : null}
    </div>
  );
}

function TrackRow({
  t, tick, tickIntervalMs, enabled, setEnabled, registerSync, patch, remove,
}: {
  t: Track; tick: number; tickIntervalMs: number; enabled: boolean; setEnabled: (on: boolean) => void;
  registerSync: (id: string, s: AudioSync | null) => void; patch: (b: Record<string, unknown>) => void; remove: () => void;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const [volume, setVolume] = useState(1);
  const [offset, setOffset] = useState(t.offsetMs);
  const [syncAt, setSyncAt] = useState("");
  useEffect(() => setOffset(t.offsetMs), [t.offsetMs]);

  useEffect(() => {
    if (!ref.current) return;
    if (enabled) {
      const s = new AudioSync(ref.current, offset, tickIntervalMs);
      registerSync(t.id, s);
    } else {
      registerSync(t.id, null);
      ref.current.pause();
    }
    return () => registerSync(t.id, null);
  }, [enabled, offset, tickIntervalMs, registerSync, t.id]);

  useEffect(() => {
    if (ref.current) ref.current.volume = volume;
  }, [volume]);

  const onMeta = () => {
    const d = ref.current?.duration;
    if (t.canManage && d && Number.isFinite(d) && !t.durationMs) patch({ durationMs: Math.round(d * 1000) });
  };

  const nudge = (ms: number) => {
    const v = offset + ms;
    setOffset(v);
    if (t.canManage) patch({ offsetMs: v });
  };

  /** Align: the audio time entered (mm:ss.s) plays at the current replay tick. */
  const alignHere = () => {
    const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(syncAt.trim());
    if (!m) return;
    const audioMs = (Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000;
    const v = Math.round(tick * tickIntervalMs - audioMs);
    setOffset(v);
    if (t.canManage) patch({ offsetMs: v });
  };

  return (
    <div className="review-item">
      <div className="row">
        <IconAudio />
        <strong className="grow">{t.label}</strong>
        <label className="row" style={{ fontSize: 13 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Play with replay
        </label>
      </div>
      <audio ref={ref} src={t.streamUrl} preload="metadata" onLoadedMetadata={onMeta} />
      <div className="row wrap" style={{ marginTop: 6, fontSize: 12 }}>
        <label className="row">Volume <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label={`${t.label} volume`} /></label>
        <span className="faint">Offset {formatMs(offset)} ({(offset / 1000).toFixed(2)} s)</span>
      </div>
      <div className="row wrap" style={{ marginTop: 6 }}>
        <span className="muted" style={{ fontSize: 12 }}>Nudge</span>
        {[-1000, -100, 100, 1000].map((ms) => (
          <button key={ms} type="button" className="btn btn-sm" onClick={() => nudge(ms)} aria-label={`Shift audio ${ms > 0 ? "later" : "earlier"} by ${Math.abs(ms)} ms`}>
            {ms > 0 ? "+" : "−"}{Math.abs(ms) >= 1000 ? `${Math.abs(ms) / 1000}s` : `${Math.abs(ms)}ms`}
          </button>
        ))}
      </div>
      <div className="row wrap" style={{ marginTop: 6 }}>
        <label className="muted" style={{ fontSize: 12 }} htmlFor={`sync-${t.id}`}>Audio time heard now</label>
        <input id={`sync-${t.id}`} className="input" style={{ width: 90 }} placeholder="12:34.5" value={syncAt} onChange={(e) => setSyncAt(e.target.value)} />
        <button type="button" className="btn btn-sm" onClick={alignHere}>Align to this moment</button>
      </div>
      {t.canManage ? (
        <div className="row wrap" style={{ marginTop: 6 }}>
          <label className="row" style={{ fontSize: 12 }}>
            <input type="checkbox" checked={t.shareWithLink} onChange={(e) => patch({ shareWithLink: e.target.checked })} /> Include in read-only links
          </label>
          <span className="grow" />
          <button type="button" className="btn btn-ghost btn-sm btn-danger" onClick={remove} aria-label={`Delete ${t.label}`}><IconTrash /></button>
        </div>
      ) : null}
    </div>
  );
}
