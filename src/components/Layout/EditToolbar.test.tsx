import { act, render, screen, fireEvent } from '@testing-library/react';
import EditToolbar, { EDIT_TOOLBAR_ITEMS } from './EditToolbar';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import { createClip } from '../../multitrack/session';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { runCommand } from '../../services/menuActions';
import { setClipboard, clearClipboard } from '../../services/clipboard';
import { cutSelection } from '../../services/editOps';
import { clearHistory, undo } from '../../services/undoHistory';

// The real registry (so every predicate under test is the MENU's own) with
// only the runner spied — a click has to reach `runCommand(id)`, and running
// the real edit for a click assertion would test editOps, not this pill.
jest.mock('../../services/menuActions', () => {
  const actual = jest.requireActual('../../services/menuActions');
  return { ...actual, runCommand: jest.fn(async () => {}) };
});
const mockRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;

function addDoc(): AudioDocument {
  const doc = createDocument({
    name: 'a.wav',
    sampleRate: 44100,
    channels: [new Float32Array(44100)],
  });
  act(() => useAppStore.getState().addDocument(doc));
  return doc;
}

function btn(label: string): HTMLButtonElement {
  return screen.getByRole('button', { name: label }) as HTMLButtonElement;
}

/** The pill re-reads the registry after a command settles (the in-app
 * clipboard has no subscribers), so a click's effects land one microtask
 * later — flush it inside act rather than asserting on a half-committed
 * render. */
async function click(label: string): Promise<void> {
  await act(async () => {
    fireEvent.click(btn(label));
  });
}

let lastDocId: string | null = null;

beforeEach(() => {
  if (lastDocId) clearHistory(lastDocId);
  lastDocId = null;
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(44100);
  clearClipboard();
  mockRunCommand.mockClear();
});

describe('EditToolbar — the E2 visibility rule', () => {
  it('is absent in the empty app, in every view', () => {
    for (const view of ['waveform', 'spectral', 'multitrack'] as const) {
      act(() => useAppStore.getState().setView(view));
      const { unmount } = render(<EditToolbar />);
      expect(screen.queryByTestId('edit-pill')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('is present in Waveform, Spectral AND Multitrack once one file is loaded', () => {
    lastDocId = addDoc().id;
    for (const view of ['waveform', 'spectral', 'multitrack'] as const) {
      act(() => useAppStore.getState().setView(view));
      const { unmount } = render(<EditToolbar />);
      expect(screen.getByTestId('edit-pill')).toBeInTheDocument();
      unmount();
    }
  });

  it('disappears again when the last document is closed', () => {
    const doc = addDoc();
    lastDocId = doc.id;
    render(<EditToolbar />);
    expect(screen.getByTestId('edit-pill')).toBeInTheDocument();

    act(() => useAppStore.getState().closeDocument(doc.id));
    expect(screen.queryByTestId('edit-pill')).not.toBeInTheDocument();
  });
});

describe('EditToolbar — the eight icon buttons', () => {
  it('renders exactly the eight commands, in the mockup order, icons only', () => {
    lastDocId = addDoc().id;
    const { container } = render(<EditToolbar />);
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="edit-pill"] button')
    );
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Cut',
      'Copy',
      'Paste',
      'Delete',
      'Trim',
      'Silence',
      'Undo',
      'Redo',
    ]);
    expect(EDIT_TOOLBAR_ITEMS).toHaveLength(8);
    // Icons only: every button's visible content is an SVG glyph, no text.
    for (const b of buttons) {
      expect(b.querySelector('svg')).not.toBeNull();
      expect(b.textContent).toBe('');
    }
  });

  it('is a glass chrome pill', () => {
    lastDocId = addDoc().id;
    render(<EditToolbar />);
    expect(screen.getByTestId('edit-pill').className).toContain('glass-chrome');
  });
});

