import { useCallback, type ComponentType } from 'react';
import AlignLyricsDialog from './AlignLyricsDialog';
import AlignTimingDialog from './AlignTimingDialog';
import CoverChainDialog from './CoverChainDialog';
import PodcastChainDialog from './PodcastChainDialog';
import RemixDialog from './RemixDialog';
import SeparateDialog from './SeparateDialog';
import TempoDialog from './TempoDialog';
import TranscribeDialog from './TranscribeDialog';
import VocalChainDialog from './VocalChainDialog';
import VoiceChangerDialog from './VoiceChangerDialog';
import { DialogHostProvider } from './DialogHost';
import { GlassCard } from '../UI/glass';
import { MODULE_COLUMN_WIDTH, TOOL_HOST_WIDTH } from '../Layout/ModuleStrip';

/**
 * D4 — `voice.separate` mounts the SAME `SeparateDialog` as
 * `edit.separateStems`, in voice mode. A wrapper rather than a second entry in
 * a props table beside the map: the map is the one answer to "which rows
 * open a tool", and a parallel table keyed by the same ids would be a second
 * place for that answer to go wrong.
 */
function SeparateVoiceDialog({ onClose }: { onClose(): void }) {
  return <SeparateDialog mode="voice" onClose={onClose} />;
}

/**
 * U2-3 — the tool-host card: a pipeline tool rendered IN the module column
 * instead of over the stage.
 *
 * The registry below is the answer to "which Pipeline rows open a tool UI", and
 * it is the honest one: a row is hosted exactly when a component is mounted for
 * it here. The Pipeline menu has twelve rows and only eleven are in this map —
 * `tempo.detect` runs an analysis and reports through its own channel — so
 * "every Pipeline tool" would have been wrong, and a written list of ids
 * somewhere else would have been a second place for it to go wrong.
 * (`spatial.position`, which puts an existing PANEL in the ordinary module
 * card, was the other unhosted row until T8 moved it to the Effects menu.)
 *
 * Every one of them is imported UNCHANGED (D4's `voice.separate` reaching one
 * of them a second time, through the wrapper above). Each renders its body inside
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
  'voice.separate': SeparateVoiceDialog,
  'edit.voiceChanger': VoiceChangerDialog,
  'effects.vocalChain': VocalChainDialog,
  'effects.coverChain': CoverChainDialog,
  'effects.podcastChain': PodcastChainDialog,
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
 * It is measured, not chosen: 640 is the widest `width` any hosted dialog hands
 * `DialogShell` (`CoverChainDialog`), with Auto-Remix and Vocal Chain at 600
 * and Align Lyrics at 560 behind it. Hosting at anything narrower would reflow
 * content laid out against those numbers, and anything wider would buy nothing
 * but stage.
 *
 * M4: this paragraph used to name "the cover chain's stage table" as the content
 * that would break first. That table no longer exists — the journey rewrite
 * removed both of the Cover Chain's multi-column tables — so the example was
 * describing a dialog that had not looked like that for a release. The remix
 * plan's per-run bars are now the widest laid-out content among them and are
 * what a narrower host would break.
 *
 * Which leaves 640 held by the REQUEST rather than by that request's content:
 * `CoverChainDialog` still asks for 640 and `DialogShell` still renders it at
 * 640, so the host must match or crop it — but its own widest row measures about
 * 310 px inside a 578 px content box, i.e. it has headroom to spare. If it is
 * ever re-fitted to what it now draws, this constant follows it down and the
 * stage gets the difference back; the test below derives it either way.
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
 * the negative left margin below. W1: the strip above FOLLOWS it now — the
 * user ruled that the bar and the open module are never unequal, so ModuleStrip
 * renders at this same width while a tool is hosted (right-anchored, so it
 * grows leftward exactly as this card does). The TempoCard beside it keeps the
 * column's own 348. Which is also why the constant is DEFINED in
 * `ModuleStrip.tsx` and only re-exported here: the strip must render at
 * exactly this number, and importing it from this file would drag the nine
 * dialogs into the layout graph. The derivation above is still this host's
 * story, and `PipelineToolHost.test` still pins the value to the widest stage
 * any hosted dialog asks for.
 */
export { TOOL_HOST_WIDTH };

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
