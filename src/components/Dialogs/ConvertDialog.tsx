import { useState } from 'react';
import type { ConvertMode } from '../../services/dialogBus';
import { convertChannels, convertSampleRate } from '../../services/documentTools';
import { useAppStore } from '../../stores/appStore';
import DialogShell from './DialogShell';

const FIELD =
  'w-full rounded border border-[#3a3a42] bg-[#2e2e34] px-2 py-1 text-sm text-[#d4d4d8] focus:border-[#26c6da] focus:outline-none';
const LABEL = 'mb-1 block text-xs text-[#8b8b92]';

const SAMPLE_RATES = [22050, 44100, 48000, 96000];

/**
 * Whole-document conversion dialog with two modes. In `sampleRate` mode it picks
 * a target rate and resamples every channel; in `channels` mode it picks mono or
 * stereo and mixes down / duplicates. Both apply to the active document through
 * documentTools (undoable) and close on Apply. The selects open seeded with the
 * ACTIVE document's current sample rate / channel count (Task F8) — falling back
 * to 44100 Hz / stereo when there is no document or its rate isn't an offered
 * option — so the dialog reflects where the doc IS before you pick a target.
 */
export default function ConvertDialog({
  mode,
  onClose,
}: {
  mode: ConvertMode;
  onClose: () => void;
}) {
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const [sampleRate, setSampleRate] = useState(() => {
    const s = useAppStore.getState();
    const doc = s.documents.find((d) => d.id === s.activeDocumentId);
    return doc && SAMPLE_RATES.includes(doc.sampleRate) ? doc.sampleRate : 44100;
  });
  const [channelCount, setChannelCount] = useState<1 | 2>(() => {
    const s = useAppStore.getState();
    const doc = s.documents.find((d) => d.id === s.activeDocumentId);
    return doc?.channels.length === 1 ? 1 : 2;
  });

  const isRateMode = mode === 'sampleRate';
  const title = isRateMode ? 'Convert Sample Rate' : 'Convert Channels';

  const apply = () => {
    if (!activeDocumentId) return;
    if (isRateMode) {
      convertSampleRate(activeDocumentId, sampleRate);
    } else {
      convertChannels(activeDocumentId, channelCount);
    }
    onClose();
  };

  return (
    <DialogShell title={title} onClose={onClose}>
      <div className="flex flex-col gap-3" data-testid="convert-dialog">
        {isRateMode ? (
          <div>
            <label className={LABEL} htmlFor="convert-rate">
              Target sample rate
            </label>
            <select
              id="convert-rate"
              data-testid="convert-rate"
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
        ) : (
          <div>
            <label className={LABEL} htmlFor="convert-channels">
              Channels
            </label>
            <select
              id="convert-channels"
              data-testid="convert-channels"
              className={FIELD}
              value={channelCount}
              onChange={(e) => setChannelCount(Number(e.target.value) === 1 ? 1 : 2)}
            >
              <option value={1}>Mono</option>
              <option value={2}>Stereo</option>
            </select>
          </div>
        )}

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
            onClick={apply}
            disabled={activeDocumentId === null}
            className="rounded bg-[#26c6da] px-3 py-1 text-sm font-medium text-[#101014] hover:brightness-110 disabled:opacity-50"
          >
            Apply
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
