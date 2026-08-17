import { useState } from 'react';
import { FilePlus2 } from 'lucide-react';
import { nextId } from '../../stores/appStore';
import { newDocument } from '../../services/fileService';
import { FieldLabel, GlassButton, GlassField, GlassSelect } from '../UI/glass';
import DialogShell from './DialogShell';

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
    <DialogShell title="New File" icon={<FilePlus2 size={15} />} width={380} onClose={onClose}>
      <div className="flex flex-col gap-3" data-testid="new-file-dialog">
        <div>
          <FieldLabel htmlFor="new-name">Name</FieldLabel>
          <GlassField
            id="new-name"
            data-testid="new-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <FieldLabel htmlFor="new-rate">Sample rate</FieldLabel>
          <GlassSelect
            id="new-rate"
            data-testid="new-rate"
            value={sampleRate}
            onChange={(e) => setSampleRate(Number(e.target.value))}
          >
            {SAMPLE_RATES.map((r) => (
              <option key={r} value={r}>
                {r} Hz
              </option>
            ))}
          </GlassSelect>
        </div>

        <div>
          <FieldLabel htmlFor="new-channels">Channels</FieldLabel>
          <GlassSelect
            id="new-channels"
            data-testid="new-channels"
            value={channels}
            onChange={(e) => setChannels(Number(e.target.value) === 1 ? 1 : 2)}
          >
            <option value={1}>Mono</option>
            <option value={2}>Stereo</option>
          </GlassSelect>
        </div>

        <div>
          <FieldLabel htmlFor="new-duration">Duration (seconds)</FieldLabel>
          <GlassField
            id="new-duration"
            data-testid="new-duration"
            type="number"
            min={0}
            step={0.1}
            value={durationSeconds}
            onChange={(e) => setDurationSeconds(Number(e.target.value))}
          />
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <GlassButton data-testid="new-cancel" onClick={onClose}>
            Cancel
          </GlassButton>
          <GlassButton variant="primary" data-testid="new-create" onClick={create}>
            Create
          </GlassButton>
        </div>
      </div>
    </DialogShell>
  );
}
