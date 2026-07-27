import { planRemix } from '../dsp/remixPlan';
import type { PlanRemixOptions } from '../dsp/remixPlan';
import type { RemixAnalysis } from '../dsp/remixFeatures';

// Protocol (Task T13 fix round 1): a SESSION-SCOPED planner. The renderer
// posts `init` ONCE, when a remix session is created, carrying the whole
// `RemixAnalysis`; the worker keeps it RESIDENT for the life of the session.
// Every subsequent `plan` request is then a small message in (options only)
// and a small `PlanRemixResult` out.
//
// WHY RESIDENT, not per-call: the DP is ~O(M^2) and measured 302 ms for a
// single plan at the worst case reachable under `MAX_ANALYSIS_SECONDS = 600`
// (200 BPM, 600 s -> M = 499, 749 000 cells, 3.0x `MAX_DP_CELLS`), rising to
// ~1.0 s at `rollIndex = 3` and ~5.6 s for a lock-recovery sweep — a renderer
// freeze with no progress and no cancel. Shipping the analysis per call would
// have traded that for a ~1.7 MB structured clone on EVERY adjustment
// (reject / nudge / re-roll / lock recovery), i.e. exactly the interaction
// latency the routing exists to protect. Paying the clone ONCE at session
// creation puts it behind the ~630 ms analysis that already dominates there.
//
// The analysis is deliberately NOT transferred: its typed arrays are the
// renderer's own `tempoAnalysis` cache rows, and transferring would DETACH
// them, destroying the shared cache every other consumer reads.
export interface RemixPlanInitMessage {
  type: 'init';
  analysis: RemixAnalysis;
}
export interface RemixPlanRequestMessage {
  type: 'plan';
  id: number;
  options: PlanRemixOptions;
}
export type RemixPlanMessage = RemixPlanInitMessage | RemixPlanRequestMessage;

export type RemixPlanReply =
  | { type: 'planned'; id: number; result: ReturnType<typeof planRemix> }
  | { type: 'error'; id: number; message: string };

// Narrow cast so this compiles under the DOM lib without the conflicting
// `webworker` lib `self` declaration (mirrors tempo.worker.ts).
const ctx = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<RemixPlanMessage>) => void) | null;
};

let resident: RemixAnalysis | null = null;

ctx.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === 'init') {
    resident = msg.analysis;
    return;
  }
  if (msg.type !== 'plan') return;

  try {
    if (!resident) {
      throw new Error('remixPlan worker: received a plan request before init');
    }
    // `planRemix` never throws for a user-facing condition — every refusal is
    // its own `{ok:false, reason}` arm — so anything caught below is a real
    // programming error and is reported as such rather than swallowed.
    const result = planRemix(resident, msg.options);
    ctx.postMessage({ type: 'planned', id: msg.id, result });
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
