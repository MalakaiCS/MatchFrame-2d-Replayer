"use client";
/**
 * Per-team scoreboard boxes beside the radar: name and score, then one row per player with
 * ammo and weapon, health bar, armour, money and utility. Dead players are greyed and
 * right-aligned. Clicking a row selects the player (and shows the setpos command).
 */
import type { Manifest, PlayerInfo, RoundSummary, Side, TeamKey } from "@/shared/contract";
import { weaponKey } from "@/viewer/icons";
import { FLAGS, type Frame } from "@/viewer/playback";
import { WeaponIcon } from "./GameIcons";
import { SetposCopy } from "./panels";

type PInfo = PlayerInfo & { side: Side };

const UTILITY_ORDER = ["hegrenade", "flashbang", "smokegrenade", "molotov", "incgrenade", "decoy"];
const isGun = (k: string | null) => !!k && !/knife|bayonet|grenade|flashbang|molotov|incgrenade|decoy|c4|taser|world/.test(k);

function loadout(inv: string[]) {
  const keys = inv.map((i) => weaponKey(i)).filter((k): k is string => !!k);
  const guns = keys.filter(isGun);
  const util = keys.filter((k) => UTILITY_ORDER.includes(k)).sort((a, b) => UTILITY_ORDER.indexOf(a) - UTILITY_ORDER.indexOf(b));
  return { guns, util };
}

export function TeamScoreboard({
  manifest, round, team, frame, players, inventory, selected, onSelect,
}: {
  manifest: Manifest;
  round: RoundSummary;
  team: TeamKey;
  frame: Frame | null;
  players: Map<string, PInfo>;
  inventory: Map<string, string[]>;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const side = round.sides[team];
  const caps = manifest.capabilities;
  const byId = new Map(frame?.players.map((p) => [p.id, p]) ?? []);
  const list = manifest.players.filter((p) => p.team === team);
  const name = manifest.teams[team].name;
  return (
    <section className="sb" data-side={side} aria-label={`${name} scoreboard (${side})`}>
      <header className="sb-head">
        <span className={`sb-team side side-${side}`}>{name}</span>
        <span className="sb-score mono" aria-label={`${name} score`}>{round.scoreBefore[team]}</span>
      </header>
      {list.map((pl) => {
        const f = byId.get(pl.id);
        const known = !!f?.visible && (round.coverage[pl.id] ?? 1) > 0;
        const dead = !!f && !f.alive;
        const { guns, util } = loadout(inventory.get(pl.id) ?? []);
        const shown = f?.weapon && isGun(weaponKey(f.weapon)) ? f.weapon : guns[0] ?? null;
        const isSel = selected === pl.id;
        const hp = f?.hp ?? 0;
        return (
          <div key={pl.id} className="sb-item">
            <button type="button" className="sb-row" data-dead={dead || !known} aria-pressed={isSel}
              onClick={() => onSelect(isSel ? null : pl.id)}
              aria-label={`${pl.name}${!known ? ", no data" : dead ? ", dead" : `, ${hp} health`}${f?.money != null ? `, $${f.money}` : ""}`}>
              {dead || !known ? (
                <>
                  <span className="sb-name sb-name-dead">{pl.name}</span>
                  <span className="sb-dead-hp mono">{known ? 0 : "—"}</span>
                  <span className="sb-dead-money mono">{caps.money && f?.money != null ? `$${f.money}` : ""}</span>
                </>
              ) : (
                <>
                  <span className="sb-line">
                    <span className="sb-name">{pl.name}</span>
                    {pl.isBot ? <span className="badge sb-badge">BOT</span> : null}
                    <span className="grow" />
                    {f?.clip != null ? (
                      <span className="sb-ammo mono" aria-label={`${f.clip} in magazine${f.reserve != null ? `, ${f.reserve} in reserve` : ""}`}>
                        {f.clip}{f.reserve != null ? `/${f.reserve}` : ""}
                      </span>
                    ) : null}
                    {shown ? <WeaponIcon name={shown} height={13} label={`holding ${shown}`} /> : null}
                  </span>
                  {caps.health ? (
                    <span className="sb-line">
                      <span className="sb-hp" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, hp))}%` }} /></span>
                      <span className="sb-hpnum mono">{hp}</span>
                    </span>
                  ) : null}
                  <span className="sb-line sb-sub">
                    {caps.armor && f?.armor ? <WeaponIcon name={f.flags & FLAGS.helmet ? "armor_helmet" : "armor"} height={12} label={f.flags & FLAGS.helmet ? "Kevlar and helmet" : "Kevlar"} /> : null}
                    {caps.money && f?.money != null ? <span className="mono">${f.money}</span> : null}
                    <span className="grow" />
                    {util.map((u, i) => <WeaponIcon key={`${u}-${i}`} name={u} height={12} label={u} />)}
                    {f && f.flags & FLAGS.defuser ? <WeaponIcon name="defuser" height={12} label="Defuse kit" /> : null}
                    {f && f.flags & FLAGS.bomb ? <WeaponIcon name="c4" height={12} label="Bomb" /> : null}
                  </span>
                </>
              )}
            </button>
            {isSel && known && f && !dead ? <SetposCopy x={f.x} y={f.y} z={f.z} /> : null}
          </div>
        );
      })}
      {caps.participants === "partial" ? <p className="sb-note">POV demo: players without data are shown as “—”.</p> : null}
    </section>
  );
}
