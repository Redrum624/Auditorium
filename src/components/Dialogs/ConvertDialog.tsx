import { useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { bs775Applicable, type DownmixLaw } from '../../dsp/downmix';
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
  // R6: the selectable downmix law for a MULTICHANNEL (>2ch) doc -> stereo.
  // Defaults to the app's original fold; BS.775 is opt-in and only offered
  // when the document carries a layout the matrix covers — otherwise the
  // option is disabled so the law in force is always the one displayed.
  const [downmixLaw, setDownmixLaw] = useState<DownmixLaw>('fold');
  const sourceChannels = useAppStore(
    (s) => s.documents.find((d) => d.id === s.activeDocumentId)?.channels.length ?? 0
  );
  const sourceMask = useAppStore(
    (s) => s.documents.find((d) => d.id === s.activeDocumentId)?.channelMask
  );
  const multichannel = sourceChannels > 2;
  const bs775Ok = bs775Applicable(sourceMask, sourceChannels);

  const isRateMode = mode === 'sampleRate';
  const title = isRateMode ? 'Convert Sample Rate' : 'Convert Channels';
  const showDownmix = !isRateMode && multichannel && channelCount === 2;

  const apply = () => {
    if (!activeDocumentId) return;
    if (isRateMode) {
      convertSampleRate(activeDocumentId, sampleRate);
    } else if (showDownmix) {
      convertChannels(activeDocumentId, channelCount, downmixLaw);
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
            {showDownmix && (
              <div className="mt-3">
                <FieldLabel htmlFor="convert-downmix">Surround downmix</FieldLabel>
                <GlassSelect
                  id="convert-downmix"
                  data-testid="convert-downmix"
                  value={downmixLaw}
                  onChange={(e) => setDownmixLaw(e.target.value === 'bs775' ? 'bs775' : 'fold')}
                >
                  <option value="fold">Fold extras at −3 dB (default)</option>
                  <option value="bs775" disabled={!bs775Ok}>
                    ITU-R BS.775 surround matrix{bs775Ok ? '' : ' — needs a known layout'}
                  </option>
                </GlassSelect>
                <p
                  className="mt-1 text-xs"
                  style={{ color: 'var(--glass-text-muted)' }}
                  data-testid="convert-downmix-hint"
                >
                  {downmixLaw === 'bs775' && bs775Ok
                    ? 'Centre and surrounds fold in at −3 dB per ITU-R BS.775; LFE is discarded.'
                    : bs775Ok
                      ? 'All extra channels average into both sides at −3 dB.'
                      : 'This file does not carry a supported speaker layout, so the −3 dB fold applies.'}
                </p>
              </div>
            )}
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
