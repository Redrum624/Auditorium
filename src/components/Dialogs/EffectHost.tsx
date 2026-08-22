import { useCallback } from 'react';
import { getEffect } from '../../effects/EffectRegistry';
import { MODULE_COLUMN_WIDTH } from '../Layout/ModuleStrip';
import { GlassCard } from '../UI/glass';
import { DialogHostProvider } from './DialogHost';
import EffectDialog from './EffectDialog';

/**
 * Item 6 (2026-08-18) / M6 — the card that hosts ONE effect in the module
 * column, between the module strip (and the TempoCard) and the module card.
 *
 * The user's ruling: "all effects open with a single click and, instead of a
 * modal, open between the module bar and the extended modules." The seam
 * already existed — `DialogShell` renders as in-flow card chrome whenever a
 * `DialogHostProvider` sits above it (U2-3), which is how the nine pipeline
 * tools left their modals without a line of their own changing. This is the
 * same seam with the same provider, and `EffectDialog` is unchanged in body.
 *
 * What differs from `PipelineToolHost`, and why. That host is 640 wide and
 * pulls itself LEFT out of the 348 column with a negative margin, because a
 * pipeline stepper needs the room; the strip follows it to 640 (W1). An
 * effect's body fits the column, so this card is exactly `MODULE_COLUMN_WIDTH`
 * with no margin — the strip stays 348 and W1 holds in every state without the
 * strip learning a third width. No `max-height` either: the column's bounded
 * height (`top 68` / `bottom 58`) is the only cap, shared with the module card
 * beneath through the default `flex: 0 1 auto` shrink, and the hosted shell's
 * body scrolls inside the card.
 *
 * The card is independent of the module card below it: App forces that card to
 * Effects when an effect opens (N16), and afterwards the strip may swap or
 * close it while the effect stays. Only another host (`openTool`), the ✕ /
 * Cancel / Apply, and the orphan rule (no document left) close this one.
 *
 * One effect id, one dialog instance. `PipelineToolHost` swaps the component
 * TYPE per command id, so React remounts on a swap for free; this host renders
 * the same `EffectDialog` for every id, and React would keep the mounted
 * instance — with the previous effect's `params`, `previewing` and `busy`
 * state — under the new name (every control of the new effect NaN, Apply
 * sending values the card never showed, a preview of the first effect still
 * playing under the second's name). The key on the dialog is what makes a
 * click on a second row a fresh card: the old dialog unmounts (its
 * unmount-restore hands the engine the real document back) and the new one
 * starts from its own declared defaults.
 */
export default function EffectHost({
  effectId,
  onClose,
  onModuleLockChange,
}: {
  /** A registry effect id; nothing renders for an id the registry does not know. */
  effectId: string;
  onClose(): void;
  /** Raised with the effect's module LOCK — `true` while Apply is running
   * (N16: Apply only; Preview locks nothing). App turns that into a greyed
   * module strip and a live `hasOpenDialog()`, released by the shell's own
   * cleanup on unmount. */
  onModuleLockChange(locked: boolean): void;
}) {
  // Stable identity, so the provider's memo does not re-publish per paint.
  const report = useCallback(
    (locked: boolean) => onModuleLockChange(locked),
    [onModuleLockChange]
  );
  if (!getEffect(effectId)) return null;

  return (
    <GlassCard
      data-testid="effect-host"
      data-effect-id={effectId}
      className="pointer-events-auto flex min-h-0 flex-col"
      style={{ flex: '0 1 auto', overflow: 'hidden', width: MODULE_COLUMN_WIDTH }}
    >
      <DialogHostProvider onModuleLockChange={report}>
        <EffectDialog key={effectId} effectId={effectId} onClose={onClose} />
      </DialogHostProvider>
    </GlassCard>
  );
}
