import { useState } from 'react';
import { Download } from 'lucide-react';
import type { WavBitDepth } from '../../audio/wavCodec';
import { exportDocument } from '../../services/fileService';
import { useAppStore } from '../../stores/appStore';
import { FieldLabel, GlassButton, GlassSelect } from '../UI/glass';
import DialogShell from './DialogShell';

const WAV_BIT_DEPTHS: WavBitDepth[] = [16, 24, 32];
const MP3_BITRATES: (128 | 192 | 256 | 320)[] = [128, 192, 256, 320];
const OGG_BITRATES: (96_000 | 128_000 | 192_000)[] = [96_000, 128_000, 192_000];

/** Export dialog: pick a container format and its quality setting, then export
 * the active document. On success `exportDocument` shows the confirmation and we
 * close; a cancelled save-dialog leaves this open. */
export default function ExportDialog({ onClose }: { onClose: () => void }) {
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const activeDocName = useAppStore(
    (s) => s.documents.find((d) => d.id === s.activeDocumentId)?.name
  );
  const [format, setFormat] = useState<'wav' | 'mp3' | 'flac' | 'ogg'>('wav');
  const [wavBitDepth, setWavBitDepth] = useState<WavBitDepth>(24);
  const [mp3Kbps, setMp3Kbps] = useState<128 | 192 | 256 | 320>(192);
  const [oggBitrate, setOggBitrate] = useState<96_000 | 128_000 | 192_000>(128_000);
  const [busy, setBusy] = useState(false);

  const doExport = async () => {
    if (!activeDocumentId || busy) return;
    setBusy(true);
    try {
      const path = await exportDocument(activeDocumentId, {
        format,
        wavBitDepth,
        mp3Kbps,
        oggBitrate,
      });
      if (path) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell
      title="Export"
      subtitle={activeDocName}
      icon={<Download size={15} />}
      width={400}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3" data-testid="export-dialog">
        <div>
          <FieldLabel htmlFor="export-format">Format</FieldLabel>
          <GlassSelect
            id="export-format"
            data-testid="export-format"
            value={format}
            onChange={(e) => {
              const v = e.target.value;
              setFormat(
                v === 'mp3' ? 'mp3' : v === 'flac' ? 'flac' : v === 'ogg' ? 'ogg' : 'wav'
              );
            }}
          >
            <option value="wav">WAV (uncompressed)</option>
            <option value="flac">FLAC (16-bit)</option>
            <option value="mp3">MP3 (compressed)</option>
            <option value="ogg">OGG (Opus)</option>
          </GlassSelect>
        </div>

        {format === 'flac' ? (
          <p className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
            Lossless FLAC, 16-bit. No quality setting to choose.
          </p>
        ) : format === 'ogg' ? (
          <div>
            <FieldLabel htmlFor="export-ogg-bitrate">Bit rate</FieldLabel>
            <GlassSelect
              id="export-ogg-bitrate"
              data-testid="export-ogg-bitrate"
              value={oggBitrate}
              onChange={(e) =>
                setOggBitrate(Number(e.target.value) as 96_000 | 128_000 | 192_000)
              }
            >
              {OGG_BITRATES.map((r) => (
                <option key={r} value={r}>
                  {r / 1000} kbps
                </option>
              ))}
            </GlassSelect>
          </div>
        ) : format === 'wav' ? (
          <div>
            <FieldLabel htmlFor="export-bitdepth">Bit depth</FieldLabel>
            <GlassSelect
              id="export-bitdepth"
              data-testid="export-bitdepth"
              value={wavBitDepth}
              onChange={(e) => setWavBitDepth(Number(e.target.value) as WavBitDepth)}
            >
              {WAV_BIT_DEPTHS.map((d) => (
                <option key={d} value={d}>
                  {d === 32 ? '32-bit float' : `${d}-bit`}
                </option>
              ))}
            </GlassSelect>
          </div>
        ) : (
          <div>
            <FieldLabel htmlFor="export-kbps">Bit rate</FieldLabel>
            <GlassSelect
              id="export-kbps"
              data-testid="export-kbps"
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
            </GlassSelect>
          </div>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <GlassButton data-testid="export-cancel" onClick={onClose}>
            Cancel
          </GlassButton>
          <GlassButton
            variant="primary"
            data-testid="export-confirm"
            onClick={doExport}
            disabled={busy}
          >
            Export
          </GlassButton>
        </div>
      </div>
    </DialogShell>
  );
}
