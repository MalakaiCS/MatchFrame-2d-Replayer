/**
 * CS2 icon resolution (assets in public/cs2, see public/cs2/PROVENANCE.md).
 * Maps parser weapon names (Awpy snapshot and event strings, with or without
 * "weapon_" prefix) to equipment SVGs. Unknown names return null so callers
 * fall back to text.
 */
import EQUIPMENT from "./equipment-icons.json";

const AVAILABLE = new Set<string>(EQUIPMENT);

const ALIASES: Record<string, string> = {
  galil: "galilar", m4a4: "m4a1", m4a1s: "m4a1_silencer", "m4a1-s": "m4a1_silencer", usp: "usp_silencer", usps: "usp_silencer",
  "usp-s": "usp_silencer", "usp_s": "usp_silencer", "usp-s_silencer": "usp_silencer", dualies: "elite", dual_berettas: "elite", berettas: "elite",
  cz75: "cz75a", "cz75-auto": "cz75a", zeus: "taser", zeusx27: "taser", mp5: "mp5sd", "mp5-sd": "mp5sd", sg553: "sg556", sg_553: "sg556",
  r8: "revolver", deserteagle: "deagle", desert_eagle: "deagle", five_seven: "fiveseven", "five-seven": "fiveseven",
  smoke: "smokegrenade", smoke_grenade: "smokegrenade", flash: "flashbang", he: "hegrenade", he_grenade: "hegrenade",
  incendiary: "incgrenade", incendiarygrenade: "incgrenade", fire: "inferno", molotov_projectile: "molotov",
  bomb: "c4", planted: "planted_c4", kevlar_helmet: "armor_helmet", vesthelm: "armor_helmet", vest: "kevlar",
  defuse_kit: "defuser", kit: "defuser", bizon: "bizon", ppbizon: "bizon", pp_bizon: "bizon",
};

export function weaponKey(name: string | null | undefined): string | null {
  if (!name) return null;
  let k = name.trim().toLowerCase().replace(/^weapon_/, "").replace(/^item_/, "").replace(/\s+/g, "_");
  if (!k) return null;
  k = ALIASES[k] ?? k;
  if (AVAILABLE.has(k)) return k;
  if (k.startsWith("knife") || k.includes("bayonet") || k.includes("karambit") || k.includes("dagger")) return "knife";
  return null;
}

export function weaponIcon(name: string | null | undefined): string | null {
  const k = weaponKey(name);
  return k ? `/cs2/equipment/${k}.svg` : null;
}

export const KILL_MODIFIER_ICONS = {
  headshot: "/cs2/deathnotice/icon_headshot.svg",
  wallbang: "/cs2/deathnotice/penetrate.svg",
  throughSmoke: "/cs2/deathnotice/smoke_kill.svg",
  attackerBlind: "/cs2/deathnotice/blind_kill.svg",
  noscope: "/cs2/deathnotice/noscope.svg",
} as const;

export function mapIcon(mapId: string | null | undefined): string | null {
  return mapId && /^de_[a-z0-9]+$/.test(mapId) ? `/cs2/map_icons/${mapId}.svg` : null;
}
