"use client";
import Link from "next/link";
import { PlanNotice } from "./BillingPage";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, putWithProgress } from "./api";
import { IconUpload } from "./icons";

type Stage = "idle" | "checking" | "uploading" | "finalising" | "processing" | "ready" | "error";

interface UploadSlot {
  uploadId: string;
  upload: { method: "PUT"; url: string; headers: Record<string, string> };
  maxBytes: number;
}

const MAX_HINT = 1024;

async function sniff(file: File): Promise<string | null> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const s = String.fromCharCode(...head);
  if (s === "PBDEMS2\0" || s === "MFSYNTH1") return null;
  if (s.startsWith("HL2DEMO")) return "This is a CS:GO demo. Only CS2 demos are supported.";
  // Archives are extracted on the server; the demo inside is checked there.
  if ((head[0] === 0x1f && head[1] === 0x8b) || s.startsWith("PK\x03\x04") || s.startsWith("BZh") || s.startsWith("Rar!")) return null;
  return "The file is not a CS2 demo or a supported archive.";
}

export function UploadFlow() {
  const router = useRouter();
  const search = useSearchParams();
  // Where the demo goes: "" = Personal (only you), otherwise a team id (everyone on that team).
  const [dest, setDest] = useState(() => {
    const to = search.get("to");
    return to && to !== "personal" ? to : "";
  });
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [replayId, setReplayId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [teams, setTeams] = useState<{ id: string; name: string; role: string }[]>([]);
  const abort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ teams: { id: string; name: string; role: string }[] }>("/api/teams")
      .then((r) => setTeams(r.teams.filter((t) => t.role !== "viewer")))
      .catch((e) => e instanceof ApiError && e.status === 401 && router.push("/login?next=/replays/new"));
  }, [router]);

  useEffect(() => {
    if (stage !== "processing" || !replayId) return;
    const t = setInterval(async () => {
      try {
        const r = await api<{ replay: { status: string; failureDetail: string | null; failureCode: string | null } }>(`/api/replays/${replayId}`);
        if (r.replay.status === "ready") setStage("ready");
        if (r.replay.status === "failed") {
          setStage("error");
          setFailure(r.replay.failureDetail ?? r.replay.failureCode ?? "Processing failed.");
        }
      } catch {
        /* transient: keep polling */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [stage, replayId]);

  async function choose(f: File | undefined | null) {
    setError(null);
    setFailure(null);
    if (!f) return;
    const lower = f.name.toLowerCase();
    if (!/\.(dem|bz2|gz|zip|rar)$/.test(lower)) return setError("Choose a CS2 demo: .dem, .dem.bz2, .dem.gz, .zip or .rar.");
    if (f.size > MAX_HINT * 2 ** 20) return setError(`The demo is ${(f.size / 2 ** 20).toFixed(0)} MiB; the limit is ${MAX_HINT} MiB.`);
    setStage("checking");
    const bad = await sniff(f);
    if (bad) {
      setStage("idle");
      return setError(bad);
    }
    setStage("idle");
    setFile(f);
  }

  async function start(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file) return;
    const form = new FormData(e.currentTarget);
    setError(null);
    abort.current = new AbortController();
    try {
      setStage("uploading");
      const slot = await api<UploadSlot>("/api/uploads", { method: "POST", json: { filename: file.name, size: file.size, teamId: String(form.get("teamId") || "") || null } });
      await putWithProgress(slot.upload.url, file, slot.upload.headers, setProgress, abort.current.signal);
      setStage("finalising");
      const seriesId = String(form.get("seriesId") || "").trim();
      const done = await api<{ replayId: string; status: string }>(`/api/uploads/${slot.uploadId}/complete`, {
        method: "POST",
        json: {
          title: String(form.get("title") || "") || undefined,
          teamId: String(form.get("teamId") || "") || null,
          seriesId: seriesId || null,
          seriesMapIndex: seriesId ? Number(form.get("seriesMapIndex") || 1) : null,
        },
      });
      setReplayId(done.replayId);
      setStage("processing");
    } catch (err) {
      setStage("error");
      setError(err instanceof Error ? err.message : "The upload failed.");
    }
  }

  const step = (s: Stage[], doneAfter: Stage[]) => (stage === "error" && s.includes("error") ? "error" : s.includes(stage) ? "active" : doneAfter.includes(stage) ? "done" : "idle");

  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <h1>Upload a demo</h1>
      <PlanNotice />
      <p className="page-sub">CS2 demos as <span className="mono">.dem</span>, or compressed as <span className="mono">.dem.bz2</span>, <span className="mono">.dem.gz</span>, <span className="mono">.zip</span> or <span className="mono">.rar</span>. An archive with several maps (e.g. a BO3) becomes one replay per map, linked as a series. Up to {MAX_HINT / 1024} GiB per upload. Uploads are private until you share them.</p>

      <div className="steps" aria-label="Progress">
        <span className="step" data-state={step(["uploading", "finalising"], ["processing", "ready"])}>1. Upload</span>
        <span className="step" data-state={step(["processing"], ["ready"])}>2. Processing</span>
        <span className="step" data-state={stage === "ready" ? "done" : stage === "error" && replayId ? "error" : "idle"}>3. Ready</span>
      </div>

      {stage === "idle" || stage === "checking" || (stage === "error" && !replayId) ? (
        <form onSubmit={start} className="stack">
          <div
            className="dropzone" data-over={over} role="button" tabIndex={0}
            aria-label={file ? `Selected ${file.name}. Press to choose a different file.` : "Choose a demo file or drop it here"}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), inputRef.current?.click())}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); void choose(e.dataTransfer.files[0]); }}
          >
            <IconUpload width={22} height={22} />
            <p style={{ margin: "8px 0 0" }}>{file ? <><strong>{file.name}</strong> · {(file.size / 2 ** 20).toFixed(1)} MiB</> : "Drop a demo or archive here, or click to choose"}</p>
            <input ref={inputRef} type="file" accept=".dem,.bz2,.gz,.zip,.rar" hidden onChange={(e) => void choose(e.target.files?.[0])} data-testid="file-input" />
          </div>
          <div className="row wrap">
            <div className="field grow">
              <label htmlFor="title">Title (optional)</label>
              <input className="input" id="title" name="title" maxLength={200} placeholder="e.g. Scrim vs Harbour, Mirage" />
            </div>
            <div className="field">
              <label htmlFor="teamId">Upload to</label>
              <select className="select" id="teamId" name="teamId" value={dest} onChange={(e) => setDest(e.target.value)}>
                <option value="">Personal (only me)</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <span className="faint" style={{ fontSize: 12 }}>
                {dest ? `Shows on the Team page for everyone in ${teams.find((t) => t.id === dest)?.name ?? "the team"}.` : "Shows on your Personal page. Only you can see it."}
              </span>
            </div>
          </div>
          <details>
            <summary className="muted">Part of a series?</summary>
            <div className="row wrap" style={{ marginTop: 8 }}>
              <div className="field grow">
                <label htmlFor="seriesId">Series ID (same for every map of the series)</label>
                <input className="input" id="seriesId" name="seriesId" maxLength={64} pattern="[A-Za-z0-9_-]+" />
              </div>
              <div className="field">
                <label htmlFor="seriesMapIndex">Map number</label>
                <input className="input" id="seriesMapIndex" name="seriesMapIndex" type="number" min={1} max={7} defaultValue={1} />
              </div>
            </div>
          </details>
          {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
          <div><button className="btn btn-primary" disabled={!file || stage === "checking"}>Upload and process</button></div>
        </form>
      ) : null}

      {stage === "uploading" || stage === "finalising" ? (
        <div className="card stack" aria-live="polite">
          <div>{stage === "uploading" ? `Uploading ${file?.name}… ${(progress * 100).toFixed(0)}%` : "Verifying upload…"}</div>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
            <div style={{ width: `${progress * 100}%` }} />
          </div>
          {stage === "uploading" ? <div><button className="btn btn-sm" onClick={() => abort.current?.abort()}>Cancel</button></div> : null}
        </div>
      ) : null}

      {stage === "processing" ? (
        <div className="card" aria-live="polite">
          <p style={{ marginTop: 0 }}>Parsing the demo. Full matches usually take under a minute. You can leave this page; the replay will appear in {dest ? "the team's demos" : "your personal demos"}.</p>
          <Link className="btn" href={dest ? `/replays/team?team=${encodeURIComponent(dest)}` : "/replays"}>{dest ? "Go to team demos" : "Go to personal demos"}</Link>
        </div>
      ) : null}

      {stage === "ready" && replayId ? (
        <div className="card" aria-live="polite">
          <p style={{ marginTop: 0 }}>The replay is ready.</p>
          <Link className="btn btn-primary" href={`/replays/${replayId}`}>Open replay</Link>
        </div>
      ) : null}

      {stage === "error" && replayId ? (
        <div className="alert alert-err" role="alert">
          <p style={{ marginTop: 0 }}>{failure ?? error}</p>
          <button className="btn" onClick={() => { setStage("idle"); setFile(null); setReplayId(null); }}>Upload another file</button>
        </div>
      ) : null}
    </div>
  );
}
