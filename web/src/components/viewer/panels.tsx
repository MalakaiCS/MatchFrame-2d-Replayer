"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { GameEvent, Manifest, PlayerInfo, RoundSummary, Side, TeamKey } from "@/shared/contract";
import { formatMs } from "@/viewer/clock";
import { FLAGS, type Frame } from "@/viewer/playback";
import { api } from "../api";
import { IconBookmark, IconEdit, IconFollow, IconNote, IconTrash } from "../icons";
import { KillModifiers, WeaponIcon } from "./GameIcons";

type PInfo = PlayerInfo & { side: Side };

const short = (w: string | null | undefined) => (w ? w.replace(/^weapon_/, "").replace(/_silencer$/, "-s") : "—");

// ------------------------------------------------------------------ players

export function PlayersPanel({
  manifest, round, frame, players, inventory, selected, follow, onSelect, onFollow,
}: {
  manifest: Manifest;
  round: RoundSummary;
  frame: Frame | null;
  players: Map<string, PInfo>;
  inventory: Map<string, string[]>;
  selected: string | null;
  follow: boolean;
  onSelect: (id: string | null) => void;
  onFollow: (on: boolean) => void;
}) {
  const caps = manifest.capabilities;
  const byId = new Map(frame?.players.map((p) => [p.id, p]) ?? []);
  return (
    <div>
      {caps.participants === "partial" ? (
        <p className="alert alert-warn" style={{ fontSize: 12 }}>
          POV demo: only part of the match is recorded. Players without data this round are shown as unknown.
        </p>
      ) : null}
      {(["A", "B"] as TeamKey[]).map((k) => {
        const side = round.sides[k];
        const list = manifest.players.filter((p) => p.team === k);
        return (
          <div key={k}>
            <div className="dock-section-title">
              <span className={`side side-${side}`}>{side}</span>
              <span>{manifest.teams[k].name}</span>
              <span className="grow" />
              {round.economy[k].equipmentValue !== null ? <span className="mono">${round.economy[k].equipmentValue?.toLocaleString()}</span> : null}
            </div>
            {list.map((pl) => {
              const f = byId.get(pl.id);
              const known = !!f?.visible && (round.coverage[pl.id] ?? 1) > 0;
              const dead = f ? !f.alive : false;
              const inv = inventory.get(pl.id) ?? [];
              return (
                <button key={pl.id} type="button" className="player-row" aria-pressed={selected === pl.id} data-dead={dead}
                  onClick={() => onSelect(selected === pl.id ? null : pl.id)}
                  aria-label={`${pl.name}, ${side}${!known ? ", no data" : dead ? ", dead" : f?.hp != null ? `, ${f.hp} health` : ""}`}>
                  <span className="player-name">
                    <span className={`side side-${side}`} style={{ fontWeight: 600, color: "inherit" }}>{pl.name}</span>
                    {pl.isBot ? <span className="badge" style={{ marginLeft: 6 }}>BOT</span> : null}
                    {manifest.povPlayerId === pl.id ? <span className="badge" style={{ marginLeft: 6 }}>POV</span> : null}
                  </span>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {!known ? "unknown" : dead ? "dead" : caps.health && f?.hp != null ? `${f.hp} HP` : ""}
                  </span>
                  {known && caps.health && f?.hp != null ? <span className="hp"><div style={{ width: `${f.hp}%` }} /></span> : null}
                  {known ? (
                    <span className="player-sub">
                      <span className="inv-icons"><WeaponIcon name={f?.weapon} height={16} label={`holding ${short(f?.weapon)}`} /></span>
                      {caps.armor && f?.armor ? (
                        <span className="inv-icons" title={`${f.flags & FLAGS.helmet ? "Kevlar + helmet" : "Kevlar"} ${f.armor}`}>
                          <WeaponIcon name={f.flags & FLAGS.helmet ? "armor_helmet" : "armor"} label={f.flags & FLAGS.helmet ? "Kevlar and helmet" : "Kevlar"} /> {f.armor}
                        </span>
                      ) : null}
                      {f && f.flags & FLAGS.defuser ? <WeaponIcon name="defuser" label="Defuse kit" /> : null}
                      {f && f.flags & FLAGS.bomb ? <span className="inv-icons" style={{ color: "var(--danger)" }}><WeaponIcon name="c4" label="Bomb" /> Bomb</span> : null}
                      {caps.money && f?.money != null ? <span className="mono">${f.money}</span> : null}
                      {caps.inventory && inv.length ? (
                        <span className="inv-icons faint" aria-label={`Inventory: ${inv.map(short).join(", ")}`}>
                          {inv.filter((w) => !/knife|bayonet/i.test(w) || inv.length === 1).map((w, i) => <WeaponIcon key={`${w}-${i}`} name={w} height={12} />)}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        );
      })}
      <div className="row" style={{ marginTop: 10 }}>
        <button type="button" className="btn btn-sm" aria-pressed={follow} disabled={!selected} onClick={() => onFollow(!follow)}>
          <IconFollow /> Follow selected player
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ events

const EVENT_TYPES = new Set(["kill", "bomb_plant", "bomb_defuse", "bomb_explode", "bomb_drop", "bomb_pickup", "round_end", "freeze_end", "smoke_disrupted", "disconnect", "reconnect"]);

export function describeEvent(e: GameEvent, name: (id?: string | null) => string): string {
  switch (e.type) {
    case "kill": {
      const tags = [e.headshot && "headshot", e.wallbang && "wallbang", e.throughSmoke && "through smoke", e.noscope && "no-scope", e.attackerBlind && "blind"].filter(Boolean);
      return `${name(e.actor)} killed ${name(e.target)} · ${short(e.weapon)}${tags.length ? ` (${tags.join(", ")})` : ""}`;
    }
    case "bomb_plant": return `${name(e.actor)} planted the bomb${e.site ? ` at ${e.site}` : ""}`;
    case "bomb_defuse": return `${name(e.actor)} defused the bomb`;
    case "bomb_explode": return "Bomb exploded";
    case "bomb_drop": return `${name(e.actor)} dropped the bomb`;
    case "bomb_pickup": return `${name(e.actor)} picked up the bomb`;
    case "bomb_plant_begin": return `${name(e.actor)} started planting`;
    case "bomb_defuse_begin": return `${name(e.actor)} started defusing`;
    case "round_end": return `Round over${e.reason ? ` · ${e.reason.replace(/_/g, " ")}` : ""}`;
    case "freeze_end": return "Freeze time ends";
    case "smoke_disrupted": return `${name(e.actor)}'s HE cleared part of a smoke (inferred)`;
    case "grenade_throw": return `${name(e.actor)} threw ${e.weapon}`;
    case "grenade_detonate": return `${e.weapon} detonated`;
    case "disconnect": return `${name(e.actor)} disconnected`;
    case "reconnect": return `${name(e.actor)} reconnected`;
    default: return e.type;
  }
}

export function EventsPanel({
  manifest, round, events, tick, players, onSeek,
}: {
  manifest: Manifest;
  round: RoundSummary;
  events: GameEvent[];
  tick: number;
  players: Map<string, PInfo>;
  onSeek: (t: number) => void;
}) {
  const [utility, setUtility] = useState(false);
  const name = (id?: string | null) => (id ? players.get(id)?.name ?? "unknown" : "World");
  const list = events.filter((e) => EVENT_TYPES.has(e.type) || (utility && (e.type === "grenade_throw" || e.type.startsWith("bomb_"))));
  const base = round.freezeEndTick ?? round.startTick;
  return (
    <div>
      <label className="row" style={{ fontSize: 13, marginBottom: 8 }}>
        <input type="checkbox" checked={utility} onChange={(e) => setUtility(e.target.checked)} /> Include grenade throws and bomb actions
      </label>
      {list.length === 0 ? <p className="faint">No events in this round.</p> : null}
      {list.map((e) => (
        <button type="button" key={e.id} className="event-row" data-past={e.tick <= tick} onClick={() => onSeek(e.tick)}
          aria-label={`${formatMs((e.tick - base) * manifest.tickIntervalMs)}: ${describeEvent(e, name)}`}>
          <span className="event-time">{formatMs((e.tick - base) * manifest.tickIntervalMs)}</span>
          {e.type === "kill" ? (
            <span className="kill-line">
              <span className={`side side-${players.get(e.actor ?? "")?.side ?? "CT"}`}>{name(e.actor)}</span>
              <WeaponIcon name={e.weapon} height={14} />
              <KillModifiers e={e} />
              <span className={`side side-${players.get(e.target ?? "")?.side ?? "T"}`}>{name(e.target)}</span>
            </span>
          ) : (
            <span>{describeEvent(e, name)}{e.provenance === "inferred" && e.type !== "smoke_disrupted" ? " (inferred)" : ""}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ bookmarks & notes

export interface ReviewItem {
  id: string; roundId: string; tick: number; endTick: number | null; teamId: string | null; authorName: string; mine: boolean;
  status: "current" | "migrated" | "unavailable"; displayNumber: number | null; title?: string; body?: string; createdAt: string;
}

export function useReview(replayId: string, enabled: boolean) {
  const [data, setData] = useState<{ bookmarks: ReviewItem[]; notes: ReviewItem[] }>({ bookmarks: [], notes: [] });
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!enabled) return;
    try {
      setData(await api(`/api/replays/${replayId}/review`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load review items.");
    }
  }, [replayId, enabled]);
  useEffect(() => void reload(), [reload]);
  return { ...data, error, reload };
}

export function ReviewPanel({
  kind, manifest, replayId, round, tick, items, teams, canReview, reload, onOpen, composeSignal,
}: {
  kind: "bookmark" | "note";
  manifest: Manifest;
  replayId: string;
  round: RoundSummary;
  tick: number;
  items: ReviewItem[];
  teams: { id: string; name: string }[];
  canReview: boolean;
  reload: () => void;
  onOpen: (roundId: string, tick: number) => void;
  composeSignal: number;
}) {
  const [text, setText] = useState("");
  const [teamId, setTeamId] = useState("");
  const [scope, setScope] = useState<"round" | "all">("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = `${kind}-compose`;

  useEffect(() => {
    if (composeSignal) document.getElementById(inputId)?.focus();
  }, [composeSignal, inputId]);

  const base = (r: string) => manifest.rounds.find((x) => x.id === r);
  const when = (it: ReviewItem) => {
    const r = base(it.roundId);
    return r ? `R${r.displayNumber} · ${formatMs((it.tick - r.startTick) * manifest.tickIntervalMs)}` : "unavailable";
  };

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/replays/${replayId}/review`, {
        method: "POST",
        json: kind === "bookmark"
          ? { kind, roundId: round.id, tick: Math.round(tick), title: text, teamId: teamId || null }
          : { kind, roundId: round.id, tick: Math.round(tick), body: text, teamId: teamId || null },
      });
      setText("");
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    }
  }

  async function save(id: string) {
    try {
      await api(`/api/replays/${replayId}/review/${id}`, { method: "PATCH", json: kind === "bookmark" ? { title: editText } : { body: editText } });
      setEditing(null);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    }
  }

  async function remove(id: string) {
    if (!confirm(`Delete this ${kind}?`)) return;
    await api(`/api/replays/${replayId}/review/${id}`, { method: "DELETE" }).catch((err) => setError(err.message));
    reload();
  }

  const shown = items.filter((i) => scope === "all" || i.roundId === round.id);
  const Icon = kind === "bookmark" ? IconBookmark : IconNote;
  return (
    <div>
      {canReview ? (
        <form onSubmit={add} className="stack" style={{ marginBottom: 12 }}>
          <label htmlFor={inputId} className="muted" style={{ fontSize: 12 }}>
            {kind === "bookmark" ? "Bookmark this moment" : "Note at this moment"} (round {round.displayNumber}, {formatMs((tick - round.startTick) * manifest.tickIntervalMs)})
          </label>
          {kind === "bookmark" ? (
            <input id={inputId} className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Title" maxLength={200} required />
          ) : (
            <textarea id={inputId} className="textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a note" maxLength={5000} required />
          )}
          <div className="row">
            <label className="sr-only" htmlFor={`${kind}-scope`}>Visible to</label>
            <select id={`${kind}-scope`} className="select grow" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">Only me</option>
              {teams.map((t) => <option key={t.id} value={t.id}>Team: {t.name}</option>)}
            </select>
            <button className="btn btn-primary"><Icon /> Add</button>
          </div>
        </form>
      ) : <p className="faint" style={{ fontSize: 13 }}>Sign in with an account that has access to add {kind}s.</p>}
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      <div className="row" style={{ marginBottom: 8 }}>
        <button type="button" className="chip" aria-pressed={scope === "all"} onClick={() => setScope("all")}>All rounds</button>
        <button type="button" className="chip" aria-pressed={scope === "round"} onClick={() => setScope("round")}>This round</button>
      </div>
      {shown.length === 0 ? <p className="faint">No {kind}s{scope === "round" ? " in this round" : ""} yet.</p> : null}
      {shown.map((it) => (
        <article key={it.id} className="review-item">
          <header>
            <button type="button" className="btn btn-ghost btn-sm" disabled={it.status === "unavailable"} onClick={() => onOpen(it.roundId, it.tick)}
              aria-label={`Go to ${when(it)}`}>{when(it)}</button>
            <span className="grow" />
            <span>{it.teamId ? teams.find((t) => t.id === it.teamId)?.name ?? "Team" : "Personal"} · {it.authorName}</span>
          </header>
          {it.status === "unavailable" ? <p className="faint" style={{ fontSize: 12 }}>This moment no longer exists in the current replay version.</p> : null}
          {it.status === "migrated" ? <p className="faint" style={{ fontSize: 12 }}>Moved to the reprocessed replay (same tick).</p> : null}
          {editing === it.id ? (
            <div className="stack">
              {kind === "bookmark"
                ? <input className="input" aria-label="Bookmark title" value={editText} onChange={(e) => setEditText(e.target.value)} maxLength={200} />
                : <textarea className="textarea" aria-label="Note text" rows={3} value={editText} onChange={(e) => setEditText(e.target.value)} maxLength={5000} />}
              <div className="row">
                <button type="button" className="btn btn-sm btn-primary" onClick={() => save(it.id)}>Save</button>
                <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <p style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>{kind === "bookmark" ? it.title : it.body}</p>
          )}
          {canReview && editing !== it.id ? (
            <div className="row">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEditing(it.id); setEditText((kind === "bookmark" ? it.title : it.body) ?? ""); }}
                aria-label={`Edit ${kind}`}><IconEdit /> Edit</button>
              <button type="button" className="btn btn-ghost btn-sm btn-danger" onClick={() => remove(it.id)} aria-label={`Delete ${kind}`}><IconTrash /> Delete</button>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ playlists

export function PlaylistPanel({
  replayId, round, tick, manifest, canReview,
}: { replayId: string; round: RoundSummary; tick: number; manifest: Manifest; canReview: boolean }) {
  const [lists, setLists] = useState<{ id: string; name: string; entries: number; teamName: string | null }[] | null>(null);
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api<{ playlists: typeof lists }>("/api/playlists").then((r) => setLists(r.playlists)).catch(() => setLists([])), []);
  useEffect(() => void load(), [load]);
  if (!canReview) return <p className="faint">Sign in with an account that can open this replay to use playlists.</p>;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    try {
      let id = target;
      if (target === "__new") {
        const name = prompt("Name for the new playlist");
        if (!name) return;
        id = (await api<{ id: string }>("/api/playlists", { method: "POST", json: { name } })).id;
      }
      await api(`/api/playlists/${id}/entries`, { method: "POST", json: { replayId, roundId: round.id, tick: Math.round(tick), label: label || null } });
      setLabel("");
      setMsg("Added to playlist.");
      setTarget(id);
      load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not add.");
    }
  }

  return (
    <div>
      <form onSubmit={add} className="stack">
        <span className="muted" style={{ fontSize: 12 }}>Add round {round.displayNumber} at {formatMs((tick - round.startTick) * manifest.tickIntervalMs)} to a playlist</span>
        <label className="sr-only" htmlFor="pl-target">Playlist</label>
        <select id="pl-target" className="select" value={target} onChange={(e) => setTarget(e.target.value)} required>
          <option value="" disabled>Choose a playlist</option>
          {(lists ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}{l.teamName ? ` (${l.teamName})` : ""}</option>)}
          <option value="__new">+ New playlist…</option>
        </select>
        <label className="sr-only" htmlFor="pl-label">Label</label>
        <input id="pl-label" className="input" placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} />
        <div><button className="btn btn-primary">Add moment</button></div>
      </form>
      {msg ? <p className="alert" role="status">{msg}</p> : null}
      {err ? <p className="alert alert-err" role="alert">{err}</p> : null}
      <div className="dock-section-title">Your playlists</div>
      {(lists ?? []).map((l) => (
        <div key={l.id} className="row" style={{ padding: "4px 0" }}>
          <Link href={`/playlists/${l.id}`} className="grow">{l.name}</Link>
          <span className="faint" style={{ fontSize: 12 }}>{l.entries} moments</span>
        </div>
      ))}
    </div>
  );
}