describe('EditToolbar — per-button enablement, each predicate both ways', () => {
  it('greys Cut / Copy / Delete / Trim / Silence without a selection, and lights them with one', () => {
    const doc = addDoc();
    lastDocId = doc.id;
    render(<EditToolbar />);
    for (const label of ['Cut', 'Copy', 'Delete', 'Trim', 'Silence']) {
      expect(btn(label)).toBeDisabled();
    }

    act(() => useAppStore.getState().setSelection({ start: 0, end: 1000 }));
    for (const label of ['Cut', 'Copy', 'Delete', 'Trim', 'Silence']) {
      expect(btn(label)).toBeEnabled();
    }
  });

  it('greys Paste on an empty clipboard and lights it once something is on it', () => {
    lastDocId = addDoc().id;
    render(<EditToolbar />);
    expect(btn('Paste')).toBeDisabled();

    setClipboard({ channels: [new Float32Array(100)], sampleRate: 44100 });
    // A store touch re-reads the registry, exactly as the Edit menu does.
    act(() => useAppStore.getState().setCursor(1));
    expect(btn('Paste')).toBeEnabled();
  });

  it('greys Undo until the document has history, and Redo until an undo happened', () => {
    const doc = addDoc();
    lastDocId = doc.id;
    render(<EditToolbar />);
    expect(btn('Undo')).toBeDisabled();
    expect(btn('Redo')).toBeDisabled();

    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 1000 });
      cutSelection();
    });
    expect(btn('Undo')).toBeEnabled();
    expect(btn('Redo')).toBeDisabled();

    act(() => undo(doc.id));
    expect(btn('Undo')).toBeDisabled();
    expect(btn('Redo')).toBeEnabled();
  });

  // F1 (M1 fix round): this used to cover Cut/Copy/Paste ONLY, and Trim and
  // Silence stayed lit in exactly this state — a click destroyed everything
  // outside the selection in a document the multitrack view does not show,
  // while the Undo button one divider away routed to the session's history and
  // could not undo it. All five region verbs are now gated on the COMMAND, so
  // this pill inherits the rule instead of restating a subset of it.
  it('greys ALL five region verbs in Multitrack even with a document selection, and says why', () => {
    lastDocId = addDoc().id;
    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 1000 });
      useAppStore.getState().setView('multitrack');
    });
    setClipboard({ channels: [new Float32Array(100)], sampleRate: 44100 });
    render(<EditToolbar />);

    for (const label of ['Cut', 'Copy', 'Paste', 'Trim', 'Silence']) {
      expect(btn(label)).toBeDisabled();
      const title = btn(label).title.toLowerCase();
      expect(title).toContain('multitrack');
      // Honest about the remedy, not just the refusal.
      expect(title).toContain('waveform or spectral');
    }
  });

  it('lights the same five again on the way back to Waveform, so the gate is the VIEW', () => {
    lastDocId = addDoc().id;
    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 1000 });
      useAppStore.getState().setView('multitrack');
    });
    setClipboard({ channels: [new Float32Array(100)], sampleRate: 44100 });
    render(<EditToolbar />);
    expect(btn('Trim')).toBeDisabled();

    act(() => useAppStore.getState().setView('waveform'));

    for (const label of ['Cut', 'Copy', 'Paste', 'Trim', 'Silence']) {
      expect(btn(label)).toBeEnabled();
    }
  });

  it('routes Delete to the clip selection in Multitrack (both ways)', () => {
    lastDocId = addDoc().id;
    act(() => useAppStore.getState().setView('multitrack'));
    render(<EditToolbar />);
    expect(btn('Delete')).toBeDisabled();

    act(() => {
      useSessionStore.getState().addTrack();
      const trackId = useSessionStore.getState().session.tracks[0].id;
      const clip = createClip({
        documentId: 'x',
        startSample: 0,
        offsetSample: 0,
        lengthSample: 100,
      });
      useSessionStore.getState().addClip(trackId, clip);
      useSessionStore.getState().setSelectedClip(clip.id);
    });
    expect(btn('Delete')).toBeEnabled();
  });
});

describe('EditToolbar — click-through to the real commands', () => {
  it('runs each command id, and only when the button is live', async () => {
    lastDocId = addDoc().id;
    act(() => useAppStore.getState().setSelection({ start: 0, end: 1000 }));
    setClipboard({ channels: [new Float32Array(100)], sampleRate: 44100 });
    render(<EditToolbar />);

    for (const { label, commandId } of EDIT_TOOLBAR_ITEMS) {
      mockRunCommand.mockClear();
      const wasDisabled = btn(label).disabled;
      // eslint-disable-next-line no-await-in-loop -- one click at a time is the point
      await click(label);
      if (wasDisabled) {
        expect(mockRunCommand).not.toHaveBeenCalled();
      } else {
        expect(mockRunCommand).toHaveBeenCalledWith(commandId);
      }
    }
    // The loop is only meaningful if it exercised both arms.
    expect(btn('Redo').disabled).toBe(true);
    expect(btn('Cut').disabled).toBe(false);
  });

  it('sends Cut through edit.cut and Trim through edit.trim', async () => {
    lastDocId = addDoc().id;
    act(() => useAppStore.getState().setSelection({ start: 0, end: 1000 }));
    render(<EditToolbar />);

    await click('Cut');
    expect(mockRunCommand).toHaveBeenCalledWith('edit.cut');

    await click('Trim');
    expect(mockRunCommand).toHaveBeenCalledWith('edit.trim');
  });
});
