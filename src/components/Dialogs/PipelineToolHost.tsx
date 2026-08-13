import { useCallback, type ComponentType } from 'react';
import AlignLyricsDialog from './AlignLyricsDialog';
import AlignTimingDialog from './AlignTimingDialog';
import CoverChainDialog from './CoverChainDialog';
import RemixDialog from './RemixDialog';
import SeparateDialog from './SeparateDialog';
import TempoDialog from './TempoDialog';
import TranscribeDialog from './TranscribeDialog';
import VocalChainDialog from './VocalChainDialog';
import VoiceChangerDialog from './VoiceChangerDialog';
import { DialogHostProvider } from './DialogHost';
import { GlassCard } from '../UI/glass';
import { MODULE_COLUMN_WIDTH } from '../Layout/ModuleStrip';

/**
 * U2-3 — the tool-host card: a pipeline tool rendered IN the module column
 * instead of over the stage.
 *
 * The registry below is the answer to "which Pipeline rows open a tool UI", and
 * it is the honest one: a row is hosted exactly when a component is mounted for
 * it here. The Pipeline menu has eleven rows and only nine are in this map —
 * `tempo.detect` runs an analysis and reports through its own channel, and
 * `spatial.position` puts an existing PANEL in the ordinary module card — so
 * "every Pipeline tool" would have been wrong, and a written list of nine ids
 * somewhere else would have been a second place for it to go wrong.
 *
 * Every one of the nine is imported UNCHANGED. Each renders its body inside
 * `DialogShell`, and the provider below is what tells that shared shell to draw
 * card chrome rather than a modal — so the whole move cost the dialogs nothing,
 * which is also what let it happen alongside a concurrent rewrite of
 * `CoverChainDialog`'s internals.
 */
const PIPELINE_TOOL_COMPONENTS: Record<string, ComponentType<{ onClose(): void }>> = {
  // Tempo & Timing
  'tempo.match': TempoDialog,
  'timing.align': AlignTimingDialog,
  'edit.remix': RemixDialog,
  // Voice
  'edit.voiceChanger': VoiceChangerDialog,
  'effects.vocalChain': VocalChainDialog,
  'effects.coverChain': CoverChainDialog,
  'lyrics.align': AlignLyricsDialog,
  // Analysis
  'edit.transcribe': TranscribeDialog,
  'edit.separateStems': SeparateDialog,
};

/** Whether a command id opens a tool the module column hosts. */
export function isPipelineTool(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(PIPELINE_TOOL_COMPONENTS, id);
}

/** The command ids this host can mount, in registry order. */
export function hostedToolIds(): string[] {
  return Object.keys(PIPELINE_TOOL_COMPONENTS);
}

/**
 * The card's width, and why it is 640 rather than the module column's 348.
 *
 * It is measured, not chosen: 640 is the widest `width` any of the nine hands
 * `DialogShell` (`CoverChainDialog`), with Auto-Remix and Vocal Chain at 600
 * and Align Lyrics at 560 behind it. Hosting at anything narrower would reflow
 * content that was laid out against those numbers — the cover chain's stage
 * table and the remix plan's per-run bars are the two that would break first —
 * and hosting at anything wider would buy nothing but stage.
 *
 * What it costs, counted properly: the lane is inset on BOTH sides (14 left as
 * well as the column's 14 + width + 14 right), so at the app's minimum window
 * width (`electron/main.cjs` minWidth 1100) the waveform keeps
 * `1100 - 14 - 668 = 418px`, and 918px at the 1600 default. At the minimum
 * window the tool is therefore the WIDER of the two — that is the trade the
 * user opts into by opening it, and it reverses at any ordinary window size.
 * The number the width had to pass is a floor, not a comparison: a lane you
 * can still select and scrub in. See `PipelineToolHost.test`.
 *
 * The card grows LEFTWARD out of the 348px column rather than widening it, via
 * the negative left margin below — the column's width is shared with the strip
 * above it and the TempoCard beside it, and neither should move because a tool
 * is open.
 */
export const TOOL_HOST_WIDTH = 640;

export default function PipelineToolHost({
  commandId,
  onClose,
  onModuleLockChange,
}: {
  /** A Pipeline command id; nothing renders for an id this host does not know. */
  commandId: string;
  onClose(): void;
  /** Raised with the hosted tool's module LOCK — `!dismissable` unless the tool
   * narrowed it (see `DialogShell`'s `moduleLock`). `true` means a user-started
   * pass is running; App turns that into a greyed module strip and a live
   * `hasOpenDialog()`. */
  onModuleLockChange(locked: boolean): void;
}) {
  const Tool = PIPELINE_TOOL_COMPONENTS[commandId];
  // Stable identity, so the provider's memo does not re-publish per paint.
  const report = useCallback(
    (locked: boolean) => onModuleLockChange(locked),
    [onModuleLockChange]
  );
  if (!Tool) return null;

  return (
    <GlassCard
      data-testid="tool-host"
      data-tool-id={commandId}
      className="pointer-events-auto flex min-h-0 flex-col"
      style={{
        flex: '0 1 auto',
        overflow: 'hidden',
        width: TOOL_HOST_WIDTH,
        // Grow left out of the column instead of widening it: the strip above
        // and the TempoCard beside keep the column's own 348.
        marginLeft: MODULE_COLUMN_WIDTH - TOOL_HOST_WIDTH,
      }}
    >
      <DialogHostProvider onModuleLockChange={report}>
        <Tool onClose={onClose} />
      </DialogHostProvider>
    </GlassCard>
  );
}
