import { createDocument } from '../audio/AudioDocument';
import { playbackEngine } from '../audio/PlaybackEngine';
import { multitrackPlayer } from '../multitrack/MultitrackPlayer';
import { multitrackRecorder } from '../multitrack/multitrackRecord';
import { useSessionStore } from '../multitrack/sessionStore';
import { useAppStore } from '../stores/appStore';
import * as dialogBus from './dialogBus';
import {
  canRecord,
  stopAll,
  transportPlayPause,
  transportRecord,
  transportStop,
} from './transportService';

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

    // --- D2: the bar is where Play starts (waveform/spectral) ---

    it('D2: Play starts at the bar, never at the engine paused position', () => {
      openDoc();
      // Paused at 5 000, then the user clicked the ruler at 12 345: the bar wins.
      peState.mockReturnValue('paused');
      (playbackEngine.getPositionSample as jest.Mock).mockReturnValue(5000);
      useAppStore.setState({ cursorSample: 12345 });

      transportPlayPause();

      expect(playbackEngine.play).toHaveBeenCalledWith(12345, {});
      expect(useAppStore.getState().playback).toMatchObject({
        state: 'playing',
        positionSample: 12345,
      });
    });

    it('D2: Pause moves the bar to the paused position, so Space-Space resumes there', () => {
      openDoc();
      useAppStore.setState({ cursorSample: 1234 });
      peState.mockReturnValue('playing');
      (playbackEngine.getPositionSample as jest.Mock).mockReturnValue(8800);

      transportPlayPause();

      expect(playbackEngine.pause).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().cursorSample).toBe(8800);
      expect(useAppStore.getState().playback).toMatchObject({
        state: 'paused',
        positionSample: 8800,
      });

      // Space again resumes from the bar the pause just wrote.
      peState.mockReturnValue('paused');
      transportPlayPause();
      expect(playbackEngine.play).toHaveBeenCalledWith(8800, {});
    });

    it('D2: a bar inside the selection starts there; outside it starts at selection.start', () => {
      openDoc();
      const selection = { start: 1000, end: 4000 };
      useAppStore.setState({ selection, cursorSample: 2500 });

      transportPlayPause();
      expect(playbackEngine.play).toHaveBeenLastCalledWith(2500, { playRegion: selection });

      useAppStore.setState({ cursorSample: 9000 });
      transportPlayPause();
      expect(playbackEngine.play).toHaveBeenLastCalledWith(1000, { playRegion: selection });
    });

    it('D2: selection.start counts as inside, selection.end as outside', () => {
      openDoc();
      const selection = { start: 1000, end: 4000 };
      useAppStore.setState({ selection, cursorSample: 1000 });

      transportPlayPause();
      expect(playbackEngine.play).toHaveBeenLastCalledWith(1000, { playRegion: selection });

      useAppStore.setState({ cursorSample: 3999 });
      transportPlayPause();
      expect(playbackEngine.play).toHaveBeenLastCalledWith(3999, { playRegion: selection });

      useAppStore.setState({ cursorSample: 4000 });
      transportPlayPause();
      expect(playbackEngine.play).toHaveBeenLastCalledWith(1000, { playRegion: selection });
    });

    it('D2: loop on keeps the bar as the start and loops the selection', () => {
      openDoc();
      const selection = { start: 1000, end: 4000 };
      useAppStore.setState({
        selection,
        cursorSample: 2500,
        playback: { state: 'stopped', positionSample: 0, loop: true },
      });

      transportPlayPause();
      expect(playbackEngine.play).toHaveBeenCalledWith(2500, { loopRegion: selection });
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

  describe('record routing (transportRecord)', () => {
    let recIsRecording: jest.SpyInstance;
    let recStart: jest.SpyInstance;
    let recStop: jest.SpyInstance;
    let openRecord: jest.SpyInstance;

    beforeEach(() => {
      recIsRecording = jest.spyOn(multitrackRecorder, 'isRecording').mockReturnValue(false);
      recStart = jest.spyOn(multitrackRecorder, 'start').mockResolvedValue(undefined);
      recStop = jest.spyOn(multitrackRecorder, 'stop').mockResolvedValue(undefined);
      openRecord = jest.spyOn(dialogBus, 'openRecordDialog').mockImplementation(() => {});
    });

    it('opens the Record dialog in the waveform view (no recorder toggle)', async () => {
      openDoc();
      await transportRecord();
      expect(openRecord).toHaveBeenCalledTimes(1);
      expect(recStart).not.toHaveBeenCalled();
      expect(recStop).not.toHaveBeenCalled();
    });

    it('starts the punch-in recorder in the multitrack view when idle', async () => {
      useAppStore.setState({ view: 'multitrack' });
      await transportRecord();
      expect(recStart).toHaveBeenCalledTimes(1);
      expect(openRecord).not.toHaveBeenCalled();
    });

    it('stops the punch-in recorder in the multitrack view when already recording', async () => {
      useAppStore.setState({ view: 'multitrack' });
      recIsRecording.mockReturnValue(true);
      await transportRecord();
      expect(recStop).toHaveBeenCalledTimes(1);
      expect(recStart).not.toHaveBeenCalled();
    });

    it('surfaces recorder errors via a message box without throwing', async () => {
      useAppStore.setState({ view: 'multitrack' });
      recStart.mockRejectedValue(new Error('No armed tracks'));
      const showMessageBox = jest.fn(async () => 0);
      (window as unknown as { electronAPI: { showMessageBox: jest.Mock } }).electronAPI = {
        showMessageBox,
      };
      await expect(transportRecord()).resolves.toBeUndefined();
      expect(showMessageBox).toHaveBeenCalled();
    });

    it('transportStop also stops the recorder while multitrack-recording', () => {
      useAppStore.setState({ view: 'multitrack' });
      recIsRecording.mockReturnValue(true);
      transportStop();
      expect(recStop).toHaveBeenCalledTimes(1);
      expect(multitrackPlayer.stop).toHaveBeenCalled();
    });

    it('transportPlayPause commits the take (stops the recorder) while recording', () => {
      useAppStore.setState({ view: 'multitrack' });
      recIsRecording.mockReturnValue(true);
      mtState.mockReturnValue('playing');
      transportPlayPause();
      expect(recStop).toHaveBeenCalledTimes(1);
      expect(multitrackPlayer.play).not.toHaveBeenCalled();
    });

    it('canRecord gates on armed tracks in multitrack view, stays true mid-take and elsewhere', () => {
      expect(canRecord()).toBe(true); // waveform view: dialog handles its own errors

      useAppStore.setState({ view: 'multitrack' });
      expect(canRecord()).toBe(false); // nothing armed → nothing to punch into

      const trackId = useSessionStore.getState().session.tracks[0].id;
      useSessionStore.getState().setTrackParam(trackId, { armed: true });
      expect(canRecord()).toBe(true);

      // A running take stays stoppable even if the user disarms everything.
      useSessionStore.getState().setTrackParam(trackId, { armed: false });
      recIsRecording.mockReturnValue(true);
      expect(canRecord()).toBe(true);
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
