/** SteamID64 from a 17-digit ID or a steamcommunity.com/profiles/<id> link. Vanity links are not resolved. */
export function parseSteamId(input: string): string | null {
  const s = input.trim();
  const m = s.match(/^7656119\d{10}$/) ?? s.match(/steamcommunity\.com\/profiles\/(7656119\d{10})/);
  if (!m) return null;
  return m[1] ?? m[0];
}
