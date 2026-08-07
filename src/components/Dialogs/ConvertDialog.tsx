import { useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import type { ConvertMode } from '../../services/dialogBus';
import { convertChannels, convertSampleRate } from '../../services/documentTools';
import { useAppStore } from '../../stores/appStore';
import { FieldLabel, GlassButton, GlassSelect } from '../UI/glass';
import DialogShell from './DialogShell';

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
  const activeDocName = useAppStore(
    (s) => s.documents.find((d) => d.id === s.activeDocumentId)?.name
  );
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
    <DialogShell
      title={title}
      subtitle={activeDocName}
      icon={<ArrowLeftRight size={15} />}
      width={380}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3" data-testid="convert-dialog">
        {isRateMode ? (
          <div>
            <FieldLabel htmlFor="convert-rate">Target sample rate</FieldLabel>
            <GlassSelect
              id="convert-rate"
              data-testid="convert-rate"
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
        ) : (
          <div>
            <FieldLabel htmlFor="convert-channels">Channels</FieldLabel>
            <GlassSelect
              id="convert-channels"
              data-testid="convert-channels"
              value={channelCount}
              onChange={(e) => setChannelCount(Number(e.target.value) === 1 ? 1 : 2)}
            >
              <option value={1}>Mono</option>
              <option value={2}>Stereo</option>
            </GlassSelect>
          </div>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <GlassButton onClick={onClose}>Cancel</GlassButton>
          <GlassButton variant="primary" onClick={apply} disabled={activeDocumentId === null}>
            Apply
          </GlassButton>
        </div>
      </div>
    </DialogShell>
  );
}
