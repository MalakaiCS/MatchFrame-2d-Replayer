"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";

interface Team { id: string; name: string; role: string; members: number }
interface TeamPlan { id: string; plan: { active: boolean; status: string } | null }
interface Member { id: string; name: string; email: string; role: string }

const ROLES = ["owner", "coach", "analyst", "player", "viewer"] as const;
const ROLE_HELP: Record<string, string> = {
  owner: "Manage the team and everything shared with it",
  coach: "Add members, manage team review items and recordings",
  analyst: "Review: bookmarks, notes, playlists, recordings",
  player: "Review: bookmarks, notes, playlists, recordings",
  viewer: "Watch team replays; cannot add review items",
};

export function TeamsPage() {
  const router = useRouter();
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [myRole, setMyRole] = useState("viewer");
  const [error, setError] = useState<string | null>(null);
  const [plans, setPlans] = useState<{ enabled: boolean; teams: TeamPlan[] } | null>(null);

  const load = useCallback(async () => {
    try {
      setTeams((await api<{ teams: Team[] }>("/api/teams")).teams);
      api<{ enabled: boolean; teams: TeamPlan[] }>("/api/billing").then(setPlans).catch(() => {});
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.push("/login?next=/teams");
    }
  }, [router]);
  useEffect(() => void load(), [load]);

  const loadMembers = useCallback(async (id: string) => {
    const r = await api<{ members: Member[]; role: string }>(`/api/teams/${id}`);
    setMembers(r.members);
    setMyRole(r.role);
  }, []);
  useEffect(() => { if (open) void loadMembers(open); }, [open, loadMembers]);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const r = await api<{ id: string }>("/api/teams", { method: "POST", json: { name: f.get("name") } });
      (e.target as HTMLFormElement).reset();
      await load();
      setOpen(r.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the team.");
    }
  }

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    try {
      await api(`/api/teams/${open}/members`, { method: "POST", json: { email: f.get("email"), role: f.get("role") } });
      (e.target as HTMLFormElement).reset();
      loadMembers(open!);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the member.");
    }
  }

  async function setRole(userId: string, role: string) {
    setError(null);
    await api(`/api/teams/${open}/members/${userId}`, { method: "PATCH", json: { role } }).catch((err) => setError(err.message));
    loadMembers(open!);
  }

  async function remove(userId: string) {
    setError(null);
    await api(`/api/teams/${open}/members/${userId}`, { method: "DELETE" }).catch((err) => setError(err.message));
    loadMembers(open!);
    load();
  }

  const canManage = myRole === "owner" || myRole === "coach";
  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <h1>Teams</h1>
      <p className="page-sub">Teams share replays, bookmarks, notes, playlists and voice recordings. Roles control who can review. With a <Link href="/billing">team plan</Link>, everyone on the team can upload and review.</p>
      <form className="row" onSubmit={create} style={{ marginBottom: 16 }}>
        <label className="sr-only" htmlFor="team-name">New team name</label>
        <input id="team-name" className="input" name="name" placeholder="New team name" required maxLength={80} />
        <button className="btn">Create team</button>
      </form>
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      {teams?.length === 0 ? <div className="empty">You are not in any team yet.</div> : null}
      <div className="stack">
        {teams?.map((t) => (
          <section key={t.id} className="card">
            <div className="row">
              <strong className="grow">{t.name}</strong>
              <span className="badge">{t.role}</span>
              {plans?.enabled ? (() => {
                const p = plans.teams.find((x) => x.id === t.id)?.plan;
                return p?.active
                  ? <span className="badge badge-ok">Team plan</span>
                  : <Link className="badge badge-warn" href="/billing" style={{ textDecoration: "none" }}>No team plan</Link>;
              })() : null}
              <span className="faint" style={{ fontSize: 13 }}>{t.members} members</span>
              <button className="btn btn-sm" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}>
                {open === t.id ? "Close" : "Members"}
              </button>
            </div>
            {open === t.id ? (
              <div style={{ marginTop: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead><tr className="faint" style={{ textAlign: "left" }}><th>Name</th><th>Email</th><th>Role</th><th /></tr></thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.id} style={{ borderTop: "1px solid var(--border)" }}>
                        <td style={{ padding: "6px 0" }}>{m.name}</td>
                        <td>{m.email}</td>
                        <td>
                          {canManage ? (
                            <select className="select btn-sm" style={{ height: 26 }} value={m.role} aria-label={`Role of ${m.name}`} onChange={(e) => setRole(m.id, e.target.value)}>
                              {ROLES.map((r) => <option key={r} value={r} disabled={r === "owner" && myRole !== "owner"}>{r}</option>)}
                            </select>
                          ) : m.role}
                        </td>
                        <td style={{ textAlign: "right" }}>
                          {canManage ? <button className="btn btn-ghost btn-sm btn-danger" onClick={() => remove(m.id)}>Remove</button> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {canManage ? (
                  <form className="row wrap" onSubmit={add} style={{ marginTop: 12 }}>
                    <label className="sr-only" htmlFor="m-email">Member email</label>
                    <input id="m-email" className="input grow" name="email" type="email" placeholder="teammate@example.com" required />
                    <label className="sr-only" htmlFor="m-role">Role</label>
                    <select id="m-role" className="select" name="role" defaultValue="player">
                      {ROLES.map((r) => <option key={r} value={r} disabled={r === "owner" && myRole !== "owner"}>{r}</option>)}
                    </select>
                    <button className="btn">Add member</button>
                  </form>
                ) : null}
                {canManage ? <InviteLinks teamId={t.id} myRole={myRole} /> : null}
                <ul className="faint" style={{ fontSize: 12, marginTop: 12 }}>
                  {ROLES.map((r) => <li key={r}><strong>{r}</strong>: {ROLE_HELP[r]}</li>)}
                </ul>
              </div>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}

interface Invite { id: string; role: string; createdAt: string; expiresAt: string; maxUses: number | null; uses: number; createdBy: string }

/** Invite links: anyone with the link and an account joins with the chosen role. */
function InviteLinks({ teamId, myRole }: { teamId: string; myRole: string }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [role, setRole] = useState("player");
  const [days, setDays] = useState(7);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ invites: Invite[] }>(`/api/teams/${teamId}/invites`).then((r) => setInvites(r.invites)).catch(() => {});
  }, [teamId]);
  useEffect(() => load(), [load]);

  async function create() {
    setError(null);
    setCopied(false);
    try {
      const r = await api<{ token: string }>(`/api/teams/${teamId}/invites`, { method: "POST", json: { role, days } });
      setLink(`${window.location.origin}/join/${r.token}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the invite link.");
    }
  }
  async function copy() {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); } catch { window.prompt("Invite link", link); }
  }
  async function revoke(id?: string) {
    await api(`/api/teams/${teamId}/invites${id ? `?inviteId=${id}` : ""}`, { method: "DELETE" });
    if (!id) setLink(null);
    load();
  }

  return (
    <div className="invite-box">
      <strong style={{ fontSize: 13 }}>Invite link</strong>
      <p className="faint" style={{ margin: "2px 0 8px", fontSize: 12 }}>Anyone with the link and a Matchframe account joins the team. They can sign up from the link.</p>
      <div className="row wrap">
        <label className="sr-only" htmlFor={`inv-role-${teamId}`}>Role for people who join</label>
        <select id={`inv-role-${teamId}`} className="select btn-sm" style={{ height: 28 }} value={role} onChange={(e) => setRole(e.target.value)}>
          {(["coach", "analyst", "player", "viewer"] as const).map((r) => <option key={r} value={r} disabled={r === "coach" && myRole !== "owner"}>Join as {r}</option>)}
        </select>
        <label className="sr-only" htmlFor={`inv-days-${teamId}`}>Expires after</label>
        <select id={`inv-days-${teamId}`} className="select btn-sm" style={{ height: 28 }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[1, 7, 30].map((d) => <option key={d} value={d}>Expires in {d} day{d === 1 ? "" : "s"}</option>)}
        </select>
        <button type="button" className="btn btn-sm" onClick={create}>Create invite link</button>
      </div>
      {link ? (
        <div className="row" style={{ marginTop: 8 }}>
          <input className="input grow mono" readOnly value={link} aria-label="Invite link" onFocus={(e) => e.target.select()} style={{ height: 28, fontSize: 12 }} />
          <button type="button" className="btn btn-sm" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        </div>
      ) : null}
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      {invites.length ? (
        <ul className="invite-list">
          {invites.map((i) => (
            <li key={i.id} className="row">
              <span className="grow faint" style={{ fontSize: 12 }}>
                Joins as {i.role} · used {i.uses}{i.maxUses ? `/${i.maxUses}` : ""} · expires {new Date(i.expiresAt).toLocaleDateString()} · by {i.createdBy}
              </span>
              <button type="button" className="btn btn-ghost btn-sm btn-danger" onClick={() => revoke(i.id)}>Revoke</button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
