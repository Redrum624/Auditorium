import { useState } from 'react';
import type { WavBitDepth } from '../../audio/wavCodec';
import { exportDocument } from '../../services/fileService';
import { useAppStore } from '../../stores/appStore';
import DialogShell from './DialogShell';

const FIELD =
  'w-full rounded border border-[#3a3a42] bg-[#2e2e34] px-2 py-1 text-sm text-[#d4d4d8] focus:border-[#26c6da] focus:outline-none';
const LABEL = 'mb-1 block text-xs text-[#8b8b92]';

const WAV_BIT_DEPTHS: WavBitDepth[] = [16, 24, 32];
const MP3_BITRATES: (128 | 192 | 256 | 320)[] = [128, 192, 256, 320];

/** Export dialog: pick a container format and its quality setting, then export
 * the active document. On success `exportDocument` shows the confirmation and we
 * close; a cancelled save-dialog leaves this open. */
export default function ExportDialog({ onClose }: { onClose: () => void }) {
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const [format, setFormat] = useState<'wav' | 'mp3'>('wav');
  const [wavBitDepth, setWavBitDepth] = useState<WavBitDepth>(24);
  const [mp3Kbps, setMp3Kbps] = useState<128 | 192 | 256 | 320>(192);
  const [busy, setBusy] = useState(false);

  const doExport = async () => {
    if (!activeDocumentId || busy) return;
    setBusy(true);
    try {
      const path = await exportDocument(activeDocumentId, { format, wavBitDepth, mp3Kbps });
      if (path) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell title="Export" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div>
          <label className={LABEL} htmlFor="export-format">
            Format
          </label>
          <select
            id="export-format"
            className={FIELD}
            value={format}
            onChange={(e) => setFormat(e.target.value === 'mp3' ? 'mp3' : 'wav')}
          >
            <option value="wav">WAV (uncompressed)</option>
            <option value="mp3">MP3 (compressed)</option>
          </select>
        </div>

        {format === 'wav' ? (
          <div>
            <label className={LABEL} htmlFor="export-bitdepth">
              Bit depth
            </label>
            <select
              id="export-bitdepth"
              data-testid="export-bitdepth"
              className={FIELD}
              value={wavBitDepth}
              onChange={(e) => setWavBitDepth(Number(e.target.value) as WavBitDepth)}
            >
              {WAV_BIT_DEPTHS.map((d) => (
                <option key={d} value={d}>
                  {d === 32 ? '32-bit float' : `${d}-bit`}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div>
            <label className={LABEL} htmlFor="export-kbps">
              Bit rate
            </label>
            <select
              id="export-kbps"
              data-testid="export-kbps"
              className={FIELD}
              value={mp3Kbps}
              onChange={(e) =>
                setMp3Kbps(Number(e.target.value) as 128 | 192 | 256 | 320)
              }
            >
              {MP3_BITRATES.map((r) => (
                <option key={r} value={r}>
                  {r} kbps
                </option>
              ))}
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
            onClick={doExport}
            disabled={busy}
            className="rounded bg-[#26c6da] px-3 py-1 text-sm font-medium text-[#101014] hover:brightness-110 disabled:opacity-50"
          >
            Export
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
