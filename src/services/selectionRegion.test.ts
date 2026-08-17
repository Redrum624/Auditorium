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
import { resolveRegion } from './selectionRegion';
import { alignRegion } from './timingAlignService';
import { runEffectOnSelection } from './effectRunner';
import { copySelection, silenceSelection } from './editOps';
import { getClipboard } from './clipboard';
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

/**
 * T6-2 — the family's third trap, and the round `editOps.ts` deferred it to.
 *
 * A selection dragged right-to-left is `start > end`. The gesture layer's
 * `dragToSelection` has always ordered its own pair, so no drag produced one —
 * but `setSelection` is a public store action with nine non-test callers (the
 * E2E hooks and a rollback restore among them), and it stored whatever it was
 * handed. Everything downstream then inherited the inversion, and the codebase
 * splits three ways on what to do with it: the audio primitives THROW
 * (`clampRange`), a few readers guard and degrade (the lyric aligner falls back
 * to the whole file, the painters draw nothing), and most simply assume.
 *
 * ## Why the store write, and not a read helper
 *
 * A read helper can only fix the consumers that call it. Counting them: eight
 * call `resolveRegion` (T6-1), and around twenty-five read `state.selection`
 * directly and always will — the status bar's duration, the properties panel,
 * the transport's play-from and loop region, the playback engine's loop bounds,
 * three dialogs' `regionSamples` readouts, the align dialog's scope line. Those
 * are not resolving a region against a document; they are describing the
 * selection, which needs no document to be correct, and requiring them to route
 * through a document-shaped helper to learn which end is which would be the
 * fourteen-member family's mistake in a new costume.
 *
 * So the invariant is established where the value is BORN. That is this
 * codebase's own precedent for exactly this shape: `applyEditorZoom` is "the ONE
 * clamping writer" (`fileService.ts`), introduced after six surfaces were found
 * writing zoom raw. Selection is that story one field along.
 *
 * The clamp stays at the read, because it needs the document and the store does
 * not have one to hand at every write. Two invariants, two honest homes: ORDER
 * where it is written, EXTENT where the document is known. `resolveRegion`
 * orders as well, and that is not a second boundary — it takes selections from
 * its callers as well as from the store, and a function that is the single place
 * has to be total.
 */
describe('an inverted selection is ordered where it is written (T6-2)', () => {
  it('setSelection stores the span the drag swept, lower bound first', () => {
    seedDoc();
    useAppStore.getState().setSelection({ start: 3000, end: 1000 });
    expect(useAppStore.getState().selection).toEqual({ start: 1000, end: 3000 });
  });

  it('leaves an already-ordered selection exactly as it was handed', () => {
    seedDoc();
    const sel = { start: 1000, end: 3000 };
    useAppStore.getState().setSelection(sel);
    // Identity, not just equality: a fresh object per write would be a new store
    // snapshot on every set, repainting consumers that subscribe to it.
    expect(useAppStore.getState().selection).toBe(sel);
  });

  it('clears to null without inventing a region', () => {
    seedDoc();
    useAppStore.getState().setSelection({ start: 3000, end: 1000 });
    useAppStore.getState().setSelection(null);
    expect(useAppStore.getState().selection).toBeNull();
  });

  it('Silence zeroes the swept span instead of throwing on a negative length', () => {
    seedDoc(0.5);
    useAppStore.getState().setSelection({ start: 3000, end: 1000 });

    // `new Float32Array(end - start)` with an inverted pair threw RangeError
    // before `replaceRegion` was ever reached.
    silenceSelection();

    expect(spanOf(0)).toEqual({ start: 1000, end: 3000 });
  });

  it('Copy takes the swept span instead of throwing in clampRange', () => {
    seedDoc(0.5);
    useAppStore.getState().setSelection({ start: 3000, end: 1000 });

    // `copySelection` is the one edit op that reads the selection raw rather
    // than through the resolver, so it had nothing between it and the throw.
    copySelection();

    expect(getClipboard()?.channels[0].length).toBe(2000);
  });

  it('the effect runner runs over the swept span, and says so afterwards', async () => {
    seedDoc();
    useAppStore.getState().setSelection({ start: 3000, end: 1000 });

    await runEffectOnSelection('test-region-probe', {});

    expect(spanOf(1)).toEqual({ start: 1000, end: 3000 });
    expect(useAppStore.getState().selection).toEqual({ start: 1000, end: 3000 });
  });

  it('describes a positive length, which is what the status bar reads', () => {
    seedDoc();
    useAppStore.getState().setSelection({ start: 3000, end: 1000 });
    const sel = useAppStore.getState().selection!;
    // The status bar renders `end - start` straight, so an inverted pair showed
    // a negative duration next to two correct timestamps.
    expect(sel.end - sel.start).toBe(2000);
  });

  it('orders a pair handed straight to resolveRegion, which is not always the store’s', () => {
    const doc = createDocument({
      name: 'region.wav',
      sampleRate: 44100,
      channels: [new Float32Array(LEN)],
    });
    expect(resolveRegion(doc, { start: 3000, end: 1000 })).toEqual({ start: 1000, end: 3000 });
    // Ordered AND clamped: clamping is monotone, so it cannot turn an ordered
    // pair into an inverted one, and either order of the two steps agrees.
    expect(resolveRegion(doc, { start: 9000, end: -5000 })).toEqual({ start: 0, end: LEN });
  });
});

describe('resolveRegion', () => {
  it('answers the family trap table directly', () => {
    const doc = createDocument({
      name: 'region.wav',
      sampleRate: 44100,
      channels: [new Float32Array(LEN)],
    });
    for (const trap of TRAPS) {
      expect(resolveRegion(doc, trap.selection)).toEqual(trap.expected);
    }
  });

  it('resolves against the document it is handed, not the active one', () => {
    seedDoc();
    const other = createDocument({
      name: 'other.wav',
      sampleRate: 44100,
      channels: [new Float32Array(100)],
    });
    expect(resolveRegion(other, { start: 0, end: 9000 })).toEqual({ start: 0, end: 100 });
  });
});
