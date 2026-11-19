/** Plan copy and price formatting shared by the website and the billing page. */
export interface PriceView { amount: number; currency: string; interval: string | null; intervalCount: number }

export function formatPrice(p: PriceView | null | undefined): string | null {
  if (!p) return null;
  const money = new Intl.NumberFormat("en", { style: "currency", currency: p.currency.toUpperCase(), minimumFractionDigits: p.amount % 100 ? 2 : 0 }).format(p.amount / 100);
  if (!p.interval) return money;
  const per = p.intervalCount > 1 ? `${p.intervalCount} ${p.interval}s` : p.interval;
  return `${money} / ${per}`;
}

export const PLAN_COPY = {
  personal: {
    name: "Personal",
    tagline: "For one player, analyst or coach.",
    points: [
      "Your own private replay library",
      "Upload demos and whole BO3 archives",
      "Notes, bookmarks, playlists and comms sync",
      "Read-only and round links anyone can open",
      "Also covers you inside any team you join",
    ],
  },
  team: {
    name: "Team",
    tagline: "One plan, everyone on the roster.",
    points: [
      "Every team member can upload and review",
      "Shared team library, notes, bookmarks and playlists",
      "Roles: owner, coach, analyst, player, viewer",
      "Members only need a free account",
      "The team owner manages billing",
    ],
  },
} as const;
