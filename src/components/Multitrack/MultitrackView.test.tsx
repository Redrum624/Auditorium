import { render, screen } from '@testing-library/react';
import MultitrackView from './MultitrackView';
import { useSessionStore } from '../../multitrack/sessionStore';
import { useAppStore, makeInitialState } from '../../stores/appStore';

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(44100);
});

describe('MultitrackView G6: floating track cards on the stage', () => {
  it('renders each track row (header + lane) as one glass card row', () => {
    render(<MultitrackView />);
    const headers = screen.getAllByTestId('track-header');
    const lanes = screen.getAllByTestId('track-lane');
    expect(headers).toHaveLength(4); // newSession seeds Track 1..Track 4
    expect(lanes).toHaveLength(4);
    headers.forEach((header, i) => {
      const row = header.parentElement!;
      expect(row).toHaveClass('glass-track-row');
      expect(row.contains(lanes[i])).toBe(true);
    });
  });

  it('keeps the stage insets on the view root and the multitrack contracts intact', () => {
    render(<MultitrackView />);
    expect(screen.getByTestId('multitrack-view')).toHaveClass('stage-inset');
    expect(screen.getByTestId('timeline-ruler')).toBeInTheDocument();
    // Buttons keep their accessible names + enablement: no active doc, no clips.
    expect(screen.getByRole('button', { name: /insert active file/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /mix down/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /add track/i })).toBeEnabled();
    expect(screen.getByText(/empty session/i)).toBeInTheDocument();
  });
});
