import { describe, expect, it } from "vitest";
import { parseSteamId } from "@/lib/steam";

describe("Steam ID parsing", () => {
  it("accepts SteamID64 and /profiles/ links, refuses vanity and junk", () => {
    expect(parseSteamId("76561198000000001")).toBe("76561198000000001");
    expect(parseSteamId(" https://steamcommunity.com/profiles/76561198000000001/ ")).toBe("76561198000000001");
    expect(parseSteamId("https://steamcommunity.com/id/someone")).toBeNull();
    expect(parseSteamId("12345")).toBeNull();
    expect(parseSteamId("765611980000000011")).toBeNull();
  });
});
