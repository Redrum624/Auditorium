import { act, fireEvent, render } from '@testing-library/react';
import HistoryPanel from './HistoryPanel';
import { makeInitialState, useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import { _resetSessionUndo } from '../../multitrack/sessionUndo';

/**
 * R3 — the History panel shows the stack for whatever is active (ruling 1):
 * in the multitrack view that is the SESSION's history, click-to-undo/redo
 * included. The document view's behaviour is pinned by HistoryPanel.test.tsx
 * and must not change.
 */

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetSessionUndo();
  useSessionStore.getState().newSession(44100);
  _resetSessionUndo();
  useAppStore.getState().setView('multitrack');
});

const labels = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-testid="history-item"] button')).map(
    (b) => b.textContent
  );

describe('HistoryPanel in the multitrack view', () => {
  it('lists the session stack with no document open, newest highlighted', () => {
    act(() => {
      useSessionStore.getState().addTrack();
      useSessionStore.getState().renameTrack(useSessionStore.getState().session.tracks[0].id, 'Lead');
    });
    const { container } = render(<HistoryPanel />);
    expect(labels(container)).toEqual(['Add track', 'Rename track']);
    const current = container.querySelector('[aria-current="true"]');
    expect(current?.textContent).toBe('Rename track');
  });

  it('clicking an older applied entry undoes back to it; clicking an undone entry redoes to it', () => {
    act(() => {
      useSessionStore.getState().addTrack(); // 5 tracks
      useSessionStore.getState().addTrack(); // 6 tracks
      useSessionStore.getState().addTrack(); // 7 tracks
    });
    const { container } = render(<HistoryPanel />);
    const items = () =>
      Array.from(container.querySelectorAll('[data-testid="history-item"] button'));

    // Click the FIRST entry: the two entries after it are undone.
    fireEvent.click(items()[0]);
    expect(useSessionStore.getState().session.tracks).toHaveLength(5);

    // The undone entries render after the applied one; clicking the last
    // redoes both.
    fireEvent.click(items()[2]);
    expect(useSessionStore.getState().session.tracks).toHaveLength(7);
  });

  it('shows the empty state before any session edit', () => {
    const { getByText } = render(<HistoryPanel />);
    expect(getByText('No edits yet.')).toBeTruthy();
  });

  it('back in the waveform view with no document, the doc empty state returns', () => {
    act(() => {
      useSessionStore.getState().addTrack(); // session history exists...
      useAppStore.getState().setView('waveform');
    });
    const { getByText } = render(<HistoryPanel />);
    // ...but the waveform view addresses documents, and none is open.
    expect(getByText('No document open.')).toBeTruthy();
  });
});
