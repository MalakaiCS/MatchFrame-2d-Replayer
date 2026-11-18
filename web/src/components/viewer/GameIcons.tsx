"use client";
import type { GameEvent } from "@/shared/contract";
import { KILL_MODIFIER_ICONS, weaponIcon } from "@/viewer/icons";

/** Equipment icon with a text fallback when no icon is known. Decorative when `label` is omitted. */
export function WeaponIcon({ name, height = 14, label }: { name: string | null | undefined; height?: number; label?: string }) {
  const src = weaponIcon(name);
  const text = (name ?? "").replace(/^weapon_/, "");
  if (!src) return text ? <span className="weapon-text">{text}</span> : null;
  return <img className="game-icon" src={src} alt={label ?? ""} title={text} height={height} style={{ height }} loading="lazy" decoding="async" />;
}

const MODIFIERS: [keyof typeof KILL_MODIFIER_ICONS, string][] = [
  ["attackerBlind", "blind"], ["noscope", "no-scope"], ["throughSmoke", "through smoke"], ["wallbang", "wallbang"], ["headshot", "headshot"],
];

/** Kill-feed modifiers, in the order the in-game feed reads. */
export function KillModifiers({ e, height = 13 }: { e: GameEvent; height?: number }) {
  const on = MODIFIERS.filter(([k]) => e[k]);
  if (!on.length) return null;
  return (
    <>
      {on.map(([k, label]) => (
        <img key={k} className="game-icon" src={KILL_MODIFIER_ICONS[k]} alt={label} title={label} height={height} style={{ height }} />
      ))}
    </>
  );
}
