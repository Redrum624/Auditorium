import { render, screen, fireEvent, within } from '@testing-library/react';
import ModuleStrip, {
  DEFAULT_PANEL,
  MODULE_COLUMN_WIDTH,
  MODULE_PANELS,
  PERMANENT_TABS,
  TOOL_HOST_WIDTH,
  stripTabs,
} from './ModuleStrip';

/**
 * U1 (layout E2): the rail rotated horizontal. These pin the contracts the
 * packaged smoke and the G4 App tests drive the module column by — the testid,
 * the accessible names, the one-entry-per-module list — plus the one behaviour
 * E2 added: the active entry closes its card, which is what frees the column's
 * width for the waveform.
 *
 * F11-8 split the roster in two. `MODULE_PANELS` is every panel the CARD can
 * render; the strip draws icons for a much smaller set, because the user ruled
 * that "Spatial and Transcript are single tools, they should not be a module.
 * Remix should only appear when a remix is created." So the strip is five
 * permanent entries plus a contextual Remix, and the two single tools are
 * reached through their commands instead.
 */
describe('ModuleStrip', () => {
  // U2: six permanents now — Pipeline joined after Effects, mirroring the menu
  // bar — and the order obeys the user's two rules: Files FIRST, History LAST.
  const PERMANENT = ['Files', 'Effects', 'Pipeline', 'Markers', 'Properties', 'History'];

  // F11: five, where this used to say "every module entry" over a list of eight.
  it('carries the six permanent entries, in order, by accessible name', () => {
    render(<ModuleStrip activeTab="history" hasRemix={false} onSelect={() => {}} />);
    const strip = screen.getByTestId('sidebar-tabs');
    const buttons = within(strip).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(PERMANENT);
    expect(PERMANENT_TABS.map((t) => t.label)).toEqual(PERMANENT);
  });

  // F11: the removal itself — the user's ruling at the surface it is about.
  // Neither is a module, so neither has an icon here. Their panels are
  // untouched and reached by command instead (Effects > Mix — T8 moved it out
  // of Pipeline — for the positioner, Transcribe for the transcript).
  it('draws NO icon for Spatial or Transcript, in either remix state', () => {
    for (const hasRemix of [false, true]) {
      const { unmount } = render(
        <ModuleStrip activeTab={null} hasRemix={hasRemix} onSelect={() => {}} />
      );
      const strip = screen.getByTestId('sidebar-tabs');
      expect(within(strip).queryByRole('button', { name: 'Spatial' })).toBeNull();
      expect(within(strip).queryByRole('button', { name: 'Transcript' })).toBeNull();
      unmount();
    }
  });

  // F11: the user's rule — "Remix should only appear when a remix is created".
  // U2: its SLOT is unmoved — still contextual, still appended after the body
  // entries — but it is no longer last, because History's always-last rule
  // outranks it. So the assertion is an adjacency, not an index.
  it('shows Remix only once a remix exists, still contextual, just before History', () => {
    const { rerender } = render(
      <ModuleStrip activeTab="history" hasRemix={false} onSelect={() => {}} />
    );
    const strip = screen.getByTestId('sidebar-tabs');
    expect(within(strip).queryByRole('button', { name: 'Remix' })).toBeNull();

    rerender(<ModuleStrip activeTab="history" hasRemix onSelect={() => {}} />);
    const labels = within(screen.getByTestId('sidebar-tabs'))
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual([...PERMANENT.slice(0, -1), 'Remix', 'History']);
  });

  /**
   * U2: the two rules the user stated — "make 'Files' default at opening" and
   * "'History' always last" — are pinned as PROPERTIES of the roster, over
   * BOTH remix states, rather than as one hardcoded sequence.
   *
   * The difference matters for the next module. A frozen array says "today's
   * strip is this"; a property says "whatever the strip becomes, Files leads it
   * and History closes it". A future entry appended to `MODULE_PANELS` cannot
   * silently violate either rule without turning one of these red, and the
   * `slot` invariants below are what make that structural instead of hopeful.
   */
  it('opens with Files and closes with History, in either remix state', () => {
    for (const hasRemix of [false, true]) {
      const ids = stripTabs(hasRemix).map((t) => t.id);
      expect(ids[0]).toBe('files');
      expect(ids[ids.length - 1]).toBe('history');
    }
  });

  it('names the app-start card as that same first entry, not a second constant', () => {
    expect(DEFAULT_PANEL).toBe(stripTabs(false)[0].id);
    expect(DEFAULT_PANEL).toBe(stripTabs(true)[0].id);
  });

  it('carries exactly one lead and one trail slot, so neither rule can be doubled', () => {
    expect(MODULE_PANELS.filter((p) => p.slot === 'lead').map((p) => p.id)).toEqual(['files']);
    expect(MODULE_PANELS.filter((p) => p.slot === 'trail').map((p) => p.id)).toEqual(['history']);
  });

  // F11: one roster function, so App and the strip cannot disagree about it.
  // U2: Pipeline joined it, after Effects — the menu bar's own adjacency.
  it('states that roster once, as `stripTabs`, so the strip and App cannot disagree', () => {
    expect(stripTabs(false).map((t) => t.id)).toEqual([
      'files',
      'effects',
      'pipeline',
      'markers',
      'properties',
      'history',
    ]);
    expect(stripTabs(true).map((t) => t.id)).toEqual([
      'files',
      'effects',
      'pipeline',
      'markers',
      'properties',
      'remix',
      'history',
    ]);
  });

  // F11: the card's registry is the WIDER list — a panel with no icon is still
  // a panel the card renders, which is the whole point of the split.
  it('keeps every panel in MODULE_PANELS, icons or not', () => {
    expect(MODULE_PANELS.map((p) => p.id).sort()).toEqual([
      'effects',
      'files',
      'history',
      'markers',
      'pipeline',
      'properties',
      'remix',
      'spatial',
      'transcript',
    ]);
    for (const panel of MODULE_PANELS) {
      expect(typeof panel.label).toBe('string');
      expect(panel.label.length).toBeGreaterThan(0);
    }
  });

  // U2: the strip's roster is exactly "every panel whose slot is not 'none'",
  // so adding a panel to the card registry does not accidentally add an icon.
  it('draws an icon for every panel with a slot, and only those', () => {
    const withSlot = MODULE_PANELS.filter((p) => p.slot !== 'none').map((p) => p.id);
    expect(stripTabs(true).map((t) => t.id).sort()).toEqual([...withSlot].sort());
  });

  it('is a horizontal chrome pill at the module column width, in the toolbar band', () => {
    render(<ModuleStrip activeTab="history" hasRemix={false} onSelect={() => {}} />);
    const strip = screen.getByTestId('sidebar-tabs');
    expect(strip.className).toContain('glass-chrome');
    // Horizontal, not the retired vertical rail.
    expect(strip.className).not.toContain('flex-col');
    expect(strip.style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);
    expect(strip.style.top).toBe('10px');
    expect(strip.style.right).toBe('14px');
  });

  /**
   * W1: the user's rule — "the module bar and the extended modules must always
   * have the same width." The strip follows the open surface: the column's own
   * width with a module card (or nothing) beneath it, the host's width while a
   * pipeline tool is hosted. `right` is pinned either way, so the wider strip
   * grows LEFTWARD exactly as the host card does and both of their edges
   * coincide — never unequal, in either state.
   */
  it('widens to the tool host’s width while a tool is hosted, right edge pinned', () => {
    const { rerender } = render(
      <ModuleStrip activeTab="pipeline" hasRemix={false} toolHosted onSelect={() => {}} />
    );
    const strip = screen.getByTestId('sidebar-tabs');
    expect(strip.style.width).toBe(`${TOOL_HOST_WIDTH}px`);
    expect(strip.style.right).toBe('14px');
    // The same alignment logic at either width: fixed 34px tiles with the air
    // distributed BETWEEN them — the wider bar spreads its gaps, it does not
    // stretch its buttons.
    expect(strip.className).toContain('justify-between');
    for (const button of within(strip).getAllByRole('button')) {
      expect(button.style.width).toBe('34px');
    }

    rerender(<ModuleStrip activeTab="pipeline" hasRemix={false} onSelect={() => {}} />);
    expect(screen.getByTestId('sidebar-tabs').style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);
  });

  it('marks the active entry pressed and accent-tiled, and no other', () => {
    render(<ModuleStrip activeTab="markers" hasRemix={false} onSelect={() => {}} />);
    const strip = screen.getByTestId('sidebar-tabs');
    const markers = within(strip).getByRole('button', { name: 'Markers' });
    const history = within(strip).getByRole('button', { name: 'History' });
    expect(markers).toHaveClass('is-active');
    expect(markers).toHaveAttribute('aria-pressed', 'true');
    expect(history).not.toHaveClass('is-active');
    expect(history).toHaveAttribute('aria-pressed', 'false');
  });

  // F11: a state only reachable since the split — a card CAN be open on a
  // panel the strip draws no icon for (Spatial, Transcript), and no entry may
  // claim that card as its own.
  it('marks nothing pressed while the card shows a panel with no icon', () => {
    render(<ModuleStrip activeTab="spatial" hasRemix onSelect={() => {}} />);
    const strip = screen.getByTestId('sidebar-tabs');
    for (const button of within(strip).getAllByRole('button')) {
      expect(button).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('reports no active entry when the column carries no card', () => {
    render(<ModuleStrip activeTab={null} hasRemix onSelect={() => {}} />);
    const strip = screen.getByTestId('sidebar-tabs');
    for (const { label } of stripTabs(true)) {
      expect(within(strip).getByRole('button', { name: label })).toHaveAttribute(
        'aria-pressed',
        'false'
      );
    }
  });

  it('selects an inactive entry', () => {
    const onSelect = jest.fn();
    render(<ModuleStrip activeTab="history" hasRemix={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(onSelect).toHaveBeenCalledWith('files');
  });

  it('CLOSES the card when the ACTIVE entry is clicked (E2: the stage takes the column width)', () => {
    const onSelect = jest.fn();
    render(<ModuleStrip activeTab="history" hasRemix={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('says so in the title of the active entry, and only there', () => {
    render(<ModuleStrip activeTab="history" hasRemix={false} onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: 'History' }).title).toBe(
      'History — click to close the card'
    );
    expect(screen.getByRole('button', { name: 'Files' }).title).toBe('Files');
  });
});
