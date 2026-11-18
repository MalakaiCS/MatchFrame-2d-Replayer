import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KILL_MODIFIER_ICONS, mapIcon, weaponIcon, weaponKey } from "@/viewer/icons";
import { listMaps } from "@/viewer/maps";

const pub = path.resolve(import.meta.dirname, "../../public");
const exists = (u: string) => existsSync(path.join(pub, u));

describe("weapon icons", () => {
  it.each([
    ["ak47", "ak47"], ["weapon_ak47", "ak47"], ["m4a1_silencer", "m4a1_silencer"], ["M4A4", "m4a1"], ["usp_silencer", "usp_silencer"],
    ["hkp2000", "hkp2000"], ["galil", "galilar"], ["knife_t", "knife_t"], ["knife_karambit", "knife_karambit"], ["knife_unknown_model", "knife"],
    ["inferno", "inferno"], ["incendiary", "incgrenade"], ["hegrenade", "hegrenade"], ["smokegrenade", "smokegrenade"], ["c4", "c4"],
    ["taser", "taser"], ["cz75a", "cz75a"], ["sg556", "sg556"], ["world", "world"],
  ])("%s -> %s", (input, key) => {
    expect(weaponKey(input)).toBe(key);
    expect(exists(weaponIcon(input)!)).toBe(true);
  });
  it("returns null for unknown or empty names", () => {
    expect(weaponIcon("laser_cannon")).toBeNull();
    expect(weaponIcon(null)).toBeNull();
    expect(weaponIcon("")).toBeNull();
  });
  it("kill modifier, side and map icons exist", () => {
    for (const u of Object.values(KILL_MODIFIER_ICONS)) expect(exists(u)).toBe(true);
    for (const m of listMaps()) expect(exists(mapIcon(m.id)!)).toBe(true);
    expect(exists("/cs2/radar/radarctlogo.svg") && exists("/cs2/radar/radartlogo.svg")).toBe(true);
  });
});
