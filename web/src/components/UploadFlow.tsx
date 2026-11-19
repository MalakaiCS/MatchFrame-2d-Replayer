"use client";
import Link from "next/link";
import { clearResume, uploadDemo } from "./upload";
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
  const [note, setNote] = useState<string | null>(null);
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

  const [bulk, setBulk] = useState<File[] | null>(null);

  async function choose(f: File | undefined | null, all?: FileList | null) {
    setError(null);
    setFailure(null);
    // Several files: upload them one after another in a queue.
    if (all && all.length > 1) {
      const files = [...all].filter((x) => /\.(dem|bz2|gz|zip|rar)$/.test(x.name.toLowerCase()));
      if (!files.length) return setError("None of those files is a CS2 demo (.dem, .dem.bz2, .dem.gz, .zip or .rar).");
      setBulk(files.slice(0, 20));
      if (files.length > 20) setError("Up to 20 files at a time; the first 20 were queued.");
      return;
    }
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
      const uploadId = await uploadDemo(file, String(form.get("teamId") || "") || null, setProgress, abort.current.signal, setNote);
      setStage("finalising");
      const seriesId = String(form.get("seriesId") || "").trim();
      const done = await api<{ replayId: string; status: string }>(`/api/uploads/${uploadId}/complete`, {
        method: "POST",
        json: {
          title: String(form.get("title") || "") || undefined,
          teamId: String(form.get("teamId") || "") || null,
          seriesId: seriesId || null,
          seriesMapIndex: seriesId ? Number(form.get("seriesMapIndex") || 1) : null,
        },
      });
      clearResume(file);
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

      {bulk ? <BulkQueue files={bulk} dest={dest} teams={teams} onDone={() => setBulk(null)} /> : null}

      {!bulk && (stage === "idle" || stage === "checking" || (stage === "error" && !replayId)) ? (
        <form onSubmit={start} className="stack">
          <div
            className="dropzone" data-over={over} role="button" tabIndex={0}
            aria-label={file ? `Selected ${file.name}. Press to choose a different file.` : "Choose a demo file or drop it here"}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), inputRef.current?.click())}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); void choose(e.dataTransfer.files[0], e.dataTransfer.files); }}
          >
            <IconUpload width={22} height={22} />
            <p style={{ margin: "8px 0 0" }}>{file ? <><strong>{file.name}</strong> · {(file.size / 2 ** 20).toFixed(1)} MiB</> : "Drop demos or archives here (several at once is fine), or click to choose"}</p>
            <input ref={inputRef} type="file" accept=".dem,.bz2,.gz,.zip,.rar" multiple hidden onChange={(e) => void choose(e.target.files?.[0], e.target.files)} data-testid="file-input" />
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
          {note ? <div className="faint" style={{ fontSize: 12 }}>{note}</div> : null}
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

type QState = "waiting" | "checking" | "uploading" | "finalising" | "processing" | "ready" | "failed";
interface QItem { file: File; state: QState; progress: number; message: string | null; replayId: string | null }

/** Upload several demos one after another to the same place, each with its own progress and status. */
function BulkQueue({ files, dest, teams, onDone }: { files: File[]; dest: string; teams: { id: string; name: string }[]; onDone: () => void }) {
  const [items, setItems] = useState<QItem[]>(() => files.map((file) => ({ file, state: "waiting", progress: 0, message: null, replayId: null })));
  const [running, setRunning] = useState(false);
  const started = useRef(false);
  const patch = (i: number, p: Partial<QItem>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...p } : x)));

  async function run() {
    if (started.current) return;
    started.current = true;
    setRunning(true);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        if (f.size > MAX_HINT * 2 ** 20) throw new Error(`Too large (${(f.size / 2 ** 20).toFixed(0)} MiB; the limit is ${MAX_HINT} MiB).`);
        patch(i, { state: "checking" });
        const bad = await sniff(f);
        if (bad) throw new Error(bad);
        patch(i, { state: "uploading" });
        const uploadId = await uploadDemo(f, dest || null, (p) => patch(i, { progress: p }), new AbortController().signal, (m) => patch(i, { message: m }));
        patch(i, { state: "finalising", message: null });
        const done = await api<{ replayId: string }>(`/api/uploads/${uploadId}/complete`, { method: "POST", json: { teamId: dest || null } });
        clearResume(f);
        patch(i, { state: "processing", replayId: done.replayId });
      } catch (e) {
        patch(i, { state: "failed", message: e instanceof Error ? e.message : "The upload failed." });
      }
    }
    setRunning(false);
  }

  // Follow processing for everything uploaded so far.
  useEffect(() => {
    const ids = items.filter((x) => x.state === "processing" && x.replayId).map((x) => x.replayId!);
    if (!ids.length) return;
    const t = setInterval(async () => {
      for (const id of ids) {
        try {
          const r = await api<{ replay: { status: string; failureDetail: string | null; failureCode: string | null } }>(`/api/replays/${id}`);
          if (r.replay.status === "ready") setItems((xs) => xs.map((x) => (x.replayId === id ? { ...x, state: "ready" } : x)));
          if (r.replay.status === "failed") setItems((xs) => xs.map((x) => (x.replayId === id ? { ...x, state: "failed", message: r.replay.failureDetail ?? r.replay.failureCode } : x)));
        } catch {
          /* keep polling */
        }
      }
    }, 2500);
    return () => clearInterval(t);
  }, [items]);

  const label: Record<QState, string> = {
    waiting: "Waiting", checking: "Checking", uploading: "Uploading", finalising: "Verifying", processing: "Processing", ready: "Ready", failed: "Failed",
  };
  const finished = items.every((x) => x.state === "ready" || x.state === "failed");
  const where = dest ? `${teams.find((t) => t.id === dest)?.name ?? "the team"}'s team demos` : "your personal demos";
  return (
    <section className="card stack" aria-label="Upload queue">
      <div className="row">
        <strong className="grow">{items.length} demos → {where}</strong>
        {!started.current ? <button type="button" className="btn btn-primary" onClick={run}>Upload all</button> : null}
        {!running ? <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>{finished ? "Done" : "Cancel"}</button> : null}
      </div>
      <ol className="bulk-list">
        {items.map((x, i) => (
          <li key={i} className="bulk-item" data-state={x.state}>
            <span className="grow bulk-name">{x.file.name} <span className="faint">· {(x.file.size / 2 ** 20).toFixed(0)} MiB</span></span>
            {x.state === "uploading" ? (
              <span className="progress bulk-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(x.progress * 100)}>
                <span style={{ display: "block", height: "100%", width: `${x.progress * 100}%`, background: "var(--accent)" }} />
              </span>
            ) : null}
            <span className={`badge ${x.state === "ready" ? "badge-ok" : x.state === "failed" ? "badge-err" : ""}`}>{label[x.state]}</span>
            {x.state === "ready" && x.replayId ? <Link className="btn btn-sm" href={`/replays/${x.replayId}`}>Open</Link> : null}
            {x.message ? <span className="bulk-msg">{x.message}</span> : null}
          </li>
        ))}
      </ol>
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>Files upload one at a time. Keep this page open until every file shows Processing or Ready; processing carries on if you leave.</p>
    </section>
  );
}
