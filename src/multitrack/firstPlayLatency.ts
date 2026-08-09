import type { AudioDocument } from '../audio/AudioDocument';
import { MultitrackPlayer } from './MultitrackPlayer';
import type { Session } from './session';

/**
 * R4 (P2-7) — the first-play latency MEASUREMENT the audit said never
 * existed. The v1.5.2 smoke-6b fix stabilised the TEST (poll up to 3 s for
 * the transport to advance) without ever measuring the underlying behaviour:
 * how long the multitrack player's `AudioContext` actually takes between
 * "user presses Play" and "first sample is audible" on a COLD first play.
 * This module is the instrument; `scripts/first-play-latency-rig.cjs` runs
 * it in the real app and reports the number.
 *
 * WHAT IS MEASURED (per probe, all from `performance.now()`-style clocks):
 *  - `ctxCreateMs` — `new AudioContext()` construction (cold probe only;
 *    the warm probe reuses the player's context, pinned by test).
 *  - `playCallMs` — the synchronous `play()` body: graph build + per-clip
 *    buffer bake + source scheduling.
 *  - `timeToRunningMs` — play() return → `ctx.state === 'running'`.
 *  - `timeToClockAdvanceMs` — play() return → `ctx.currentTime` first moves
 *    past its at-play value. On a cold context this is the real "audio
 *    device pipeline opened and rendering started" moment, which is exactly
 *    the delay smoke 6b's poll was papering over. On a WARM (already
 *    running) context the clock ticks continuously even while idle, so this
 *    reads ~one poll tick — that is not a defect, it is the honest statement
 *    that the pipeline is already hot.
 *  - `timeToPositionAdvanceMs` — play() return → `getPositionSample() > 0`,
 *    the user-visible playhead. Derived from the same clock but through the
 *    player's own position math, so it additionally pins the wiring.
 *  - `baseLatencyMs` / `outputLatencyMs` — the context's own declared
 *    processing/output latencies, when the implementation exposes them.
 *  - `audibleEstimateMs` — `timeToClockAdvanceMs + outputLatencyMs`: samples
 *    render at clock-advance and reach the speaker one output-latency
 *    later. An estimate (no loopback capture), stated as such.
 *
 * Polls run in ONE interleaved loop recording FIRST-observation times, so
 * no condition's measurement waits on another's. A condition that never
 * happens within `pollTimeoutMs` reports null and is named in `timedOut`.
 * The waiting primitive (`tick`) and clock (`now`) are injectable so the
 * unit tests drive a fully deterministic fake world; production uses real
 * `setTimeout(0)` (~1–4 ms granularity — fine for the tens-of-ms scale this
 * measures).
 */

export interface FirstPlayProbe {
  /** AudioContext construction time; null on the warm probe (no creation). */
  ctxCreateMs: number | null;
  /** `ctx.state` immediately after creation; null on the warm probe. */
  initialCtxState: string | null;
  playCallMs: number;
  timeToRunningMs: number | null;
  timeToClockAdvanceMs: number | null;
  timeToPositionAdvanceMs: number | null;
  baseLatencyMs: number | null;
  outputLatencyMs: number | null;
  audibleEstimateMs: number | null;
  /** Names of the conditions that hit the poll deadline. */
  timedOut: string[];
}

export interface FirstPlayLatencyReport {
  ok: boolean;
  reason: string | null;
  /** Fresh player, fresh AudioContext — the P2-7 case. */
  cold: FirstPlayProbe | null;
  /** Second play on the SAME player/context immediately after. */
  warm: FirstPlayProbe | null;
}

interface CtxLatencies {
  state?: string;
  baseLatency?: number;
  outputLatency?: number;
}

