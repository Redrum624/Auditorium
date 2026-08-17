import { act, fireEvent, render, screen, within } from '@testing-library/react';
import EffectsPanel from './EffectsPanel';
import { registerAllEffects } from '../../effects/registerAll';
import {
  getMenuSections,
  isCommandEnabled,
  registerCommands,
  registerEffectCommands,
  runCommand,
} from '../../services/menuActions';
import type { MenuCommand } from '../../services/menuActions';
import { openEffectDialog } from '../../services/dialogBus';
import { getPipelineGroups } from '../../services/pipelineTools';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';

// The REAL registry — every predicate under test has to be the menu's own —
// with only the runner spied: a click has to reach `runCommand(id)`, and
// actually running a stem separation for a click assertion would test the
// dialog bus, not this row. Same shape as EditToolbar.test.tsx.
jest.mock('../../services/menuActions', () => {
  const actual = jest.requireActual('../../services/menuActions');
  return { ...actual, runCommand: jest.fn(async () => {}) };
});
const mockRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;

// The effect rows above the tools open their dialog through the bus; spy on
// that one opener so the single-click / double-click difference is observable.
jest.mock('../../services/dialogBus', () => {
  const actual = jest.requireActual('../../services/dialogBus');
  return { ...actual, openEffectDialog: jest.fn() };
});
const mockOpenEffectDialog = openEffectDialog as jest.MockedFunction<typeof openEffectDialog>;

// The panel lists `getVisibleEffects()`, which is empty until the effects
// register — App.tsx does both of these at startup, and MenuBar.test.tsx uses
// the same pair.
registerAllEffects();
registerEffectCommands();

/** The spec's table, written out here rather than imported from the component:
 * a test that reads its expectation out of the thing under test cannot fail. */
const EXPECTED_SECTIONS: [string, string[]][] = [
  ['Tempo & Timing', ['tempo.detect', 'tempo.match', 'timing.align', 'edit.remix']],
  ['Voice', ['edit.voiceChanger', 'effects.vocalChain', 'effects.coverChain', 'lyrics.align']],
  ['Analysis', ['edit.transcribe', 'edit.separateStems']],
  // F11-8 filled this fourth section from the Pipeline menu's Mix group; T8
  // moved `spatial.position` to the Effects MENU, so the card now draws this
  // section from that menu's own tool tail (`effectsMenuTools`). What the
  // card SHOWS is unchanged — same four sections, same rows, same order —
  // which is exactly what this table is here to pin.
  ['Mix', ['spatial.position']],
];
const ALL_TOOL_IDS = EXPECTED_SECTIONS.flatMap(([, ids]) => ids);

/** Every tool whose command is gated on the active document. The positioner is
 * not one: it addresses the multitrack session's tracks, which exist with no
 * document open, so the document laws below are stated over these. */
const DOC_GATED_TOOL_IDS = ALL_TOOL_IDS.filter((id) => id !== 'spatial.position');

/** Length-gated tools: `enabled` is an active document AND `docLength > 0`. */
const NEEDS_AUDIO = ['edit.remix', 'edit.voiceChanger', 'lyrics.align', 'edit.transcribe', 'edit.separateStems'];

function addDoc(sampleCount = 44100): AudioDocument {
  const doc = createDocument({
    name: 'a.wav',
    sampleRate: 44100,
    channels: [new Float32Array(sampleCount)],
  });
  act(() => useAppStore.getState().addDocument(doc));
  return doc;
}

/** The registered command behind an id, taken from the menu the user sees. */
function commandFor(id: string): MenuCommand {
  for (const section of getMenuSections()) {
    for (const item of section.items) {
      if (item !== 'separator' && item.id === id) return item;
    }
  }
  throw new Error(`no registered command for ${id}`);
}

function sections(): HTMLElement[] {
  return screen.getAllByTestId('effects-tool-section');
}

function toolRow(id: string): HTMLElement {
  const row = screen
    .getAllByTestId('effects-tool-item')
    .find((r) => r.getAttribute('data-command-id') === id);
  if (!row) throw new Error(`no tool row for ${id}`);
  return row;
}

function toolButton(id: string): HTMLButtonElement {
  return within(toolRow(id)).getByRole('button') as HTMLButtonElement;
}

