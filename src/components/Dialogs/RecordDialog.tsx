import { useEffect, useRef, useState } from 'react';
import { createDocument } from '../../audio/AudioDocument';
import { RecordingEngine, type AudioInput } from '../../audio/RecordingEngine';
import { nextId, useAppStore } from '../../stores/appStore';
import DialogShell from './DialogShell';

const FIELD =
  'w-full rounded border border-[#3a3a42] bg-[#2e2e34] px-2 py-1 text-sm text-[#d4d4d8] focus:border-[#26c6da] focus:outline-none disabled:opacity-50';
const LABEL = 'mb-1 block text-xs text-[#8b8b92]';

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
    const { channels: recorded, sampleRate: actualRate } = await engine.stop();
    setRecording(false);
    setLevel(MIN_DB);
    const doc = createDocument({
      name: `Recording ${nextId('recording').split('-')[1]}`,
      sampleRate: actualRate,
      channels: recorded,
    });
    useAppStore.getState().addDocument(doc);
    onClose();
  };

  const toggleRecord = () => {
    void (recording ? stopRecording() : startRecording());
  };

  return (
    // dismissable=false while recording (Task M7/F12): Escape and a stray
    // backdrop click must never discard an in-progress take. The explicit
    // Stop (toggle) and Close buttons remain the only ways out.
    <DialogShell title="Record" onClose={onClose} dismissable={!recording}>
      <div className="flex flex-col gap-3">
        <div>
          <label className={LABEL} htmlFor="record-device">
            Input device
          </label>
          <div className="flex gap-2">
            <select
              id="record-device"
              data-testid="record-device"
              className={FIELD}
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
            </select>
            <button
              type="button"
              aria-label="Refresh devices"
              title="Refresh devices"
              disabled={recording}
              onClick={refreshDevices}
              className="shrink-0 rounded border border-[#3a3a42] bg-[#2e2e34] px-2 py-1 text-sm text-[#d4d4d8] hover:bg-[#3a3a42] disabled:opacity-50"
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="flex gap-2">
          <div className="flex-1">
            <label className={LABEL} htmlFor="record-channels">
              Channels
            </label>
            <select
              id="record-channels"
              data-testid="record-channels"
              className={FIELD}
              value={channels}
              disabled={recording}
              onChange={(e) => setChannels(Number(e.target.value) === 2 ? 2 : 1)}
            >
              <option value={1}>Mono</option>
              <option value={2}>Stereo</option>
            </select>
          </div>
          <div className="flex-1">
            <label className={LABEL} htmlFor="record-rate">
              Sample rate
            </label>
            <select
              id="record-rate"
              data-testid="record-rate"
              className={FIELD}
              value={sampleRate}
              disabled={recording}
              onChange={(e) => setSampleRate(Number(e.target.value))}
            >
              {SAMPLE_RATES.map((r) => (
                <option key={r} value={r}>
                  {r} Hz
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className={LABEL}>Input level</label>
          <div
            data-testid="record-level"
            className="relative h-2 overflow-hidden rounded-[1px] bg-[#1a1a1e]"
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
            className="font-mono text-lg tabular-nums text-[#d4d4d8]"
          >
            {formatElapsed(elapsed)}
          </span>
          <button
            type="button"
            data-testid="record-toggle"
            aria-label={recording ? 'Stop recording' : 'Start recording'}
            onClick={toggleRecord}
            className={`flex items-center gap-2 rounded px-4 py-1.5 text-sm font-medium ${
              recording
                ? 'bg-[#ef5350] text-white hover:brightness-110'
                : 'bg-[#26c6da] text-[#101014] hover:brightness-110'
            }`}
          >
            <span
              className={`inline-block h-3 w-3 ${
                recording ? 'rounded-[2px]' : 'rounded-full'
              } bg-current`}
            />
            {recording ? 'Stop' : 'Record'}
          </button>
        </div>

        <div className="mt-1 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-[#3a3a42] bg-[#2e2e34] px-3 py-1 text-sm text-[#d4d4d8] hover:bg-[#3a3a42]"
          >
            Close
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
