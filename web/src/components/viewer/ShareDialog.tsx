"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { buildReplayUrl } from "@/viewer/shareUrl";
import { api } from "../api";
import { IconClose, IconLink } from "../icons";

interface Props {
  open: boolean;
  onClose: () => void;
  replayId: string;
  roundId: string;
  roundMs: number;
  isOwner: boolean;
  viaShare: boolean;
  teams: { id: string; name: string }[];
  replayTeamId: string | null;
  visibility: string;
  onChanged: () => void;
}

export function ShareDialog(p: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const [grants, setGrants] = useState<{ teamId: string | null; teamName: string | null; userId: string | null; userEmail: string | null }[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grantTeam, setGrantTeam] = useState("");
  const [grantEmail, setGrantEmail] = useState("");

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const load = useCallback(async () => {
    if (!p.isOwner) return;
    try {
      const s = await api<{ active: boolean }>(`/api/replays/${p.replayId}/share`);
      setActive(s.active);
      setGrants((await api<{ grants: typeof grants }>(`/api/replays/${p.replayId}/grants`)).grants);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load sharing settings.");
    }
  }, [p.isOwner, p.replayId]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (p.open && !d.open) {
      d.showModal();
      setCopied(null);
      setError(null);
      void load();
    }
    if (!p.open && d.open) d.close();
  }, [p.open, load]);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt("Copy this link", text);
    }
    setCopied(what);
  };

  const momentUrl = buildReplayUrl(origin, p.replayId, p.roundId, p.roundMs);
  const linkUrl = token ? buildReplayUrl(origin, p.replayId, p.roundId, p.roundMs, token) : null;

  async function createLink() {
    setError(null);
    try {
      const r = await api<{ token: string }>(`/api/replays/${p.replayId}/share`, { method: "POST" });
      setToken(r.token);
      setActive(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the link.");
    }
  }

  async function revoke() {
    if (!confirm("Revoke all read-only links? Anyone using them loses access immediately.")) return;
    await api(`/api/replays/${p.replayId}/share`, { method: "DELETE" });
    setToken(null);
    setActive(false);
  }

  async function grant(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/replays/${p.replayId}/grants`, { method: "POST", json: grantTeam ? { teamId: grantTeam } : { email: grantEmail } });
      setGrantTeam("");
      setGrantEmail("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not share.");
    }
  }

  async function del() {
    if (!confirm("Delete this replay for everyone? Review items, recordings and links stop working immediately.")) return;
    await api(`/api/replays/${p.replayId}`, { method: "DELETE" });
    router.push("/replays");
  }

  return (
    <dialog ref={ref} className="modal" onClose={p.onClose} aria-labelledby="share-title">
      <div className="row">
        <h2 id="share-title" className="grow">Share</h2>
        <button type="button" className="btn btn-ghost icon-btn" onClick={p.onClose} aria-label="Close"><IconClose /></button>
      </div>

      <section className="stack">
        <strong style={{ fontSize: 13 }}>Link to this moment</strong>
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>Opens round and time for anyone who already has access{p.viaShare ? " (does not include your read-only token)" : ""}.</p>
        <div className="row">
          <input className="input grow mono" readOnly value={momentUrl} aria-label="Link to this moment" onFocus={(e) => e.target.select()} />
          <button type="button" className="btn" onClick={() => copy(momentUrl, "moment")}><IconLink /> {copied === "moment" ? "Copied" : "Copy"}</button>
        </div>
      </section>

      {p.isOwner ? (
        <>
          <hr style={{ borderColor: "var(--border)", margin: "16px 0" }} />
          <section className="stack">
            <strong style={{ fontSize: 13 }}>Read-only link</strong>
            <p className="faint" style={{ margin: 0, fontSize: 12 }}>
              Anyone with the link can watch this replay without an account. They cannot see notes, bookmarks or playlists. Voice recordings stay private unless a recording is marked “Include in read-only links”.
            </p>
            {linkUrl ? (
              <div className="row">
                <input className="input grow mono" readOnly value={linkUrl} aria-label="Read-only link" onFocus={(e) => e.target.select()} />
                <button type="button" className="btn" onClick={() => copy(linkUrl, "link")}><IconLink /> {copied === "link" ? "Copied" : "Copy"}</button>
              </div>
            ) : null}
            <div className="row">
              <button type="button" className="btn" onClick={createLink}>{active ? "Create another link" : "Create read-only link"}</button>
              {active ? <button type="button" className="btn btn-danger" onClick={revoke}>Revoke all links</button> : null}
            </div>
            {active && !linkUrl ? <p className="faint" style={{ margin: 0, fontSize: 12 }}>A link is active. Links are shown only once; create a new one to copy it again.</p> : null}
          </section>

          <hr style={{ borderColor: "var(--border)", margin: "16px 0" }} />
          <section className="stack">
            <strong style={{ fontSize: 13 }}>Team access</strong>
            <form className="row wrap" onSubmit={grant}>
              <select className="select" aria-label="Team" value={grantTeam} onChange={(e) => setGrantTeam(e.target.value)}>
                <option value="">Choose a team…</option>
                {p.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <span className="faint">or</span>
              <input className="input" type="email" placeholder="user@example.com" aria-label="Share with user by email"
                value={grantEmail} onChange={(e) => setGrantEmail(e.target.value)} disabled={!!grantTeam} />
              <button className="btn" disabled={!grantTeam && !grantEmail}>Share</button>
            </form>
            {grants.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {grants.map((g) => (
                  <li key={(g.teamId ?? "") + (g.userId ?? "")} className="row">
                    <span className="grow">{g.teamName ? `Team ${g.teamName}` : g.userEmail}</span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={async () => {
                      await api(`/api/replays/${p.replayId}/grants?${g.teamId ? `teamId=${g.teamId}` : `userId=${g.userId}`}`, { method: "DELETE" });
                      load();
                    }}>Remove</button>
                  </li>
                ))}
              </ul>
            ) : <p className="faint" style={{ margin: 0, fontSize: 12 }}>Only you{p.replayTeamId ? " and your replay's team" : ""} can open this replay.</p>}
          </section>

          <hr style={{ borderColor: "var(--border)", margin: "16px 0" }} />
          <section className="row">
            <span className="grow faint" style={{ fontSize: 12 }}>Deleting removes the replay, its links and its recordings.</span>
            <button type="button" className="btn btn-danger" onClick={del}>Delete replay</button>
          </section>
        </>
      ) : null}
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
    </dialog>
  );
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const rows: [string, string][] = [
    ["Space / K", "Play or pause"],
    ["← / →", "Back / forward 5 seconds"],
    ["Shift + ← / →", "Back / forward one sample"],
    ["J / L", "Previous / next kill or bomb event"],
    ["[ / ]", "Previous / next round (respects filters)"],
    [", / .", "Slower / faster"],
    ["Home / End", "Round start / round end"],
    ["F", "Skip to freeze-time end"],
    ["V", "Cycle floor (multi-floor maps)"],
    ["+ / − / 0", "Zoom in / out / reset view"],
    ["B / N", "Bookmark / note at this moment"],
    ["?", "Show this list"],
  ];
  return (
    <dialog ref={ref} className="modal" onClose={onClose} aria-labelledby="kbd-title">
      <div className="row">
        <h2 id="kbd-title" className="grow">Keyboard shortcuts</h2>
        <button type="button" className="btn btn-ghost icon-btn" onClick={onClose} aria-label="Close"><IconClose /></button>
      </div>
      <div className="shortcuts">
        {rows.map(([k, d]) => (
          <div key={k} style={{ display: "contents" }}><span><span className="kbd">{k}</span></span><span>{d}</span></div>
        ))}
      </div>
      <p className="faint" style={{ fontSize: 12 }}>Shortcuts are ignored while typing in a text field.</p>
    </dialog>
  );
}
