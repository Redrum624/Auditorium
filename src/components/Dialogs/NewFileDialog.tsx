import { useState } from 'react';
import { nextId } from '../../stores/appStore';
import { newDocument } from '../../services/fileService';
import DialogShell from './DialogShell';

const FIELD =
  'w-full rounded border border-[#3a3a42] bg-[#2e2e34] px-2 py-1 text-sm text-[#d4d4d8] focus:border-[#26c6da] focus:outline-none';
const LABEL = 'mb-1 block text-xs text-[#8b8b92]';

const SAMPLE_RATES = [44100, 48000, 96000];

/** New-file dialog: name, sample rate, channel count, and duration in seconds.
 * Creating makes a silent document active. Mounted only while open so the
 * default name (nextId-based) is computed once per opening. */
export default function NewFileDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState(() => `Untitled ${nextId('untitled').split('-')[1]}`);
  const [sampleRate, setSampleRate] = useState(44100);
  const [channels, setChannels] = useState<1 | 2>(2);
  const [durationSeconds, setDurationSeconds] = useState(5);

  const create = () => {
    newDocument({
      name: name.trim() || 'Untitled',
      sampleRate,
      channels,
      durationSeconds: Math.max(0, durationSeconds),
    });
    onClose();
  };

  return (
    <DialogShell title="New File" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div>
          <label className={LABEL} htmlFor="new-name">
            Name
          </label>
          <input
            id="new-name"
            className={FIELD}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <label className={LABEL} htmlFor="new-rate">
            Sample rate
          </label>
          <select
            id="new-rate"
            className={FIELD}
            value={sampleRate}
            onChange={(e) => setSampleRate(Number(e.target.value))}
          >
            {SAMPLE_RATES.map((r) => (
              <option key={r} value={r}>
                {r} Hz
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={LABEL} htmlFor="new-channels">
            Channels
          </label>
          <select
            id="new-channels"
            className={FIELD}
            value={channels}
            onChange={(e) => setChannels(Number(e.target.value) === 1 ? 1 : 2)}
          >
            <option value={1}>Mono</option>
            <option value={2}>Stereo</option>
          </select>
        </div>

        <div>
          <label className={LABEL} htmlFor="new-duration">
            Duration (seconds)
          </label>
          <input
            id="new-duration"
            type="number"
            min={0}
            step={0.1}
            className={FIELD}
            value={durationSeconds}
            onChange={(e) => setDurationSeconds(Number(e.target.value))}
          />
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-[#3a3a42] bg-[#2e2e34] px-3 py-1 text-sm text-[#d4d4d8] hover:bg-[#3a3a42]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={create}
            className="rounded bg-[#26c6da] px-3 py-1 text-sm font-medium text-[#101014] hover:brightness-110"
          >
            Create
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
