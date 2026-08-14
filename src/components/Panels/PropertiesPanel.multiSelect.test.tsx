import { render, screen } from '@testing-library/react';
import PropertiesPanel from './PropertiesPanel';
import { makeInitialState, useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import { createDocument } from '../../audio/AudioDocument';
import { createClip, type Clip } from '../../multitrack/session';

jest.mock('../../services/tempoAnalysis', () => ({
  getTempo: jest.fn(() => null),
  isTempoRunning: jest.fn(() => false),
  getTempoProgress: jest.fn(() => null),
  runTempoAnalysis: jest.fn(async () => null),
  regridTempo: jest.fn(async () => null),
  useTempoVersion: jest.fn(() => 0),
}));

/**
 * K1 R2 — what the Properties panel says about a MULTI-clip selection.
 *
 * The single-clip fields stay bound to the PRIMARY, unchanged and untouched:
 * gain, fades and the typed Start each edit one clip, and pretending otherwise
 * would mean a field whose displayed value belongs to one clip and whose commit
 * lands on several. The panel's only new job is to say how many clips the group
 * verbs would act on, so a Delete over a Ctrl+Click set is never a surprise.
 */

const store = () => useSessionStore.getState();

function seed(): { a: Clip; b: Clip } {
  const doc = createDocument({
    name: 'clip.wav',
    sampleRate: 44100,
    channels: [new Float32Array(44100)],
  });
  useAppStore.getState().addDocument(doc);
  const t1 = store().session.tracks[0].id;
  const t2 = store().session.tracks[1].id;
  const a = createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 4410 });
  const b = createClip({
    documentId: doc.id,
    startSample: 44100,
    offsetSample: 0,
    lengthSample: 4410,
  });
  store().addClip(t1, a);
  store().addClip(t2, b);
  return { a, b };
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(44100);
  useAppStore.setState({ view: 'multitrack' });
});

it('says how many clips are selected once there is more than one', () => {
  const { a, b } = seed();
  store().setSelectedClip(a.id);
  store().toggleSelectedClip(b.id);

  render(<PropertiesPanel />);
  expect(screen.getByTestId('clip-selection-count')).toHaveTextContent('2 clips selected');
});

it('says nothing about a count for a single selected clip', () => {
  const { a } = seed();
  store().setSelectedClip(a.id);

  render(<PropertiesPanel />);
  expect(screen.queryByTestId('clip-selection-count')).not.toBeInTheDocument();
});

it('binds the single-clip fields to the PRIMARY, not to the group', () => {
  const { a, b } = seed();
  store().setSelectedClip(a.id);
  store().toggleSelectedClip(b.id); // b is now the primary (last clicked)

  render(<PropertiesPanel />);
  // b starts at 44 100 = 1.000 s; a starts at 0. The Start field must show the
  // primary's own position, and the panel must still be the single-clip editor
  // it has always been.
  expect((screen.getByLabelText(/clip start/i) as HTMLInputElement).value).toBe('0:01.000');
  expect(screen.getByLabelText(/gain/i)).toBeInTheDocument();
});
