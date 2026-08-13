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

describe('PipelineToolHost — which Pipeline rows it hosts', () => {
  /**
   * U2-3: hosting is a property of the COMMAND, and the property is "the host
   * mounts something for it". Two of the Pipeline menu's eleven rows open no
   * tool UI at all — `tempo.detect` runs an analysis and reports through its
   * own channel, `spatial.position` puts an existing PANEL in the ordinary
   * module card — so "every Pipeline row" would have been wrong.
   */
  it('claims nine of the Pipeline menu’s eleven rows, and only rows that open a UI', () => {
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
      <PipelineToolHost commandId="tempo.detect" onClose={() => {}} onDismissableChange={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
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
      const m = source.match(/width=\{(\d+)\}/);
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
      <PipelineToolHost commandId="tempo.match" onClose={() => {}} onDismissableChange={() => {}} />
    );
    const card = screen.getByTestId('tool-host');
    expect(card.style.width).toBe(`${TOOL_HOST_WIDTH}px`);
    // The strip above and the TempoCard beside keep the column's own width.
    expect(card.style.marginLeft).toBe(`${MODULE_COLUMN_WIDTH - TOOL_HOST_WIDTH}px`);
  });

  it('still leaves the waveform the larger surface at the app’s minimum window width', () => {
    // electron/main.cjs: minWidth 1100. The host costs 14 + width + 14.
    const stage = 1100 - (14 + TOOL_HOST_WIDTH + 14);
    expect(stage).toBeGreaterThan(400);
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
      <PipelineToolHost commandId="tempo.match" onClose={() => {}} onDismissableChange={() => {}} />
    );
    expect(screen.getByTestId('tool-host')).toHaveAttribute('data-tool-id', 'tempo.match');
    expect(screen.getByTestId('hosted-tool')).toBeInTheDocument();
    // The whole user-visible change: the stage is not covered.
    expect(screen.queryByTestId('dialog-overlay')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('region', { name: /tempo/i })).toBeInTheDocument();
  });
});
