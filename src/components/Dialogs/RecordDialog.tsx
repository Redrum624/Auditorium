import { useEffect, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { createDocument } from '../../audio/AudioDocument';
import { RecordingEngine, type AudioInput } from '../../audio/RecordingEngine';
import { nextId, useAppStore } from '../../stores/appStore';
import { FieldLabel, GlassButton, GlassSelect } from '../UI/glass';
import DialogShell from './DialogShell';

const SAMPLE_RATES = [44100, 48000] as const;
const MIN_DB = -60;

/** Map a peak dB in [-60, 0] to a 0..100 percentage for the level bar. */
function dbToPercent(db: number): number {
  const clamped = Math.min(0, Math.max(MIN_DB, db));
  return ((clamped - MIN_DB) / -MIN_DB) * 100;
}

/** mm:ss from a whole-second elapsed count. */
function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Microphone recording dialog: choose an input device, channel count and sample
 * rate, then Record/Stop. A live level bar (driven by `engine.onLevel`) and an
 * elapsed clock give feedback while recording. On Stop the captured channels
 * become a new 'Recording N' document. The dialog owns a single RecordingEngine
 * instance (injectable for tests, like LevelMeter's `engine` prop); permission
 * and device errors surface via a native message box and leave the dialog open.
 */
export default function RecordDialog({
  onClose,
  engine: injectedEngine,
}: {
  onClose: () => void;
  engine?: RecordingEngine;
}) {
  const [engine] = useState(() => injectedEngine ?? new RecordingEngine());
  const [devices, setDevices] = useState<AudioInput[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [channels, setChannels] = useState<1 | 2>(1);
  const [sampleRate, setSampleRate] = useState<number>(44100);
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(MIN_DB);
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshDevices = () => {
    void engine.listInputs().then(setDevices);
  };

  // Enumerate devices once on open.
  useEffect(refreshDevices, [engine]);

  // Live level metering.
  useEffect(() => engine.onLevel(setLevel), [engine]);

  // Release the mic if the dialog is dismissed mid-recording.
  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (engine.isRecording) void engine.stop();
    },
    [engine]
  );

  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const startRecording = async () => {
    try {
      await engine.start({ deviceId: deviceId || undefined, channels, sampleRate });
      setRecording(true);
      setElapsed(0);
      startedAtRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setElapsed((Date.now() - startedAtRef.current) / 1000);
      }, 250);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void window.electronAPI?.showMessageBox({
        type: 'error',
        title: 'Recording failed',
        message: `Could not start recording: ${message}`,
      });
    }
  };

  const stopRecording = async () => {
    clearTimer();
    // F12 raises the stakes on a silent failure here: if engine.stop() rejects
    // without this catch, `recording` never flips back to false, so the
    // Escape/backdrop veto stays latched (Close still works, but the user
    // gets no feedback at all about why the take vanished). Surface the error
    // and always clear `recording` so the dialog returns to a normal,
    // dismissable state.
    try {
      const { channels: recorded, sampleRate: actualRate } = await engine.stop();
      const doc = createDocument({
        name: `Recording ${nextId('recording').split('-')[1]}`,
        sampleRate: actualRate,
        channels: recorded,
      });
      useAppStore.getState().addDocument(doc);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void window.electronAPI?.showMessageBox({
        type: 'error',
        title: 'Recording failed',
        message: `Could not finish recording: ${message}`,
      });
    } finally {
      setRecording(false);
      setLevel(MIN_DB);
    }
  };

  const toggleRecord = () => {
    void (recording ? stopRecording() : startRecording());
  };

  return (
    // dismissable=false while recording (Task M7/F12): Escape and a stray
    // backdrop click must never discard an in-progress take. The explicit
    // Stop (toggle) and Close buttons remain the only ways out.
    <DialogShell
      title="Record"
      icon={<Mic size={15} />}
      width={420}
      onClose={onClose}
      dismissable={!recording}
    >
      <div className="flex flex-col gap-3">
        <div>
          <FieldLabel htmlFor="record-device">Input device</FieldLabel>
          <div className="flex gap-2">
            <GlassSelect
              id="record-device"
              data-testid="record-device"
              value={deviceId}
              disabled={recording}
              onChange={(e) => setDeviceId(e.target.value)}
            >
              <option value="">System default</option>
              {devices.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
            </GlassSelect>
            <GlassButton
              aria-label="Refresh devices"
              title="Refresh devices"
              disabled={recording}
              onClick={refreshDevices}
              className="shrink-0"
              style={{ padding: '6px 10px', fontSize: 12 }}
            >
              Refresh
            </GlassButton>
          </div>
        </div>

        <div className="flex gap-2">
          <div className="flex-1">
            <FieldLabel htmlFor="record-channels">Channels</FieldLabel>
            <GlassSelect
              id="record-channels"
              data-testid="record-channels"
              value={channels}
              disabled={recording}
              onChange={(e) => setChannels(Number(e.target.value) === 2 ? 2 : 1)}
            >
              <option value={1}>Mono</option>
              <option value={2}>Stereo</option>
            </GlassSelect>
          </div>
          <div className="flex-1">
            <FieldLabel htmlFor="record-rate">Sample rate</FieldLabel>
            <GlassSelect
              id="record-rate"
              data-testid="record-rate"
              value={sampleRate}
              disabled={recording}
              onChange={(e) => setSampleRate(Number(e.target.value))}
            >
              {SAMPLE_RATES.map((r) => (
                <option key={r} value={r}>
                  {r} Hz
                </option>
              ))}
            </GlassSelect>
          </div>
        </div>

        <div>
          <FieldLabel>Input level</FieldLabel>
          <div
            data-testid="record-level"
            className="relative h-2 overflow-hidden"
            style={{
              borderRadius: 3,
              background: 'rgba(255, 255, 255, 0.09)',
              boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.6)',
            }}
          >
            <div
              className="absolute inset-y-0 left-0"
              style={{
                width: `${dbToPercent(level)}%`,
                background:
                  'linear-gradient(to right, #4caf50 0%, #4caf50 70%, #ffd54f 80%, #ef5350 95%, #ef5350 100%)',
              }}
            />
          </div>
        </div>

        <div className="flex items-center justify-between">
          <span
            data-testid="record-elapsed"
            className="font-mono text-lg tabular-nums"
            style={{ color: 'var(--glass-text-title)' }}
          >
            {formatElapsed(elapsed)}
          </span>
          <GlassButton
            variant="primary"
            data-testid="record-toggle"
            aria-label={recording ? 'Stop recording' : 'Start recording'}
            onClick={toggleRecord}
            style={
              recording
                ? {
                    background: '#ef5350',
                    borderColor: 'rgba(239, 83, 80, 0.5)',
                    boxShadow: '0 2px 18px rgba(239, 83, 80, 0.35)',
                    color: '#ffffff',
                  }
                : undefined
            }
          >
            <span
              className={`inline-block h-3 w-3 ${
                recording ? 'rounded-[2px]' : 'rounded-full'
              } bg-current`}
            />
            {recording ? 'Stop' : 'Record'}
          </GlassButton>
        </div>

        <div className="mt-1 flex justify-end">
          <GlassButton onClick={onClose}>Close</GlassButton>
        </div>
      </div>
    </DialogShell>
  );
}
