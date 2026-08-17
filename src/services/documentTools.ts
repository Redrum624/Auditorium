import { mixDown } from '../audio/AudioDocument';
import { downmixToStereoWithLaw } from '../audio/decodeAudio';
import type { DownmixLaw } from '../dsp/downmix';
import { resampleChannel } from '../dsp/resample';
import { useAppStore } from '../stores/appStore';
import { applyEdit } from './editOps';

/**
 * Whole-document transforms that change global document properties (sample rate,
 * channel count) rather than a region of samples. Both go through `applyEdit`
 * so they are undoable — the undo entry snapshots the entire pre-edit document,
 * so undo restores channels AND sampleRate together.
 */

/**
 * Resamples every channel of the document to `toRate` and swaps `doc.sampleRate`.
 * No-op when the document is already at the target rate. The selection/cursor are
 * cleared because their sample positions no longer correspond after resampling.
 * Markers are rescaled in lockstep (`round(pos * toRate/fromRate)`, Task M3 / F4)
 * via the `{ type: 'rescale' }` descriptor passed to `applyEdit`, so they land on
 * the new sample clock and undo restores the pre-resample positions exactly.
 */
export function convertSampleRate(docId: string, toRate: number): void {
  const doc = useAppStore.getState().documents.find((d) => d.id === docId);
  if (!doc || doc.sampleRate === toRate) return;

  const fromRate = doc.sampleRate;
  applyEdit(
    'Convert Sample Rate',
    docId,
    (d) => ({
      ...d,
      channels: d.channels.map((c) => resampleChannel(c, fromRate, toRate)),
      sampleRate: toRate,
      dirty: true,
    }),
    { selection: null, cursorSample: 0 },
    { type: 'rescale', fromRate, toRate }
  );
}

/**
 * Converts the document to `to` channels: stereo -> mono averages the two
 * channels; mono -> stereo duplicates the single channel. Length is preserved,
 * so the selection/cursor are left untouched. No-op when the count already matches.
 *
 * R6: for a MULTICHANNEL (>2ch) document converting to stereo, `downmix`
 * selects the law — 'fold' (the app's original −3 dB fold of the extras,
 * `downmixToStereo`) or 'bs775' (the ITU-R BS.775-3 matrix; requires the
 * document's channelMask to describe a supported layout, else it falls back
 * to 'fold' — see `downmixToStereoWithLaw`). When `downmix` is OMITTED the
 * legacy behaviour is preserved byte-for-byte, including the historical
 * >2ch -> stereo path (duplicate channel 0) — the new laws are strictly
 * opt-in via the ConvertDialog. Any conversion drops `channelMask`: the mask
 * describes the source file's channel set, not the converted one.
 */
export function convertChannels(docId: string, to: 1 | 2, downmix?: DownmixLaw): void {
  const doc = useAppStore.getState().documents.find((d) => d.id === docId);
  if (!doc || doc.channels.length === to) return;

  applyEdit('Convert Channels', docId, (d) => {
    let channels: Float32Array[];
    if (to === 1) {
      channels = [mixDown(d.channels)];
    } else if (d.channels.length > 2 && downmix) {
      // Always >2 channels here, so both laws return freshly-allocated pairs.
      channels = downmixToStereoWithLaw(d.channels, downmix, d.channelMask);
    } else {
      const src = d.channels[0] ?? new Float32Array(0);
      channels = [src.slice(), src.slice()];
    }
    return { ...d, channels, channelMask: undefined, dirty: true };
  });
}
