import { createDocument } from '../audio/AudioDocument';
import { playbackEngine } from '../audio/PlaybackEngine';
import { multitrackPlayer } from '../multitrack/MultitrackPlayer';
import { useSessionStore } from '../multitrack/sessionStore';
import { useAppStore } from '../stores/appStore';
import { stopAll, transportPlayPause, transportStop } from './transportService';

function openDoc() {
  const doc = createDocument({ name: 'a', sampleRate: 44100, channels: [new Float32Array(1000)] });
  useAppStore.setState({ documents: [doc], activeDocumentId: doc.id });
  return doc;
}

describe('transportService', () => {
  let peState: jest.SpyInstance;
  let mtState: jest.SpyInstance;

  beforeEach(() => {
    useAppStore.setState({
      documents: [],
      activeDocumentId: null,
      view: 'waveform',
      selection: null,
      cursorSample: 0,
      playback: { state: 'stopped', positionSample: 0, loop: false },
    });
    useSessionStore.getState().newSession(44100);

    jest.spyOn(playbackEngine, 'play').mockImplementation(() => {});
    jest.spyOn(playbackEngine, 'pause').mockImplementation(() => {});
    jest.spyOn(playbackEngine, 'stop').mockImplementation(() => {});
    jest.spyOn(playbackEngine, 'getPositionSample').mockReturnValue(0);
    peState = jest.spyOn(playbackEngine, 'state', 'get').mockReturnValue('stopped');

    jest.spyOn(multitrackPlayer, 'play').mockImplementation(() => {});
    jest.spyOn(multitrackPlayer, 'stop').mockImplementation(() => {});
    mtState = jest.spyOn(multitrackPlayer, 'state', 'get').mockReturnValue('stopped');
  });

  afterEach(() => jest.restoreAllMocks());

  describe('waveform view (single-document PlaybackEngine)', () => {
    it('plays from the cursor when stopped with no selection', () => {
      openDoc();
      useAppStore.setState({ cursorSample: 321 });
      transportPlayPause();
      expect(playbackEngine.play).toHaveBeenCalledWith(321, {});
      expect(useAppStore.getState().playback.state).toBe('playing');
    });

    it('plays the selection region (or loops it when loop is on)', () => {
      openDoc();
      useAppStore.setState({ selection: { start: 100, end: 400 }, playback: { state: 'stopped', positionSample: 0, loop: true } });
      transportPlayPause();
      expect(playbackEngine.play).toHaveBeenCalledWith(100, { loopRegion: { start: 100, end: 400 } });
    });

    it('pauses when already playing', () => {
      openDoc();
      peState.mockReturnValue('playing');
      transportPlayPause();
      expect(playbackEngine.pause).toHaveBeenCalled();
      expect(multitrackPlayer.play).not.toHaveBeenCalled();
      expect(useAppStore.getState().playback.state).toBe('paused');
    });

    it('is a no-op without an active document', () => {
      transportPlayPause();
      expect(playbackEngine.play).not.toHaveBeenCalled();
    });

    it('stop routes to the PlaybackEngine', () => {
      openDoc();
      transportStop();
      expect(playbackEngine.stop).toHaveBeenCalled();
      expect(multitrackPlayer.stop).not.toHaveBeenCalled();
      expect(useAppStore.getState().playback.state).toBe('stopped');
    });
  });

  describe('multitrack view (MultitrackPlayer)', () => {
    beforeEach(() => useAppStore.setState({ view: 'multitrack' }));

    it('plays from the multitrack cursor when stopped', () => {
      useSessionStore.getState().setMtCursor(555);
      transportPlayPause();
      expect(multitrackPlayer.play).toHaveBeenCalledTimes(1);
      const [from, session] = (multitrackPlayer.play as jest.Mock).mock.calls[0];
      expect(from).toBe(555);
      expect(session).toBe(useSessionStore.getState().session);
      expect(playbackEngine.play).not.toHaveBeenCalled();
    });

    it('stops when already playing (no pause in multitrack)', () => {
      mtState.mockReturnValue('playing');
      transportPlayPause();
      expect(multitrackPlayer.stop).toHaveBeenCalled();
      expect(multitrackPlayer.play).not.toHaveBeenCalled();
    });

    it('stop routes to the MultitrackPlayer', () => {
      transportStop();
      expect(multitrackPlayer.stop).toHaveBeenCalled();
      expect(playbackEngine.stop).not.toHaveBeenCalled();
    });
  });

  describe('stopAll (Task 23: view-switch guard)', () => {
    it('stops both engines unconditionally regardless of the active view', () => {
      openDoc();
      peState.mockReturnValue('playing');
      mtState.mockReturnValue('playing');

      stopAll();

      expect(playbackEngine.stop).toHaveBeenCalledTimes(1);
      expect(multitrackPlayer.stop).toHaveBeenCalledTimes(1);
    });

    it('stops both engines even when neither is playing (idempotent, no-op-safe)', () => {
      stopAll();
      expect(playbackEngine.stop).toHaveBeenCalledTimes(1);
      expect(multitrackPlayer.stop).toHaveBeenCalledTimes(1);
    });
  });
});