/** Every row's greying is that command's OWN predicate — no cloned rule can
 * drift from the menu without this failing. */
function expectRowsMirrorTheRegistry(): void {
  for (const id of ALL_TOOL_IDS) {
    expect([id, toolButton(id).disabled]).toEqual([id, !isCommandEnabled(id)]);
  }
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  mockRunCommand.mockClear();
  mockOpenEffectDialog.mockClear();
});

describe('EffectsPanel — the effect list stays first and untouched', () => {
  it('still lists the registered effects, above every tool section', () => {
    render(<EffectsPanel />);
    const list = screen.getByTestId('effects-list');
    expect(screen.getAllByTestId('effects-item').length).toBeGreaterThan(0);

    for (const section of sections()) {
      // Node.DOCUMENT_POSITION_FOLLOWING: the section comes after the list.
      expect(list.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('keeps the effect rows on double-click: one click opens nothing', () => {
    addDoc();
    render(<EffectsPanel />);
    const first = within(screen.getAllByTestId('effects-item')[0]).getByRole('button');

    fireEvent.click(first);
    expect(mockOpenEffectDialog).not.toHaveBeenCalled();

    fireEvent.doubleClick(first);
    expect(mockOpenEffectDialog).toHaveBeenCalledTimes(1);
  });
});

describe('EffectsPanel — the tool sections', () => {
  it('ships exactly four sections, in order, each holding its entries in order', () => {
    render(<EffectsPanel />);
    expect(sections().map((s) => s.getAttribute('data-section'))).toEqual(
      EXPECTED_SECTIONS.map(([title]) => title)
    );

    sections().forEach((section, i) => {
      const ids = within(section)
        .getAllByTestId('effects-tool-item')
        .map((row) => row.getAttribute('data-command-id'));
      expect(ids).toEqual(EXPECTED_SECTIONS[i][1]);
    });
  });

  // T8: the Mix row's protective pin. The user moved Spatial OUT of the
  // Pipeline menu, so `getPipelineGroups()` — the source the other three
  // sections render from — no longer carries it. If this card still drew Mix
  // from the Pipeline groups, the row would have silently vanished from the
  // one surface the user moved it TO; this is the assertion that catches that.
  it('keeps the Mix row although spatial.position left the Pipeline menu (T8)', () => {
    expect(getPipelineGroups().flatMap((g) => g.commands.map((c) => c.id))).not.toContain(
      'spatial.position'
    );
    render(<EffectsPanel />);
    expect(toolRow('spatial.position')).toBeInTheDocument();
    expect(toolRow('spatial.position').closest('[data-section]')!.getAttribute('data-section')).toBe(
      'Mix'
    );
  });

  it('labels every entry with the menu registry own label, verbatim', () => {
    render(<EffectsPanel />);
    for (const id of ALL_TOOL_IDS) {
      expect([id, toolButton(id).textContent]).toEqual([id, commandFor(id).label]);
    }
    // The registry label really is being carried, not merely matched by two
    // identically-hardcoded strings. T8 removed the dots from every Pipeline
    // label at the user's direction, so the plain form is the one pinned.
    expect(toolButton('tempo.match').textContent).toBe('Match Tempo');
    expect(toolButton('tempo.detect').textContent).toBe('Detect Tempo');
  });

  it('follows the registry when a label changes, so the label is read not copied', () => {
    const original = commandFor('tempo.detect');
    try {
      registerCommands([{ ...original, label: 'Detect Tempo (renamed)' }]);
      render(<EffectsPanel />);
      expect(toolButton('tempo.detect').textContent).toBe('Detect Tempo (renamed)');
    } finally {
      registerCommands([original]);
    }
  });
});

describe('EffectsPanel — greying is the command own predicate', () => {
  it('greys every document-gated tool with no document open', () => {
    render(<EffectsPanel />);
    for (const id of DOC_GATED_TOOL_IDS) expect(toolButton(id)).toBeDisabled();
    expectRowsMirrorTheRegistry();
  });

  // F11-8: the Mix row is the exception, and it has to be. Its command is the
  // only door the Spatial positioner has left now that the strip carries no
  // icon for it, and the positioner acts on the multitrack session — greying
  // it with no document open would replace a panel that explains an empty
  // session with a grey row that explains nothing.
  it('leaves the Mix row live with no document open, because the positioner is session-scoped', () => {
    render(<EffectsPanel />);
    expect(toolButton('spatial.position')).toBeEnabled();
    expectRowsMirrorTheRegistry();
  });

  it('lights every tool once a document with audio is active', () => {
    addDoc();
    render(<EffectsPanel />);
    for (const id of ALL_TOOL_IDS) expect(toolButton(id)).toBeEnabled();
    expectRowsMirrorTheRegistry();
  });

  it('keeps the length-gated tools grey on an EMPTY document while Detect Tempo lights', () => {
    addDoc(0);
    render(<EffectsPanel />);
    // `tempo.detect` / `tempo.match` / `timing.align` / the chains ask only for
    // a document; Auto-Remix, Voice Changer, Align Lyrics, Transcribe and
    // Separate into Stems ask for one with audio in it.
    expect(toolButton('tempo.detect')).toBeEnabled();
    expect(toolButton('effects.vocalChain')).toBeEnabled();
    for (const id of NEEDS_AUDIO) expect([id, toolButton(id).disabled]).toEqual([id, true]);
    expectRowsMirrorTheRegistry();
  });

  it('re-greys the tools live when the last document closes', () => {
    const doc = addDoc();
    render(<EffectsPanel />);
    expect(toolButton('edit.remix')).toBeEnabled();

    act(() => useAppStore.getState().closeDocument(doc.id));
    expect(toolButton('edit.remix')).toBeDisabled();
    expectRowsMirrorTheRegistry();
  });
});

describe('EffectsPanel — a tool row is a single click on the menu command', () => {
  it('runs each id through runCommand, one click, no double-click needed', () => {
    addDoc();
    render(<EffectsPanel />);
    for (const id of ALL_TOOL_IDS) {
      mockRunCommand.mockClear();
      fireEvent.click(toolButton(id));
      expect([id, mockRunCommand.mock.calls]).toEqual([id, [[id]]]);
    }
  });

  it('fires nothing from a greyed row', () => {
    render(<EffectsPanel />);
    fireEvent.click(toolButton('edit.separateStems'));
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('says single click in the tooltip, where the effect rows say double-click', () => {
    addDoc();
    render(<EffectsPanel />);
    expect(toolButton('tempo.detect').title).toMatch(/^Click to run /);
    const effect = within(screen.getAllByTestId('effects-item')[0]).getByRole('button');
    expect(effect.title).toMatch(/^Double-click/);
  });
});

describe('EffectsPanel — the sections cost the card no size', () => {
  /** App.tsx wraps the panel in exactly this scrolling box. */
  function renderInCard() {
    return render(
      <div className="min-h-0 overflow-auto" data-testid="scroll-host">
        <EffectsPanel />
      </div>
    );
  }

  it('puts every tool section inside the card scroll box, with nothing portalled out', () => {
    addDoc();
    const { container } = renderInCard();
    const host = screen.getByTestId('scroll-host');
    for (const section of sections()) expect(host.contains(section)).toBe(true);
    // Nothing rendered beside the host: no portal, no floating overlay that
    // the card's scroll could not contain.
    expect(container.childElementCount).toBe(1);
    expect(document.body.childElementCount).toBe(1);
  });

  it('escapes the flow nowhere and declares no size of its own', () => {
    addDoc();
    renderInCard();
    const panel = screen.getByTestId('effects-panel');
    expect(panel.getAttribute('style')).toBeNull();
    for (const token of panel.className.split(/\s+/)) {
      expect(token).not.toMatch(/^(min-)?[wh]-/);
    }
    for (const el of Array.from(panel.querySelectorAll<HTMLElement>('*'))) {
      expect(el.className.toString()).not.toMatch(/\b(fixed|absolute|sticky)\b/);
      expect(el.style.position).toBe('');
    }
  });

  it('truncates a tool row exactly as an effect row does, so none can widen the card', () => {
    addDoc();
    renderInCard();
    const effect = within(screen.getAllByTestId('effects-item')[0]).getByRole('button');
    for (const id of ALL_TOOL_IDS) {
      const cls = toolButton(id).className;
      expect([id, cls.includes('truncate')]).toEqual([id, true]);
      expect([id, cls.includes('w-[calc(100%-0.5rem)]')]).toEqual([id, true]);
    }
    expect(effect.className).toContain('truncate');
  });
});
