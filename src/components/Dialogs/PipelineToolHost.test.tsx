import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import PipelineToolHost, {
  TOOL_HOST_WIDTH,
  hostedToolIds,
  isPipelineTool,
} from './PipelineToolHost';
import { MODULE_COLUMN_WIDTH } from '../Layout/ModuleStrip';
import { createDocument } from '../../audio/AudioDocument';
import { getPipelineGroups } from '../../services/pipelineTools';
import { makeInitialState, useAppStore } from '../../stores/appStore';

beforeEach(() => useAppStore.setState(makeInitialState()));

const HOST_SRC = readFileSync(join(__dirname, 'PipelineToolHost.tsx'), 'utf8');

/** The dialog component file each hosted id mounts, read out of the host's own
 * source: the map entries give id → component name, the imports give component
 * name → file. Derived rather than restated so the width assertion below cannot
 * quietly measure a file the host no longer mounts. */
function hostedToolSources(): { id: string; file: string; source: string }[] {
  const imports = new Map<string, string>();
  for (const m of HOST_SRC.matchAll(/import\s+(\w+)\s+from\s+'\.\/(\w+)';/g)) {
    imports.set(m[1], m[2]);
  }
  return hostedToolIds().map((id) => {
    const entry = HOST_SRC.match(new RegExp(`'${id.replace('.', '\\.')}':\\s*(\\w+),`));
    if (!entry) throw new Error(`no component mapped for ${id}`);
    const file = imports.get(entry[1]);
    if (!file) throw new Error(`no import for ${entry[1]}`);
    return { id, file, source: readFileSync(join(__dirname, `${file}.tsx`), 'utf8') };
  });
}

