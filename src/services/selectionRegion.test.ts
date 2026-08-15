/**
 * T6-1 — the clamp family's agreement pin.
 *
 * Written BEFORE the unification, against the copies as they stood: six call
 * sites carried the same two expressions, each under its own docblock restating
 * the same ruling, and `editOps.ts` counted itself the FIFTH application of it.
 * Six copies that agree by inspection are six copies that can stop agreeing in
 * one edit — which is the drift this suite exists to catch, and the reason the
 * arithmetic is imported rather than retyped from here on.
 *
 * The traps are the family's own, taken from the defects that produced it:
 *
 * - **raw vs clamped** — `setSelection` stores whatever it is handed while
 *   `cloneRegion`/`replaceRegion` clamp what they touch, so a consumer reading
 *   the selection raw described a different region from the one the audio used.
 * - **zero-length** — a region that resolves to nothing must STAY nothing
 *   rather than re-expand to the whole document, or a no-op becomes a
 *   whole-file edit.
 *
 * Inverted bounds are the third trap and are pinned separately, because unlike
 * these two they are a behaviour CHANGE rather than a pin: `editOps.ts` deferred
 * them to "this family's next round".
 *
 * Each row is driven through three DIFFERENT surfaces — `alignRegion` directly,
 * the effect runner's post-edit selection, and the span `Silence` zeroes — so
 * each reads its own copy of the arithmetic rather than a shared helper. That is
 * what makes this a pin: it is green against the six copies, and it stays green
 * when they become one.
 */
import { alignRegion } from './timingAlignService';
import { runEffectOnSelection } from './effectRunner';
import { silenceSelection } from './editOps';
import { registerEffect } from '../effects/EffectRegistry';
import { registerAllEffects } from '../effects/registerAll';
import { createDocument } from '../audio/AudioDocument';
import { useAppStore, makeInitialState, type SelectionRange } from '../stores/appStore';
import { _resetDspWorkerTestState } from '../__mocks__/createDspWorkerMock';

registerAllEffects();

const LEN = 4000;

/** Marks every sample the effect was handed, so the span the runner actually
 * sliced is readable off the document afterwards. */
registerEffect({
  id: 'test-region-probe',
  name: 'Region Probe',
  category: 'Utility',
  params: [],
  process: (channels) => ({ channels: channels.map((c) => c.map(() => 1)) }),
});

function seedDoc(fill = 0): void {
  const doc = createDocument({
    name: 'region.wav',
    sampleRate: 44100,
    channels: [new Float32Array(LEN).fill(fill)],
  });
  useAppStore.getState().addDocument(doc);
}

function activeDoc() {
  const s = useAppStore.getState();
  return s.documents.find((d) => d.id === s.activeDocumentId)!;
}

/** The half-open span of samples equal to `value` — the resolved region made
 * observable, whether it was written by the probe or emptied by Silence.
 * `null` when nothing matches, which is what an empty region leaves behind. */
function spanOf(value: number): { start: number; end: number } | null {
  const ch = activeDoc().channels[0];
  let start = -1;
  let end = -1;
  for (let i = 0; i < ch.length; i++) {
    if (ch[i] === value) {
      if (start === -1) start = i;
      end = i + 1;
    }
  }
  return start === -1 ? null : { start, end };
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetDspWorkerTestState();
});

afterEach(() => {
  _resetDspWorkerTestState();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

/** The family's trap table: what every copy of the arithmetic must answer. */
const TRAPS: {
  name: string;
  selection: SelectionRange | null;
  expected: { start: number; end: number };
}[] = [
  { name: 'no selection is the whole document', selection: null, expected: { start: 0, end: LEN } },
  {
    name: 'an in-range selection passes through untouched',
    selection: { start: 1000, end: 3000 },
    expected: { start: 1000, end: 3000 },
  },
  {
    name: 'a start before sample 0 clamps to 0 and keeps its end',
    selection: { start: -5000, end: 100 },
    expected: { start: 0, end: 100 },
  },
  {
    name: 'an end past the document clamps to docLength and keeps its start',
    selection: { start: 2000, end: 9000 },
    expected: { start: 2000, end: LEN },
  },
  {
    name: 'both ends outside resolve to the whole document',
    selection: { start: -5000, end: 9000 },
    expected: { start: 0, end: LEN },
  },
  {
    name: 'a zero-length selection stays zero-length, it does not re-expand',
    selection: { start: 2000, end: 2000 },
    expected: { start: 2000, end: 2000 },
  },
  {
    name: 'a zero-length selection past the end collapses onto docLength',
    selection: { start: 9000, end: 9000 },
    expected: { start: LEN, end: LEN },
  },
];

describe('the clamp family answers one pair (T6-1)', () => {
  for (const trap of TRAPS) {
    const empty = trap.expected.end === trap.expected.start;

    it(`${trap.name} — alignRegion`, () => {
      seedDoc();
      useAppStore.getState().setSelection(trap.selection);
      expect(alignRegion(activeDoc())).toEqual(trap.expected);
    });

    it(`${trap.name} — the effect runner's own region`, async () => {
      seedDoc();
      useAppStore.getState().setSelection(trap.selection);

      await runEffectOnSelection('test-region-probe', {});

      // `runEffectOnSelection` writes the region it resolved back as the
      // post-edit selection (`{ start, end: start + resultLen }`), and the probe
      // is equal-length, so this IS its resolved pair.
      expect(useAppStore.getState().selection).toEqual(trap.expected);
      expect(spanOf(1)).toEqual(empty ? null : trap.expected);
    });

    it(`${trap.name} — the span Silence zeroes`, () => {
      // Silenced samples are 0, so the document starts at a value that is not.
      seedDoc(0.5);
      useAppStore.getState().setSelection(trap.selection);
      // `silenceSelection` requires a selection; with none there is no region for
      // it to describe, which is the one row this surface cannot answer.
      if (trap.selection === null) return;

      silenceSelection();

      expect(spanOf(0)).toEqual(empty ? null : trap.expected);
    });
  }
});
