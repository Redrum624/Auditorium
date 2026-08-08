import { render, screen, fireEvent } from '@testing-library/react';
import PropertiesPanel from './PropertiesPanel';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { createClip, type Clip } from '../../multitrack/session';
import { resolveClipFadeSpecs } from '../../multitrack/mixdown';
import { formatTime } from '../../utils/timeFormat';

/**
 * X4 — the Properties panel's fade controls (multitrack view).
 *
 * What this file exists to prove:
 *  - fade lengths bind through setClipFade (C4): the input echoes the STORE's
 *    clamp, never a UI re-implementation of it, and the draft never fights
 *    the user mid-keystroke (T36);
 *  - the curve picker carries the ruling-2 behaviour labels ('Ducked', not
 *    'Exponential') and writes through setClipFade;
 *  - a live crossfade's facing edge is a readout, not an input (rule 3 is
 *    sample-exact), with Release clearing BOTH facing fades;
 *  - Arm is the direct recovery path for a raw/dissolved overlap (carried X5
 *    finding 1), enabled exactly up to the away-room boundary.
 */

const RATE = 44_100;

function addDoc(): AudioDocument {
  const doc = createDocument({
    name: 'clip.wav',
    sampleRate: RATE,
    channels: [new Float32Array(RATE * 10)],
  });
  useAppStore.getState().addDocument(doc);
  return doc;
}

function seedClip(
  doc: AudioDocument,
  opts: { startSample: number; lengthSample: number }
): Clip {
  const clip = createClip({
    documentId: doc.id,
    startSample: opts.startSample,
    offsetSample: 0,
    lengthSample: opts.lengthSample,
  });
  useSessionStore.getState().addClip(useSessionStore.getState().session.tracks[0].id, clip);
  return clip;
}

function storeClip(clipId: string): Clip {
  for (const t of useSessionStore.getState().session.tracks) {
    const c = t.clips.find((x) => x.id === clipId);
    if (c) return c;
  }
  throw new Error(`clip ${clipId} not found`);
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(RATE);
  useAppStore.setState({ view: 'multitrack' });
});

