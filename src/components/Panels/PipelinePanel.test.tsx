import { act, fireEvent, render, screen, within } from '@testing-library/react';
import PipelinePanel from './PipelinePanel';
import { createDocument } from '../../audio/AudioDocument';
import { isCommandEnabled, registerCommands, runCommand } from '../../services/menuActions';
import { getPipelineGroups, PIPELINE_GROUP_TITLES } from '../../services/pipelineTools';
import { makeInitialState, useAppStore } from '../../stores/appStore';

jest.mock('../../services/menuActions', () => ({
  ...jest.requireActual('../../services/menuActions'),
  runCommand: jest.fn(),
}));
const mockRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;

/**
 * U2: the Pipeline module's card. Every assertion below is derived from
 * `getPipelineGroups()` — the Pipeline MENU's own rows — rather than from a
 * restated list, because the whole point of the card is that it is a second
 * door to the same registry. A test that hardcoded the roster would pass
 * happily on the day the card stopped following the menu.
 */
function addDoc(sampleCount = 44100) {
  const doc = createDocument({
    name: 'a.wav',
    sampleRate: 44100,
    channels: [new Float32Array(sampleCount)],
  });
  act(() => useAppStore.getState().addDocument(doc));
  return doc;
}

function sections(): HTMLElement[] {
  return screen.getAllByTestId('pipeline-section');
}

function row(id: string): HTMLElement {
  const found = screen
    .getAllByTestId('pipeline-item')
    .find((r) => r.getAttribute('data-command-id') === id);
  if (!found) throw new Error(`no pipeline row for ${id}`);
  return found;
}

function button(id: string): HTMLButtonElement {
  return within(row(id)).getByRole('button') as HTMLButtonElement;
}

const ALL_IDS = () => getPipelineGroups().flatMap((g) => g.commands.map((c) => c.id));

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  mockRunCommand.mockClear();
});

describe('PipelinePanel — the card is the Pipeline menu', () => {
  it('draws the menu’s groups, in menu order, under the written names', () => {
    render(<PipelinePanel />);
    expect(sections().map((s) => s.getAttribute('data-section'))).toEqual([
      ...PIPELINE_GROUP_TITLES,
    ]);
  });

  it('draws each group’s rows, in menu order, and nothing else', () => {
    render(<PipelinePanel />);
    const groups = getPipelineGroups();
    sections().forEach((section, i) => {
      const ids = within(section)
        .getAllByTestId('pipeline-item')
        .map((r) => r.getAttribute('data-command-id'));
      expect(ids).toEqual(groups[i].commands.map((c) => c.id));
    });
    expect(screen.getAllByTestId('pipeline-item')).toHaveLength(ALL_IDS().length);
  });

  // D7: the card is where the user meets the Voice group, and the ruling is
  // about what they see FIRST in it. Derived from the live groups like
  // everything else here — the claim is the position, not the roster.
  it('heads the Voice section with Separate Voice and draws D7’s six rows in order', () => {
    render(<PipelinePanel />);
    const voiceSection = sections().find((s) => s.getAttribute('data-section') === 'Voice')!;
    const ids = within(voiceSection)
      .getAllByTestId('pipeline-item')
      .map((r) => r.getAttribute('data-command-id'));
    expect(ids[0]).toBe('voice.separate');
    expect(button('voice.separate').textContent).toBe('Separate Voice');
    // D6/D7: the whole group, in order. The card is where the user meets these
    // rows, so the adjacency the ruling is about — Vocal → Cover → Podcast —
    // has to be true HERE, not only in the menu the card derives from.
    expect(ids).toEqual([
      'voice.separate',
      'edit.voiceChanger',
      'effects.vocalChain',
      'effects.coverChain',
      'effects.podcastChain',
      'lyrics.align',
    ]);
    expect(button('effects.podcastChain').textContent).toBe('Podcast Chain');
  });

  it('reads every label off the registry rather than restating it', () => {
    render(<PipelinePanel />);
    for (const group of getPipelineGroups()) {
      for (const cmd of group.commands) {
        expect([cmd.id, button(cmd.id).textContent]).toEqual([cmd.id, cmd.label]);
      }
    }
  });

  it('follows the registry when a label changes', () => {
    const original = getPipelineGroups()[0].commands[0];
    const live = { id: original.id, label: original.label, enabled: () => true, run: () => {} };
    try {
      registerCommands([{ ...live, label: 'Renamed Tool…' }]);
      render(<PipelinePanel />);
      expect(button(original.id).textContent).toBe('Renamed Tool…');
    } finally {
      registerCommands([{ ...live }]);
    }
  });
});

describe('PipelinePanel — greying is the command’s own predicate', () => {
  it('mirrors isCommandEnabled for every row, with no document open', () => {
    render(<PipelinePanel />);
    for (const id of ALL_IDS()) {
      expect([id, button(id).disabled]).toEqual([id, !isCommandEnabled(id)]);
    }
  });

  it('mirrors it again once a document with audio is active', () => {
    addDoc();
    render(<PipelinePanel />);
    for (const id of ALL_IDS()) {
      expect([id, button(id).disabled]).toEqual([id, !isCommandEnabled(id)]);
    }
  });

  it('mirrors it on an EMPTY document, where the length-gated tools stay grey', () => {
    addDoc(0);
    render(<PipelinePanel />);
    for (const id of ALL_IDS()) {
      expect([id, button(id).disabled]).toEqual([id, !isCommandEnabled(id)]);
    }
    // The distinction is real, not vacuous: at least one row differs from
    // another in this state.
    expect(button('tempo.detect').disabled).toBe(false);
    expect(button('edit.remix').disabled).toBe(true);
  });

  it('gives a greyed row an honest reason rather than a blank tooltip', () => {
    render(<PipelinePanel />);
    expect(button('edit.remix').title).toBe('Open a file first');
    addDoc(0);
    render(<PipelinePanel />);
    expect(button('edit.remix').title).toBe(
      'Auto-Remix — not available for this file right now'
    );
  });
});

describe('PipelinePanel — a row is one click on the menu command', () => {
  it('runs each id through runCommand', () => {
    addDoc();
    render(<PipelinePanel />);
    for (const id of ALL_IDS()) {
      if (button(id).disabled) continue;
      mockRunCommand.mockClear();
      fireEvent.click(button(id));
      expect(mockRunCommand).toHaveBeenCalledWith(id);
    }
  });

  it('fires nothing from a greyed row', () => {
    render(<PipelinePanel />);
    fireEvent.click(button('edit.remix'));
    expect(mockRunCommand).not.toHaveBeenCalled();
  });
});