/**
 * Source with block and line comments removed.
 *
 * Needed because three of the nine (`AlignLyricsDialog`, `TranscribeDialog`,
 * `SeparateDialog`) also QUOTE `dismissable={!busy}` in their header comment to
 * explain their lifetime. A first-match search would find the prose, so
 * deleting the real JSX attribute from one of those three would leave the gate
 * below green — which is the exact failure this gate exists to stop.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('PipelineToolHost — which Pipeline rows it hosts', () => {
  /**
   * U2-3: hosting is a property of the COMMAND, and the property is "the host
   * mounts something for it". One of the Pipeline menu's ten rows opens no
   * tool UI at all — `tempo.detect` runs an analysis and reports through its
   * own channel — so "every Pipeline row" would have been wrong. (T8 moved
   * `spatial.position`, the other unhosted command, to the Effects menu; it
   * still puts an existing PANEL in the ordinary module card, and it still
   * must not be hosted.)
   */
  it('claims nine of the Pipeline menu’s ten rows, and only rows that open a UI', () => {
    const ids = getPipelineGroups().flatMap((g) => g.commands.map((c) => c.id));
    expect(ids.filter(isPipelineTool)).toEqual([
      'tempo.match',
      'timing.align',
      'edit.remix',
      'edit.voiceChanger',
      'effects.vocalChain',
      'effects.coverChain',
      'lyrics.align',
      'edit.transcribe',
      'edit.separateStems',
    ]);
    expect(isPipelineTool('tempo.detect')).toBe(false);
    expect(isPipelineTool('spatial.position')).toBe(false);
  });

  it('hosts no id the Pipeline menu does not carry', () => {
    const menuIds = new Set(getPipelineGroups().flatMap((g) => g.commands.map((c) => c.id)));
    for (const id of hostedToolIds()) expect([id, menuIds.has(id)]).toEqual([id, true]);
    expect(isPipelineTool('file.export')).toBe(false);
    expect(isPipelineTool('effect.reverb')).toBe(false);
  });

  it('renders nothing for an id it does not know', () => {
    const { container } = render(
      <PipelineToolHost commandId="tempo.detect" onClose={() => {}} onModuleLockChange={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

/**
 * The gate on the block mechanism itself.
 *
 * `dismissable={!busy}` in these nine files IS the mid-run block. The host reads
 * nothing else: that one expression is what greys the module strip, refuses the
 * ✕ and suspends the global shortcuts while a pass runs. Delete it from any one
 * file and `DialogShell`'s default (`dismissable = true`) takes over — that
 * tool reports "idle" for the whole of its pass, and one click on the strip
 * unmounts it and destroys the run, with every other test in this repo still
 * green. It is the most load-bearing token in the feature and it had no gate,
 * while the far less consequential width constant had one; this is the sibling.
 *
 * What it asserts, and why not the literal string. Requiring exactly
 * `dismissable={!busy}` would catch the three failures that matter — deletion,
 * hardcoding (`dismissable` / `{true}`), and inversion (`{busy}`) — but would
 * also fail on a harmless rename of the local flag, and `CoverChainDialog` is
 * being rewritten on another branch as this lands. So the assertion is the
 * SHAPE plus the wiring: the prop appears exactly once outside comments, its
 * value is the negation of a bare identifier, and that identifier is really
 * declared in the file (a `useState` binding, or a `const` derived from
 * several — both forms are in use across the nine). A literal, an inversion or
 * a deletion all fail; a rename passes and stays honest.
 */
describe('PipelineToolHost — every hosted tool publishes its busy state', () => {
  it('hands DialogShell a `dismissable` wired to a real flag, in all nine', () => {
    const findings = hostedToolSources().map(({ id, file, source }) => {
      const code = stripComments(source);
      const all = [...code.matchAll(/dismissable(?:=\{([^}]*)\})?/g)];
      return { id, file, code, occurrences: all.length, value: all[0]?.[1]?.trim() };
    });
    expect(findings).toHaveLength(9);

    for (const { id, file, code, occurrences, value } of findings) {
      // Exactly one, so a second copy cannot mask a broken first.
      expect([id, occurrences]).toEqual([id, 1]);
      // Present with a value: a bare `dismissable` (i.e. `={true}`) is the
      // hardcoding failure, and captures as undefined here.
      expect([id, typeof value]).toEqual([id, 'string']);
      // The negation of a bare identifier — `{busy}` (inverted) and `{true}`
      // (hardcoded) both fail this.
      const negated = /^!(\w+)$/.exec(value as string);
      expect([id, value, negated !== null]).toEqual([id, value, true]);
      // …and that identifier is wired to REACT STATE, not merely declared. An
      // undeclared name is already a compile error, so the case worth gating is
      // `const busy = false` — declared, typechecks, and silently disables the
      // block. Both real forms are accepted: a `useState` binding directly
      // (Tempo, AlignTiming, VocalChain, CoverChain), or a `const` derived from
      // one or more of them (Remix, VoiceChanger, AlignLyrics, Transcribe,
      // Separate).
      const flag = (negated as RegExpExecArray)[1];
      const stateBindings = new Set(
        [...code.matchAll(/const\s*\[\s*(\w+)\s*(?:,[^\]]*)?\]\s*=\s*useState/g)].map((m) => m[1])
      );
      const derived = new RegExp(`const\\s+${flag}\\s*=([^;]*);`).exec(code);
      const wired =
        stateBindings.has(flag) ||
        (derived !== null &&
          [...derived[1].matchAll(/\w+/g)].some((m) => stateBindings.has(m[0])));
      expect([id, file, flag, wired]).toEqual([id, file, flag, true]);
    }
  });

  // The comment-stripping is the part most likely to rot silently, so it is
  // pinned against the real files that need it rather than a synthetic string.
  it('reads the JSX and not the three files that quote the token in prose', () => {
    const quoted = hostedToolSources().filter(({ source }) =>
      /\*.*dismissable=\{!busy\}/.test(source)
    );
    expect(quoted.map((q) => q.file).sort()).toEqual([
      'AlignLyricsDialog',
      'SeparateDialog',
      'TranscribeDialog',
    ]);
    for (const { file, source } of quoted) {
      expect([file, [...stripComments(source).matchAll(/dismissable/g)].length]).toEqual([file, 1]);
    }
  });
});

describe('PipelineToolHost — the card’s width is measured, not chosen', () => {
  /**
   * U2-3's width decision, pinned to the thing it was derived from: the card is
   * as wide as the WIDEST stage any tool it hosts asks `DialogShell` for. Any
   * narrower and that tool's content reflows the moment it is hosted — the
   * cover chain's stage table is the one that breaks first — so the number is
   * not a taste call and must not drift into one. If a hosted dialog is
   * widened, this fails and the host follows it.
   */
  it('is exactly the widest width any hosted dialog asks DialogShell for', () => {
    const widths = hostedToolSources().map(({ id, file, source }) => {
      // Comments stripped FIRST, for the reason the `dismissable` gate strips
      // them (U2's C1): this is a first-match technique, so a `width={…}`
      // written in prose above the attribute is read INSTEAD of the attribute.
      // Proven by a decoy — a commented `width={9999}` over an untouched
      // `width={440}` made this test demand 9999. M4's width ruling put a
      // paragraph discussing two widths directly above one of these nine
      // attributes, which is exactly the shape that trips it.
      const m = stripComments(source).match(/width=\{(\d+)\}/);
      if (!m) throw new Error(`${file}.tsx passes DialogShell no explicit width (${id})`);
      return { id, width: Number(m[1]) };
    });
    expect(widths.length).toBe(9);
    expect(TOOL_HOST_WIDTH).toBe(Math.max(...widths.map((w) => w.width)));
    // Not vacuous: the nine really do disagree, so "the max" is a choice
    // between real alternatives rather than nine copies of one number.
    expect(new Set(widths.map((w) => w.width)).size).toBeGreaterThan(1);
  });

  it('grows LEFT out of the module column instead of widening it', () => {
    render(
      <PipelineToolHost commandId="tempo.match" onClose={() => {}} onModuleLockChange={() => {}} />
    );
    const card = screen.getByTestId('tool-host');
    expect(card.style.width).toBe(`${TOOL_HOST_WIDTH}px`);
    // The strip above and the TempoCard beside keep the column's own width.
    expect(card.style.marginLeft).toBe(`${MODULE_COLUMN_WIDTH - TOOL_HOST_WIDTH}px`);
  });

  /**
   * The geometry, stated honestly.
   *
   * The first version of this test computed `1100 - (14 + width + 14)` and
   * called the result "the waveform is still the larger surface". Both halves
   * were wrong. The lane is inset on BOTH sides — `--stage-inset-left` is 14 as
   * well — so the real width at the minimum window is 418, not 432; and 418 is
   * comfortably SMALLER than the 640 card, so the claim it asserted was false
   * even as it passed. A test whose name states something untrue is worse than
   * no test: it retires the question.
   *
   * The invariant actually intended is a floor, not a comparison: opening a
   * tool must leave a waveform you can still work in. 400 px is that floor —
   * roughly a third of the minimum window, and enough for a visible selection
   * and playhead. The card being wider than the lane at the minimum window is
   * the trade the user opts into by opening the tool, and it reverses at any
   * ordinary window size (918 px of lane at the 1600 default — the same
   * both-sides inset that made 432 into 418, missed here when the assertion
   * below was corrected).
   */
  it('leaves at least a workable lane at the app’s minimum window width', () => {
    const MIN_WINDOW = 1100; // electron/main.cjs
    const COLUMN_MARGIN = 14; // App.tsx
    const lane = MIN_WINDOW - COLUMN_MARGIN - (COLUMN_MARGIN + TOOL_HOST_WIDTH + COLUMN_MARGIN);
    expect(lane).toBe(418);
    expect(lane).toBeGreaterThanOrEqual(400);
    // Said out loud rather than implied: at the minimum window the tool is the
    // wider of the two. The comparison flips at any ordinary window size.
    expect(lane).toBeLessThan(TOOL_HOST_WIDTH);
    expect(1600 - COLUMN_MARGIN - (COLUMN_MARGIN + TOOL_HOST_WIDTH + COLUMN_MARGIN)).toBe(918);
  });

  it('mounts the tool with no backdrop and no modal role', () => {
    // Match Tempo renders nothing without an active document (TempoDialog's own
    // guard), so the state under test needs one.
    act(() =>
      useAppStore
        .getState()
        .addDocument(
          createDocument({ name: 'a.wav', sampleRate: 44100, channels: [new Float32Array(4410)] })
        )
    );
    render(
      <PipelineToolHost commandId="tempo.match" onClose={() => {}} onModuleLockChange={() => {}} />
    );
    expect(screen.getByTestId('tool-host')).toHaveAttribute('data-tool-id', 'tempo.match');
    expect(screen.getByTestId('hosted-tool')).toBeInTheDocument();
    // The whole user-visible change: the stage is not covered.
    expect(screen.queryByTestId('dialog-overlay')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('region', { name: /tempo/i })).toBeInTheDocument();
  });
});