describe('fade length inputs — bound to the store clamp, local-draft pattern', () => {
  function seedSelected(lengthSample = RATE): Clip {
    const clip = seedClip(addDoc(), { startSample: 0, lengthSample });
    useSessionStore.getState().setSelectedClip(clip.id);
    return clip;
  }

  it('commits plain seconds through setClipFade on Enter and echoes the stored value', () => {
    const clip = seedSelected();
    render(<PropertiesPanel />);
    const input = screen.getByLabelText('Fade in length') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.5' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(storeClip(clip.id).fadeInSample).toBe(22_050);
    expect(screen.getByLabelText<HTMLInputElement>('Fade in length').value).toBe('0:00.500');
  });

  it('echoes the STORE clamp when the request exceeds the clip length (C4 — no UI clamp)', () => {
    const clip = seedSelected(RATE); // 1 s clip
    render(<PropertiesPanel />);
    const input = screen.getByLabelText('Fade in length') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.blur(input);

    expect(storeClip(clip.id).fadeInSample).toBe(RATE); // clamped to the clip
    expect(screen.getByLabelText<HTMLInputElement>('Fade in length').value).toBe('0:01.000');

    // Commit the same over-ask AGAIN: the store value does not change this
    // time, so no re-key/remount can rescue a wrong echo — this pins the
    // commit path itself returning the STORE's answer, not the request.
    const input2 = screen.getByLabelText('Fade in length') as HTMLInputElement;
    fireEvent.change(input2, { target: { value: '999' } });
    fireEvent.blur(input2);
    expect(storeClip(clip.id).fadeInSample).toBe(RATE);
    expect(screen.getByLabelText<HTMLInputElement>('Fade in length').value).toBe('0:01.000');
  });

  it('the STANDING fade wins at the meet boundary, and the echo shows what was granted', () => {
    const clip = seedSelected(RATE);
    useSessionStore.getState().setClipFade(clip.id, 'out', { lengthSample: 22_050 });
    render(<PropertiesPanel />);
    const input = screen.getByLabelText('Fade in length') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1.0' } }); // asks for the whole clip
    fireEvent.blur(input);

    // Granted exactly up to the meet: fadeIn + fadeOut === lengthSample.
    expect(storeClip(clip.id).fadeInSample).toBe(22_050);
    expect(storeClip(clip.id).fadeOutSample).toBe(22_050); // standing fade untouched
    expect(screen.getByLabelText<HTMLInputElement>('Fade in length').value).toBe('0:00.500');
  });

  it('keeps an intermediate draft without snapping, commits on blur only (T36)', () => {
    const clip = seedSelected();
    render(<PropertiesPanel />);
    const input = screen.getByLabelText('Fade in length') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.' } });
    expect(storeClip(clip.id).fadeInSample).toBeUndefined(); // store untouched mid-typing
    expect(input.value).toBe('0.'); // draft survives verbatim
    fireEvent.change(input, { target: { value: '0.25' } });
    fireEvent.blur(input);
    expect(storeClip(clip.id).fadeInSample).toBe(11_025);
  });

  it('Escape reverts the draft and commits nothing', () => {
    const clip = seedSelected();
    useSessionStore.getState().setClipFade(clip.id, 'in', { lengthSample: 4_410 });
    render(<PropertiesPanel />);
    const input = screen.getByLabelText('Fade in length') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(storeClip(clip.id).fadeInSample).toBe(4_410); // unchanged
    expect(screen.getByLabelText<HTMLInputElement>('Fade in length').value).toBe('0:00.100');
  });

  it('garbage reverts to the current value on blur', () => {
    const clip = seedSelected();
    useSessionStore.getState().setClipFade(clip.id, 'in', { lengthSample: 4_410 });
    render(<PropertiesPanel />);
    const input = screen.getByLabelText('Fade in length') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(storeClip(clip.id).fadeInSample).toBe(4_410);
    expect(screen.getByLabelText<HTMLInputElement>('Fade in length').value).toBe('0:00.100');
  });

  it('typing 0 clears the fade (stored as "no fade")', () => {
    const clip = seedSelected();
    useSessionStore.getState().setClipFade(clip.id, 'out', { lengthSample: 4_410 });
    render(<PropertiesPanel />);
    const input = screen.getByLabelText('Fade out length') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    expect(storeClip(clip.id).fadeOutSample).toBeUndefined();
  });
});

describe('curve pickers — ruling-2 labels, written through setClipFade', () => {
  it('offers the behaviour names — including Ducked, never the formula name Exponential', () => {
    const clip = seedClip(addDoc(), { startSample: 0, lengthSample: RATE });
    useSessionStore.getState().setSelectedClip(clip.id);
    render(<PropertiesPanel />);

    const select = screen.getByLabelText('Fade in curve') as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(['Equal power', 'Equal gain', 'Smooth', 'Ducked']);
    expect(labels).not.toContain('Exponential');
    expect(select.value).toBe('equal-power'); // the documented default
  });

  it('changing the curve writes the edge curve, without touching lengths', () => {
    const clip = seedClip(addDoc(), { startSample: 0, lengthSample: RATE });
    useSessionStore.getState().setSelectedClip(clip.id);
    render(<PropertiesPanel />);

    fireEvent.change(screen.getByLabelText('Fade out curve'), { target: { value: 'smooth' } });
    expect(storeClip(clip.id).fadeOutCurve).toBe('smooth');
    expect(storeClip(clip.id).fadeOutSample).toBeUndefined();
  });
});

