import { getMenuSections, registerCommands } from './menuActions';
import { PIPELINE_GROUP_TITLES, getPipelineGroups } from './pipelineTools';

/**
 * U2: the Pipeline module's card and the Effects card's tool rows both list the
 * Pipeline MENU's tools, and this is the one place that derives them.
 *
 * What is derived and what is written, stated once: MEMBERSHIP and ORDER come
 * from `LAYOUT`'s Pipeline section — a command added there appears on both
 * cards with no edit here — while the four group NAMES are written, because the
 * menu's separators carry no name to read. That split is the whole reason this
 * module exists rather than a second hardcoded id list per panel, which is what
 * `EffectsPanel` had and what would have silently disagreed with the menu the
 * first time a tool moved group.
 */
describe('pipelineTools', () => {
  function menuPipelineIds(): string[][] {
    const section = getMenuSections().find((s) => s.title === 'Pipeline')!;
    const runs: string[][] = [[]];
    for (const item of section.items) {
      if (item === 'separator') runs.push([]);
      else runs[runs.length - 1].push(item.id);
    }
    return runs;
  }

  it('splits the Pipeline menu on its own separators, in menu order', () => {
    expect(getPipelineGroups().map((g) => g.commands.map((c) => c.id))).toEqual(menuPipelineIds());
  });

  it('names the groups Tempo & Timing / Voice / Analysis / Mix, in that order', () => {
    expect(getPipelineGroups().map((g) => g.title)).toEqual([...PIPELINE_GROUP_TITLES]);
  });

  it('reads each label off the registry rather than restating it', () => {
    const original = getMenuSections()
      .find((s) => s.title === 'Pipeline')!
      .items.find((i) => i !== 'separator' && i.id === 'tempo.detect')!;
    if (original === 'separator') throw new Error('unreachable');
    try {
      registerCommands([{ ...original, label: 'Detect Tempo (renamed)' }]);
      const labels = getPipelineGroups().flatMap((g) => g.commands.map((c) => c.label));
      expect(labels).toContain('Detect Tempo (renamed)');
    } finally {
      registerCommands([original]);
    }
  });

  /**
   * `fallbackCommand` labels an unregistered id with the id itself. A row for
   * one could never run (`runCommand` no-ops) and would show a raw id as its
   * name — EffectsPanel's own rule, moved here so both cards obey it.
   *
   * The first version of this test only walked the live groups asserting
   * `label !== id`, which every registered command satisfies anyway: deleting
   * the filter left it green. So the unregistered state has to be produced.
   * `LAYOUT` is module-private and there is no unregister, but the filter's
   * input does not care how the shape arose — registering a command whose label
   * IS its id hands `getPipelineGroups` exactly the object `fallbackCommand`
   * would have handed it for a missing id, which is the boundary the filter
   * actually tests.
   */
  it('drops an id the registry does not know, keeping its group and its siblings', () => {
    const victim = getPipelineGroups()[1].commands[0];
    const groupTitle = getPipelineGroups()[1].title;
    const siblingsBefore = getPipelineGroups()[1].commands.map((c) => c.id);
    expect(siblingsBefore.length).toBeGreaterThan(1);

    const original = getMenuSections()
      .find((s) => s.title === 'Pipeline')!
      .items.find((i) => i !== 'separator' && i.id === victim.id)!;
    if (original === 'separator') throw new Error('unreachable');

    try {
      // Exactly `fallbackCommand(id)`'s shape: label === id, never enabled.
      registerCommands([{ id: victim.id, label: victim.id, enabled: () => false, run: () => {} }]);
      const groups = getPipelineGroups();

      // The row is gone…
      const ids = groups.flatMap((g) => g.commands.map((c) => c.id));
      expect(ids).not.toContain(victim.id);
      // …and no row anywhere is labelled with its own id.
      for (const group of groups) {
        for (const cmd of group.commands) expect(cmd.label).not.toBe(cmd.id);
      }
      // …while its GROUP survives, keeping its name and its other rows, so
      // dropping one row cannot shift the remaining groups' titles by one.
      expect(groups).toHaveLength(PIPELINE_GROUP_TITLES.length);
      expect(groups[1].title).toBe(groupTitle);
      expect(groups[1].commands.map((c) => c.id)).toEqual(
        siblingsBefore.filter((id) => id !== victim.id)
      );
    } finally {
      registerCommands([original]);
    }

    // Restored: the walk is back to its full roster.
    expect(getPipelineGroups()[1].commands.map((c) => c.id)).toEqual(siblingsBefore);
  });
});