const defaultTick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function probeOnce(
  player: MultitrackPlayer,
  session: Session,
  docs: Map<string, AudioDocument>,
  getCtx: () => AudioContext | null,
  now: () => number,
  tick: () => Promise<void>,
  pollTimeoutMs: number
): Promise<FirstPlayProbe | { failed: string }> {
  const tPlay0 = now();
  player.play(0, session, docs);
  const playCallMs = now() - tPlay0;
  const ctx = getCtx();
  if (!ctx) return { failed: 'no AudioContext was created' };
  if (player.state !== 'playing') return { failed: 'play() did not start (no schedulable clips?)' };

  const tAfterPlay = now();
  const clockAtPlay = ctx.currentTime;
  let timeToRunningMs: number | null = null;
  let timeToClockAdvanceMs: number | null = null;
  let timeToPositionAdvanceMs: number | null = null;

  const deadline = tAfterPlay + pollTimeoutMs;
  for (;;) {
    const t = now();
    const lat = ctx as unknown as CtxLatencies;
    if (timeToRunningMs === null && lat.state === 'running') timeToRunningMs = t - tAfterPlay;
    if (timeToClockAdvanceMs === null && ctx.currentTime > clockAtPlay) {
      timeToClockAdvanceMs = t - tAfterPlay;
    }
    if (timeToPositionAdvanceMs === null && player.getPositionSample() > 0) {
      timeToPositionAdvanceMs = t - tAfterPlay;
    }
    const allDone =
      timeToRunningMs !== null && timeToClockAdvanceMs !== null && timeToPositionAdvanceMs !== null;
    if (allDone || t >= deadline) break;
    await tick();
  }

  const timedOut: string[] = [];
  if (timeToRunningMs === null) timedOut.push('running');
  if (timeToClockAdvanceMs === null) timedOut.push('clockAdvance');
  if (timeToPositionAdvanceMs === null) timedOut.push('positionAdvance');

  const lat = ctx as unknown as CtxLatencies;
  const baseLatencyMs = typeof lat.baseLatency === 'number' ? lat.baseLatency * 1000 : null;
  const outputLatencyMs = typeof lat.outputLatency === 'number' ? lat.outputLatency * 1000 : null;

  player.stop();

  return {
    ctxCreateMs: null,
    initialCtxState: null,
    playCallMs,
    timeToRunningMs,
    timeToClockAdvanceMs,
    timeToPositionAdvanceMs,
    baseLatencyMs,
    outputLatencyMs,
    audibleEstimateMs:
      timeToClockAdvanceMs !== null && outputLatencyMs !== null
        ? timeToClockAdvanceMs + outputLatencyMs
        : null,
    timedOut,
  };
}

export async function measureFirstPlayLatency(
  session: Session,
  docs: Map<string, AudioDocument>,
  createContext: () => AudioContext,
  now: () => number = () => performance.now(),
  tick: () => Promise<void> = defaultTick,
  pollTimeoutMs = 5000
): Promise<FirstPlayLatencyReport> {
  let ctx: AudioContext | null = null;
  let ctxCreateMs: number | null = null;
  let initialCtxState: string | null = null;
  let createCalls = 0;

  const player = new MultitrackPlayer({
    createContext: () => {
      createCalls++;
      const t0 = now();
      ctx = createContext();
      ctxCreateMs = now() - t0;
      const state = (ctx as unknown as CtxLatencies).state;
      initialCtxState = typeof state === 'string' ? state : null;
      return ctx;
    },
  });

  try {
    const cold = await probeOnce(player, session, docs, () => ctx, now, tick, pollTimeoutMs);
    if ('failed' in cold) return { ok: false, reason: cold.failed, cold: null, warm: null };
    cold.ctxCreateMs = ctxCreateMs;
    cold.initialCtxState = initialCtxState;

    const warm = await probeOnce(player, session, docs, () => ctx, now, tick, pollTimeoutMs);
    if ('failed' in warm) return { ok: false, reason: warm.failed, cold, warm: null };
    if (createCalls !== 1) {
      // The warm probe must reuse the cold probe's context, or "warm" is a lie.
      return { ok: false, reason: `context created ${createCalls} times, expected 1`, cold, warm };
    }

    return { ok: true, reason: null, cold, warm };
  } finally {
    player.dispose();
  }
}
