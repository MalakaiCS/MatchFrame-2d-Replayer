import { describe, expect, it } from "vitest";
import { posAt } from "@/components/TacticBoard";

describe("tactic board steps", () => {
  const t = { id: "a", kind: "ct" as const, x: 0, y: 0 };
  const d: Parameters<typeof posAt>[0] = { floor: 0, tokens: [t], strokes: [], steps: [{ pos: { a: [100, 0] } }, { pos: {} }, { pos: { a: [100, 100] } }] };
  it("keeps positions from earlier steps and eases between steps", () => {
    expect(posAt(d, t, 0)).toEqual([0, 0]);
    expect(posAt(d, t, 1)).toEqual([100, 0]);
    expect(posAt(d, t, 2)).toEqual([100, 0]);
    expect(posAt(d, t, 3)).toEqual([100, 100]);
    expect(posAt(d, t, 0.5)).toEqual([50, 0]);
    const q = posAt(d, t, 0.25);
    expect(q[0]).toBeGreaterThan(0);
    expect(q[0]).toBeLessThan(25);
  });
});
