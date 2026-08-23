// U2: the Pipeline menu's tools, grouped — derived from the menu itself.
//
// One surface lists these tools: the Pipeline module card. (U2 had a second,
// the Effects card's tool rows of F11-6; item 5 of the 2026-08-18 program
// removed it — a Pipeline tool lives in the Pipeline module only.) Before this
// module the Effects card held its own hardcoded id list, which happened to
// match the menu exactly; a second copy would have made the lists free to
// disagree, and the first tool to move group would have moved on one surface
// only.
//
// So MEMBERSHIP and ORDER are read from `menuActions`' Pipeline section at call
// time — a command added to that section appears on the card with no edit
// here, exactly as `getMenuSections()` resolves labels live. The group
// NAMES are the one thing that cannot be derived: the menu marks its groups
// with bare separators, which carry no name. They are written below, once.

import { getMenuSections } from './menuActions';

/**
 * The Pipeline menu's three separator-delimited groups, in menu order. Written,
 * not derived — a separator has no name to read. Kept as a list rather than a
 * map so it pairs with the menu's runs positionally: the menu decides how many
 * groups there are and what is in them, this decides what they are called.
 * (T8 removed the fourth, 'Mix': the user moved `spatial.position` to the
 * Effects menu, and its group went with it — `EffectsPanel` writes the Mix
 * name now, for its own card alone, and that Mix row is the only tool row the
 * Effects card still draws.)
 */
export const PIPELINE_GROUP_TITLES: readonly string[] = [
  'Tempo & Timing',
  'Voice',
  'Analysis',
];

export interface PipelineToolRow {
  id: string;
  label: string;
}

export interface PipelineGroup {
  /** `null` when the menu has grown a group past `PIPELINE_GROUP_TITLES`. The
   * rows still render; inventing a name for them would be worse than drawing
   * them unlabelled, and a missing heading is visible where a wrong one is not. */
  title: string | null;
  commands: PipelineToolRow[];
}

/**
 * The Pipeline menu's rows, split on its own separators and named.
 *
 * Rebuilt per call, for the reason `EffectsPanel.effectsMenuTools` gives: the
 * registry resolves live, so anything cached here would be a stale copy of a
 * list that is cheap to rebuild (one pass over one menu section).
 *
 * An id in the layout that the registry does NOT know comes back from
 * `fallbackCommand` labelled with the id itself. Such a row could never run
 * (`runCommand` no-ops on it) and would show a raw id as its name, so it is
 * dropped — but its GROUP is not, so dropping one cannot shift the remaining
 * groups' names by one.
 */
export function getPipelineGroups(): PipelineGroup[] {
  const section = getMenuSections().find((s) => s.title === 'Pipeline');
  if (!section) return [];

  const runs: PipelineToolRow[][] = [[]];
  for (const item of section.items) {
    if (item === 'separator') {
      runs.push([]);
      continue;
    }
    // `label === id` is `fallbackCommand`'s placeholder for an unregistered id.
    if (item.label !== item.id) runs[runs.length - 1].push({ id: item.id, label: item.label });
  }

  return runs.map((commands, i) => ({
    title: PIPELINE_GROUP_TITLES[i] ?? null,
    commands,
  }));
}
