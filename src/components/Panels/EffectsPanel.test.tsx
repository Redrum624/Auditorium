import { act, fireEvent, render, screen, within } from '@testing-library/react';
import EffectsPanel from './EffectsPanel';
import { getVisibleEffects } from '../../effects/EffectRegistry';
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

// The effect rows above the Mix row open their card through the bus; spy on
// that one opener so the click is observable without mounting App's column.
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
  // T8 moved `spatial.position` to the Effects MENU, so the card draws this
  // section from that menu's own tool tail (`effectsMenuTools`). Item 5 of the
  // 2026-08-18 program then removed the three Pipeline groups: a Pipeline tool
  // lives in the Pipeline module only, and Mix is the one section left.
  ['Mix', ['spatial.position']],
];
const ALL_TOOL_IDS = EXPECTED_SECTIONS.flatMap(([, ids]) => ids);

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

  // Item 6 (2026-08-18): "all effects open with a single click". The row used
  // to demand a double-click (a parameter set the user was about to fill in);
  // an effect now opens as a card in the module column, one click like a tool
  // row, and the registry id is what reaches the bus.
  it('opens an effect on a SINGLE click, never on a row without a document', () => {
    addDoc();
    render(<EffectsPanel />);
    const first = within(screen.getAllByTestId('effects-item')[0]).getByRole('button');

    fireEvent.click(first);
    expect(mockOpenEffectDialog).toHaveBeenCalledTimes(1);
    expect(mockOpenEffectDialog).toHaveBeenCalledWith(getVisibleEffects()[0].id);
  });

  it('keeps every effect row disabled with no document, so a click opens nothing', () => {
    render(<EffectsPanel />);
    const first = within(screen.getAllByTestId('effects-item')[0]).getByRole('button');
    expect(first).toBeDisabled();

    fireEvent.click(first);
    expect(mockOpenEffectDialog).not.toHaveBeenCalled();
  });
});

describe('EffectsPanel — the tool sections', () => {
  it('ships exactly one section, Mix, holding spatial.position', () => {
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

  // Item 5 (2026-08-18): "if it is in Pipeline, remove it from Effects". The
  // ten Pipeline-menu commands were a deliberate second door here (F11-6),
  // kept when the Pipeline module arrived (U2); the user rules one door. The
  // ids are read off `getPipelineGroups()` — the Pipeline card's own source —
  // so a tool added to that menu can never reappear here unnoticed.
  it('lists no Pipeline-menu command — the Pipeline module is their only card', () => {
    addDoc();
    render(<EffectsPanel />);
    const pipelineIds = getPipelineGroups().flatMap((g) => g.commands.map((c) => c.id));
    expect(pipelineIds.length).toBeGreaterThan(0);
    const cardIds = screen
      .queryAllByTestId('effects-tool-item')
      .map((r) => r.getAttribute('data-command-id'));
    for (const id of pipelineIds) expect(cardIds).not.toContain(id);
    expect(sections().map((s) => s.getAttribute('data-section'))).toEqual(['Mix']);
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
    // identically-hardcoded strings.
    expect(toolButton('spatial.position').textContent).toBe(commandFor('spatial.position').label);
  });

  it('follows the registry when a label changes, so the label is read not copied', () => {
    const original = commandFor('spatial.position');
    try {
      registerCommands([{ ...original, label: 'Spatial Positioner (renamed)' }]);
      render(<EffectsPanel />);
      expect(toolButton('spatial.position').textContent).toBe('Spatial Positioner (renamed)');
    } finally {
      registerCommands([original]);
    }
  });
});

describe('EffectsPanel — greying is the command own predicate', () => {
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

  it('says single click in both tooltips — run for a tool row, open for an effect row', () => {
    addDoc();
    render(<EffectsPanel />);
    expect(toolButton('spatial.position').title).toMatch(/^Click to run /);
    const effect = within(screen.getAllByTestId('effects-item')[0]).getByRole('button');
    expect(effect.title).toMatch(/^Click to open /);
    expect(effect.title).not.toMatch(/Double-click/);
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
