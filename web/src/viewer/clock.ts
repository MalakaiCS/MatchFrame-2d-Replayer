/**
 * Phase clock. Countdown when the manifest carries reliable timing
 * (capabilities.clock === "countdown"); otherwise round-local elapsed time,
 * clearly labelled as elapsed.
 */
import type { Manifest, RoundPayload, RoundSummary } from "@/shared/contract";

export type Phase = "freeze" | "live" | "planted" | "over";

export interface ClockReading {
  phase: Phase;
  mode: "countdown" | "elapsed";
  /** Milliseconds shown on the clock. */
  ms: number;
  label: string;
  text: string;
}

export function formatMs(ms: number): string {
  const neg = ms < 0;
  const s = Math.floor(Math.abs(ms) / 1000);
  const m = Math.floor(s / 60);
  return `${neg ? "-" : ""}${m}:${String(s % 60).padStart(2, "0")}`;
}

export function clockAt(m: Manifest, round: RoundSummary, payload: RoundPayload | null, tick: number): ClockReading {
  const ms = (t: number) => Math.round((tick - t) * m.tickIntervalMs);
  const plant = payload?.bomb.find((b) => b.state === "planted")?.tick ?? null;
  let phase: Phase = "live";
  if (round.decidedTick !== null && tick >= round.decidedTick) phase = "over";
  else if (plant !== null && tick >= plant) phase = "planted";
  else if (round.freezeEndTick !== null && tick < round.freezeEndTick) phase = "freeze";

  const labels: Record<Phase, string> = { freeze: "Freeze time", live: "Round", planted: "Bomb planted", over: "Round over" };
  if (m.capabilities.clock !== "countdown" || round.freezeEndTick === null) {
    const e = ms(round.startTick);
    return { phase, mode: "elapsed", ms: e, label: `${labels[phase]} · elapsed`, text: formatMs(e) };
  }
  const T = m.timing;
  let remain: number;
  if (phase === "freeze") remain = (T.freezeTimeS ?? 0) * 1000 - ms(round.startTick);
  else if (phase === "planted") remain = (T.bombTimerS ?? 40) * 1000 - ms(plant!);
  else if (phase === "over") remain = 0;
  else remain = (T.roundTimeS ?? 115) * 1000 - ms(round.freezeEndTick);
  // Freeze time from the convar can differ from the recorded freeze end (timeouts, tactical pauses):
  // the recorded freeze end tick is authoritative for the phase, so clamp at zero.
  remain = Math.max(0, Math.round(remain));
  return { phase, mode: "countdown", ms: remain, label: labels[phase], text: formatMs(Math.ceil(remain / 1000) * 1000) };
}
