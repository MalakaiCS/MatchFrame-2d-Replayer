/**
 * AI anti-strat brief: Claude turns the computed patterns (numbers only, no demo files) into a
 * game plan. Optional: only on when ANTHROPIC_API_KEY is set on the server.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { HttpError } from "./http";
import type { AreaReport, Defaults } from "./areas";
import type { PatternReport } from "./patterns";

export const aiEnabled = () => !!process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTISTRAT_MODEL || "claude-opus-5-5";

export const Brief = z.object({
  summary: z.string().describe("Two or three sentences: how this team plays this map."),
  tSide: z.array(z.string()).describe("Their T-side tendencies and how to counter each, most important first."),
  ctSide: z.array(z.string()).describe("Their CT-side tendencies and how to counter each, most important first."),
  players: z.array(z.object({ name: z.string(), notes: z.string() })).describe("Per player: habits worth exploiting."),
  gamePlan: z.array(z.string()).describe("Concrete calls for our team: what to do on CT, on T, on pistols and in the economy."),
  caveats: z.array(z.string()).describe("Where the sample is small or the data is ambiguous."),
});
export type BriefT = z.infer<typeof Brief>;

const SYSTEM = `You are a Counter-Strike 2 analyst preparing an anti-strat for a team about to play an opponent.
You get patterns measured from the opponent's demos on one map: each has a share (n of rounds), a confidence
and a rule-based counter. Write a practical brief for players and a coach.
- Use only the patterns given; do not invent positions, callouts or players. Use the spot labels as given.
- Weigh strong patterns over weak ones and say so when a sample is small (under 5 rounds).
- Be specific and short: each item is one or two sentences a player can act on.`;

let client: Anthropic | null = null;

export async function writeBrief(team: string, map: string, report: PatternReport): Promise<BriefT> {
  client ??= new Anthropic();
  const facts = {
    team, map, demos: report.demos, rounds: report.rounds, sites: report.sites,
    patterns: report.patterns.map((p) => ({
      category: p.category, side: p.side, player: p.player ?? null, title: p.title, detail: p.detail,
      share: Math.round(p.share * 100) / 100, n: p.n, of: p.of, confidence: p.confidence, counter: p.counter,
      spot: p.spot?.label ?? null,
    })),
  };
  return call(SYSTEM, `Opponent patterns (JSON):\n${JSON.stringify(facts)}\n\nWrite the anti-strat brief.`, Brief);
}

async function call<S extends z.ZodType>(system: string, content: string, schema: S): Promise<z.infer<S>> {
  client ??= new Anthropic();
  try {
    const res = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      // A declined request is re-run on a fallback model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: betaZodOutputFormat(schema) },
      system,
      messages: [{ role: "user", content }],
    });
    if (res.stop_reason === "refusal") throw new HttpError(422, "AI_REFUSED", "The AI could not write a brief for this data.");
    if (res.stop_reason === "max_tokens" || !res.parsed_output) throw new HttpError(502, "AI_INCOMPLETE", "The AI brief came back incomplete. Try again.");
    return res.parsed_output;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, "AI_BUSY", "The AI is busy right now. Try again in a minute.");
    if (e instanceof Anthropic.AuthenticationError) {
      console.error("[antistrat] ANTHROPIC_API_KEY was rejected");
      throw new HttpError(503, "AI_UNAVAILABLE", "AI briefs are not set up correctly on this server.");
    }
    if (e instanceof Anthropic.APIError) {
      console.error("[antistrat] AI request failed", e.status, e.message);
      throw new HttpError(502, "AI_FAILED", "The AI brief failed. Try again.");
    }
    throw e;
  }
}

export const PlayerBrief = z.object({
  summary: z.string().describe("Two or three sentences: what this player should expect in their area against this team."),
  ctSide: z.array(z.string()).describe("How to play the area on CT against their T side: setups, timings, utility, when to fall back or rotate."),
  tSide: z.array(z.string()).describe("How to attack the area on T against their CT side: who holds it, where, how to take it."),
  watchFor: z.array(z.string()).describe("Specific opponent players, timings and utility to watch for."),
  caveats: z.array(z.string()).describe("Where the sample is small or the data is ambiguous."),
});
export type PlayerBriefT = z.infer<typeof PlayerBrief>;

const PLAYER_SYSTEM = `You are a Counter-Strike 2 coach writing a personal anti-strat sheet for ONE player on our team,
about the area of the map they play. You get the measured behaviour of the opponent in that area (from the
opponent's demos), as counts and shares, plus the opponent's default setups.
- Use only the numbers given; do not invent positions, callouts, utility or players.
- Talk to the player directly ("you"). Each item is one or two sentences they can act on in a round.
- Say when a sample is small (under 5 rounds).`;

const slim = (r: AreaReport | null) => r && { headline: r.headline, rounds: r.rounds, sections: r.sections, tips: r.tips };

export async function writePlayerBrief(opponent: string, map: string, player: { name: string; role: { CT?: string; T?: string } },
  ct: AreaReport | null, t: AreaReport | null, defaults: Defaults): Promise<PlayerBriefT> {
  client ??= new Anthropic();
  const facts = {
    opponent, map, player: player.name, role: player.role,
    ourArea: { CT: ct?.area ?? [], T: t?.area ?? [] },
    asCT: slim(ct), asT: slim(t),
    opponentDefaults: {
      T: { notes: defaults.T.notes, players: defaults.T.players.map((p) => ({ name: p.name, role: p.role, at: p.checkpoints })) },
      CT: { notes: defaults.CT.notes, players: defaults.CT.players.map((p) => ({ name: p.name, role: p.role, at: p.checkpoints })) },
    },
  };
  return call(PLAYER_SYSTEM, `Data (JSON):\n${JSON.stringify(facts)}\n\nWrite ${player.name}'s anti-strat sheet.`, PlayerBrief);
}
