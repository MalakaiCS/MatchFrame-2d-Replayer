/**
 * Voice-comms synchronisation. The replay playhead is the source of truth.
 * A track starts at offsetMs on the demo timeline (demo-time = tick * tickIntervalMs),
 * is silent outside its recorded range, follows the replay speed, and is re-seeked
 * whenever its drift exceeds the tolerance (after buffering, scrubbing or rate changes).
 */

export const DRIFT_TOLERANCE_S = 0.12;
export const MAX_AUDIO_RATE = 4;

export interface SyncInput {
  tick: number;
  tickIntervalMs: number;
  offsetMs: number;
  playing: boolean;
  speed: number;
  /** Audio duration in seconds, or NaN if unknown yet. */
  duration: number;
  currentTime: number;
  paused: boolean;
}

export interface SyncAction {
  /** Seek target in seconds, or null to leave the position alone. */
  seekTo: number | null;
  play: boolean;
  rate: number;
  muted: boolean;
  inRange: boolean;
  drift: number;
}

export function audioTimeFor(tick: number, tickIntervalMs: number, offsetMs: number): number {
  return (tick * tickIntervalMs - offsetMs) / 1000;
}

export function decide(s: SyncInput): SyncAction {
  const target = audioTimeFor(s.tick, s.tickIntervalMs, s.offsetMs);
  const known = Number.isFinite(s.duration) && s.duration > 0;
  const inRange = target >= 0 && (!known || target < s.duration);
  // Rates beyond what browsers play intelligibly are muted rather than distorted.
  const tooFast = s.speed > MAX_AUDIO_RATE;
  const rate = Math.min(Math.max(s.speed, 0.25), MAX_AUDIO_RATE);
  const drift = s.currentTime - target;
  if (!inRange) {
    return { seekTo: null, play: false, rate, muted: true, inRange, drift };
  }
  const needSeek = Math.abs(drift) > DRIFT_TOLERANCE_S || (!s.playing && Math.abs(drift) > 0.03);
  return {
    seekTo: needSeek ? Math.max(0, target) : null,
    play: s.playing && !tooFast,
    rate,
    muted: tooFast,
    inRange,
    drift,
  };
}

/** Binds an <audio> element to the replay clock. Call update() on every animation frame. */
export class AudioSync {
  private lastSeekAt = 0;
  constructor(public el: HTMLAudioElement, public offsetMs: number, private tickIntervalMs: number) {}

  update(tick: number, playing: boolean, speed: number) {
    const a = decide({
      tick, tickIntervalMs: this.tickIntervalMs, offsetMs: this.offsetMs, playing, speed,
      duration: this.el.duration, currentTime: this.el.currentTime, paused: this.el.paused,
    });
    if (this.el.playbackRate !== a.rate) this.el.playbackRate = a.rate;
    if (this.el.muted !== a.muted) this.el.muted = a.muted;
    const now = performance.now();
    if (a.seekTo !== null && now - this.lastSeekAt > 150 && this.el.readyState >= 1) {
      this.el.currentTime = a.seekTo;
      this.lastSeekAt = now;
    }
    if (a.play && this.el.paused) void this.el.play().catch(() => {});
    if (!a.play && !this.el.paused) this.el.pause();
    return a;
  }
}
