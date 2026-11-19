"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError } from "./api";

interface Preview { teamId: string; teamName: string; role: string; expiresAt: string; alreadyMember: boolean; currentRole: string | null }

/** Accept a team invite link. Signed-out visitors are sent to sign in (or sign up) first by the proxy. */
export function JoinTeam({ token }: { token: string }) {
  const router = useRouter();
  const [p, setP] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Preview>(`/api/invites?token=${encodeURIComponent(token)}`).then(setP).catch((e) => {
      if (e instanceof ApiError && e.status === 401) router.replace(`/login?next=${encodeURIComponent(`/join/${token}`)}`);
      else setError(e instanceof ApiError && e.status === 404 ? "This invite link has expired, was used up or was revoked. Ask the team for a new one." : e instanceof Error ? e.message : "Could not open the invite.");
    });
  }, [token, router]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ teamId: string }>("/api/invites", { method: "POST", json: { token } });
      router.push(`/replays/team?team=${encodeURIComponent(r.teamId)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not join the team.");
      setBusy(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 520 }}>
      <h1>Join a team</h1>
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      {!p && !error ? <p className="muted">Checking the invite…</p> : null}
      {p ? (
        <div className="card stack">
          <p style={{ margin: 0 }}>
            You&apos;re invited to <strong>{p.teamName}</strong> as <strong>{p.role}</strong>.
          </p>
          <p className="faint" style={{ margin: 0, fontSize: 13 }}>
            Members see the team&apos;s demos, notes, bookmarks and playlists. The link expires {new Date(p.expiresAt).toLocaleDateString()}.
          </p>
          {p.alreadyMember ? (
            <>
              <p className="alert" style={{ margin: 0 }}>You&apos;re already in this team (role: {p.currentRole}).</p>
              <Link className="btn btn-primary" href={`/replays/team?team=${encodeURIComponent(p.teamId)}`}>Open team demos</Link>
            </>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={accept}>{busy ? "Joining…" : `Join ${p.teamName}`}</button>
          )}
        </div>
      ) : null}
    </div>
  );
}
