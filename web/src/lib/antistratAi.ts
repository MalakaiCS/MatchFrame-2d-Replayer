/**
 * AI anti-strat brief: Claude turns the computed patterns (numbers only, no demo files) into a
 * game plan. Optional: only on when ANTHROPIC_API_KEY is set on the server.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { HttpError } from "./http";
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
  try {
    const res = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      // A declined request is re-run on a fallback model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: betaZodOutputFormat(Brief) },
      system: SYSTEM,
      messages: [{ role: "user", content: `Opponent patterns (JSON):\n${JSON.stringify(facts)}\n\nWrite the anti-strat brief.` }],
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
