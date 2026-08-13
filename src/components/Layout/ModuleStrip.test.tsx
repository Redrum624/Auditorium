import { render, screen, fireEvent, within } from '@testing-library/react';
import ModuleStrip, {
  MODULE_COLUMN_WIDTH,
  MODULE_PANELS,
  PERMANENT_TABS,
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
  const PERMANENT = ['Files', 'Effects', 'Markers', 'History', 'Properties'];

  it('carries the five permanent entries, in order, by accessible name', () => {
    render(<ModuleStrip activeTab="history" hasRemix={false} onSelect={() => {}} />);
    const strip = screen.getByTestId('sidebar-tabs');
    const buttons = within(strip).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(PERMANENT);
    expect(PERMANENT_TABS.map((t) => t.label)).toEqual(PERMANENT);
  });

  // The user's ruling, at the surface it is about: neither is a module, so
  // neither has an icon here. Their panels are untouched and are reached by
  // command (Pipeline > Mix for the positioner, Transcribe for the transcript).
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

  it('shows Remix only once a remix exists, and last in the roster', () => {
    const { rerender } = render(
      <ModuleStrip activeTab="history" hasRemix={false} onSelect={() => {}} />
    );
    const strip = screen.getByTestId('sidebar-tabs');
    expect(within(strip).queryByRole('button', { name: 'Remix' })).toBeNull();

    rerender(<ModuleStrip activeTab="history" hasRemix onSelect={() => {}} />);
    const labels = within(screen.getByTestId('sidebar-tabs'))
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual([...PERMANENT, 'Remix']);
  });

  it('states that roster once, as `stripTabs`, so the strip and App cannot disagree', () => {
    expect(stripTabs(false).map((t) => t.id)).toEqual([
      'files',
      'effects',
      'markers',
      'history',
      'properties',
    ]);
    expect(stripTabs(true).map((t) => t.id)).toEqual([
      'files',
      'effects',
      'markers',
      'history',
      'properties',
      'remix',
    ]);
  });

  // The card's registry is the WIDER list: a panel with no icon is still a
  // panel the card renders, which is the whole point of the split.
  it('keeps every panel in MODULE_PANELS, icons or not', () => {
    expect(MODULE_PANELS.map((p) => p.id)).toEqual([
      'files',
      'effects',
      'markers',
      'history',
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

  // A card CAN be open on a panel the strip draws no icon for (Spatial,
  // Transcript). No entry may claim that card as its own.
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
