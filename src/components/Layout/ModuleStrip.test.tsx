import { render, screen, fireEvent, within } from '@testing-library/react';
import ModuleStrip, { MODULE_COLUMN_WIDTH, SIDEBAR_TABS } from './ModuleStrip';

/**
 * U1 (layout E2): the rail rotated horizontal. These pin the contracts the
 * packaged smoke and the G4 App tests drive the module column by — the testid,
 * the accessible names, the one-entry-per-module list — plus the one behaviour
 * E2 added: the active entry closes its card, which is what frees the column's
 * width for the waveform.
 */
describe('ModuleStrip', () => {
  it('carries every module entry exactly once, by its accessible name', () => {
    render(<ModuleStrip activeTab="history" onSelect={() => {}} />);
    const strip = screen.getByTestId('sidebar-tabs');
    expect(within(strip).getAllByRole('button')).toHaveLength(SIDEBAR_TABS.length);
    for (const { label } of SIDEBAR_TABS) {
      expect(within(strip).getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('is a horizontal chrome pill at the module column width, in the toolbar band', () => {
    render(<ModuleStrip activeTab="history" onSelect={() => {}} />);
    const strip = screen.getByTestId('sidebar-tabs');
    expect(strip.className).toContain('glass-chrome');
    // Horizontal, not the retired vertical rail.
    expect(strip.className).not.toContain('flex-col');
    expect(strip.style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);
    expect(strip.style.top).toBe('10px');
    expect(strip.style.right).toBe('14px');
  });

  it('marks the active entry pressed and accent-tiled, and no other', () => {
    render(<ModuleStrip activeTab="markers" onSelect={() => {}} />);
    const strip = screen.getByTestId('sidebar-tabs');
    const markers = within(strip).getByRole('button', { name: 'Markers' });
    const history = within(strip).getByRole('button', { name: 'History' });
    expect(markers).toHaveClass('is-active');
    expect(markers).toHaveAttribute('aria-pressed', 'true');
    expect(history).not.toHaveClass('is-active');
    expect(history).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports no active entry when the column carries no card', () => {
    render(<ModuleStrip activeTab={null} onSelect={() => {}} />);
    const strip = screen.getByTestId('sidebar-tabs');
    for (const { label } of SIDEBAR_TABS) {
      expect(within(strip).getByRole('button', { name: label })).toHaveAttribute(
        'aria-pressed',
        'false'
      );
    }
  });

  it('selects an inactive entry', () => {
    const onSelect = jest.fn();
    render(<ModuleStrip activeTab="history" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(onSelect).toHaveBeenCalledWith('files');
  });

  it('CLOSES the card when the ACTIVE entry is clicked (E2: the stage takes the column width)', () => {
    const onSelect = jest.fn();
    render(<ModuleStrip activeTab="history" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('says so in the title of the active entry, and only there', () => {
    render(<ModuleStrip activeTab="history" onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: 'History' }).title).toBe(
      'History — click to close the card'
    );
    expect(screen.getByRole('button', { name: 'Files' }).title).toBe('Files');
  });
});