describe('crossfade rows — Arm, Release, and the readout', () => {
  /** A [0,44 100) and B [22 050,66 150) on track 0: overlap width 22 050. */
  function seedPair(): { a: Clip; b: Clip } {
    const doc = addDoc();
    const a = seedClip(doc, { startSample: 0, lengthSample: RATE });
    const b = seedClip(doc, { startSample: 22_050, lengthSample: RATE });
    return { a, b };
  }
  function armPair(a: Clip, b: Clip): void {
    useSessionStore.getState().setClipFade(a.id, 'out', { lengthSample: 22_050 });
    useSessionStore.getState().setClipFade(b.id, 'in', { lengthSample: 22_050 });
  }

  it('an armed edge shows the width READOUT instead of a length input, plus Release', () => {
    const { a, b } = seedPair();
    armPair(a, b);
    useSessionStore.getState().setSelectedClip(b.id);
    render(<PropertiesPanel />);

    expect(screen.queryByLabelText('Fade in length')).toBeNull();
    expect(screen.getByTestId('fade-in-cross-readout').textContent).toBe(
      formatTime(22_050, RATE)
    );
    expect(screen.getByTestId('crossfade-release-in')).toBeInTheDocument();
    // The away edge stays an ordinary input.
    expect(screen.getByLabelText('Fade out length')).toBeInTheDocument();
  });

  it('Release clears BOTH facing fades — nothing lingers as a surprise solo fade', () => {
    const { a, b } = seedPair();
    armPair(a, b);
    useSessionStore.getState().setSelectedClip(b.id);
    render(<PropertiesPanel />);

    fireEvent.click(screen.getByTestId('crossfade-release-in'));

    expect(storeClip(a.id).fadeOutSample).toBeUndefined();
    expect(storeClip(b.id).fadeInSample).toBeUndefined();
    // The readout gives way to the input again.
    expect(screen.queryByTestId('fade-in-cross-readout')).toBeNull();
    expect(screen.getByLabelText('Fade in length')).toBeInTheDocument();
  });

  it('Arm writes both facing fades to the exact width — the raw addClip pair becomes a live crossfade (X5 finding 1)', () => {
    const { a, b } = seedPair(); // raw: addClip never writes fades
    useSessionStore.getState().setSelectedClip(b.id);
    render(<PropertiesPanel />);

    const arm = screen.getByTestId('crossfade-arm-in') as HTMLButtonElement;
    expect(arm.disabled).toBe(false);
    fireEvent.click(arm);

    expect(storeClip(a.id).fadeOutSample).toBe(22_050);
    expect(storeClip(b.id).fadeInSample).toBe(22_050);
    // The renderer agrees — this is a crossfade, not two plausible numbers.
    const clips = useSessionStore.getState().session.tracks[0].clips;
    expect(resolveClipFadeSpecs(clips).get(b.id)?.crossIn?.lengthSample).toBe(22_050);
    // And the row flips to the armed readout.
    expect(screen.getByTestId('fade-in-cross-readout')).toBeInTheDocument();
  });

  it('a CAPABLE pair is never simultaneously called a raw sum (the pairIn gate)', () => {
    const { b } = seedPair(); // raw but crossfade-capable on B's in edge
    useSessionStore.getState().setSelectedClip(b.id);
    render(<PropertiesPanel />);

    expect(screen.getByTestId('crossfade-arm-in')).toBeInTheDocument();
    expect(screen.queryByText(/raw sum/i)).toBeNull();
  });

  it('the OUTGOING member gets Arm on its OUT edge — and no raw-sum row beside it (the pairOut gate)', () => {
    const { a, b } = seedPair(); // raw: A is the outgoing side of the capable pair
    useSessionStore.getState().setSelectedClip(a.id);
    render(<PropertiesPanel />);

    const arm = screen.getByTestId('crossfade-arm-out') as HTMLButtonElement;
    expect(arm.disabled).toBe(false);
    expect(screen.queryByText(/raw sum/i)).toBeNull();
    fireEvent.click(arm);

    expect(storeClip(a.id).fadeOutSample).toBe(22_050);
    expect(storeClip(b.id).fadeInSample).toBe(22_050);
    // The row flips to the armed readout on THIS member's out edge.
    expect(screen.getByTestId('fade-out-cross-readout')).toBeInTheDocument();
  });

  it('the OUTGOING member shows the out-edge readout + Release, and Release clears both sides', () => {
    const { a, b } = seedPair();
    armPair(a, b);
    useSessionStore.getState().setSelectedClip(a.id);
    render(<PropertiesPanel />);

    expect(screen.queryByLabelText('Fade out length')).toBeNull();
    expect(screen.getByTestId('fade-out-cross-readout').textContent).toBe(
      formatTime(22_050, RATE)
    );
    // The away (in) edge of this member stays an ordinary input.
    expect(screen.getByLabelText('Fade in length')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('crossfade-release-out'));

    expect(storeClip(a.id).fadeOutSample).toBeUndefined();
    expect(storeClip(b.id).fadeInSample).toBeUndefined();
    expect(screen.queryByTestId('fade-out-cross-readout')).toBeNull();
    expect(screen.getByLabelText('Fade out length')).toBeInTheDocument();
  });

  it('Arm is DISABLED when the INCOMING member carries a blocking away fade (the b-side veto)', () => {
    const { b } = seedPair();
    // B's away fade-out one sample past the boundary: b.length − b.fadeOut
    // = 22 049 < width 22 050 — a full-width arm cannot be granted on B.
    useSessionStore.getState().setClipFade(b.id, 'out', { lengthSample: RATE - 22_050 + 1 });
    useSessionStore.getState().setSelectedClip(b.id);
    render(<PropertiesPanel />);

    expect((screen.getByTestId('crossfade-arm-in') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Arm stays ENABLED with the INCOMING away fade at exactly len − width, and arming preserves it', () => {
    const { a, b } = seedPair();
    useSessionStore.getState().setClipFade(b.id, 'out', { lengthSample: RATE - 22_050 });
    useSessionStore.getState().setSelectedClip(b.id);
    render(<PropertiesPanel />);

    const arm = screen.getByTestId('crossfade-arm-in') as HTMLButtonElement;
    expect(arm.disabled).toBe(false);
    fireEvent.click(arm);

    expect(storeClip(a.id).fadeOutSample).toBe(22_050);
    expect(storeClip(b.id).fadeInSample).toBe(22_050);
    expect(storeClip(b.id).fadeOutSample).toBe(RATE - 22_050); // away fade untouched — a legal meet on B
  });

  it('abutting clips are NOT called a raw sum (the > 0 boundary)', () => {
    const doc = addDoc();
    const a = seedClip(doc, { startSample: 0, lengthSample: RATE });
    seedClip(doc, { startSample: RATE, lengthSample: RATE }); // exact abut
    useSessionStore.getState().setSelectedClip(a.id);
    render(<PropertiesPanel />);

    expect(screen.queryByText(/raw sum/i)).toBeNull();
    expect(screen.queryByTestId('crossfade-arm-in')).toBeNull();
    expect(screen.queryByTestId('crossfade-arm-out')).toBeNull();
  });

  it('Arm stays ENABLED with an away fade at exactly len − width (the boundary), and arming preserves it', () => {
    const { a, b } = seedPair();
    // A's away fade (fade-in) at exactly lengthSample − width: a legal meet.
    useSessionStore.getState().setClipFade(a.id, 'in', { lengthSample: RATE - 22_050 });
    useSessionStore.getState().setSelectedClip(b.id);
    render(<PropertiesPanel />);

    const arm = screen.getByTestId('crossfade-arm-in') as HTMLButtonElement;
    expect(arm.disabled).toBe(false);
    fireEvent.click(arm);

    expect(storeClip(a.id).fadeOutSample).toBe(22_050);
    expect(storeClip(a.id).fadeInSample).toBe(RATE - 22_050); // away fade untouched
    expect(storeClip(b.id).fadeInSample).toBe(22_050);
  });

  it('Arm is DISABLED one sample past the boundary — a partial arm would silently not crossfade', () => {
    const { a, b } = seedPair();
    useSessionStore.getState().setClipFade(a.id, 'in', { lengthSample: RATE - 22_050 + 1 });
    useSessionStore.getState().setSelectedClip(b.id);
    render(<PropertiesPanel />);

    expect((screen.getByTestId('crossfade-arm-in') as HTMLButtonElement).disabled).toBe(true);
  });

  it('an overlap no edge can crossfade is called out as a raw sum', () => {
    const doc = addDoc();
    const a = seedClip(doc, { startSample: 0, lengthSample: RATE });
    seedClip(doc, { startSample: 0, lengthSample: RATE }); // equal starts: rule 1
    useSessionStore.getState().setSelectedClip(a.id);
    render(<PropertiesPanel />);

    expect(screen.getByText(/raw sum/i)).toBeInTheDocument();
    expect(screen.queryByTestId('crossfade-arm-in')).toBeNull();
    expect(screen.queryByTestId('crossfade-arm-out')).toBeNull();
  });
});
