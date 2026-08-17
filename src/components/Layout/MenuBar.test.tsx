import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MenuBar from './MenuBar';
import { registerAllEffects } from '../../effects/registerAll';
import { getMenuSections, registerEffectCommands } from '../../services/menuActions';
// Namespace import as well, so `runCommand` can be spied: MenuBar calls it
// through the module object under ts-jest's CommonJS output.
import * as menuActions from '../../services/menuActions';

describe('MenuBar', () => {
  // F11-7 made this six: Pipeline joined the bar, after Effects.
  it('renders a button for each of the 6 sections, in the menu’s own order', () => {
    render(<MenuBar />);
    for (const title of ['File', 'Edit', 'Effects', 'Pipeline', 'View', 'Help']) {
      expect(screen.getByRole('button', { name: title })).toBeInTheDocument();
    }
    // The bar renders the sections the service publishes, in that order — not a
    // second list that can drift from it.
    const bar = screen.getByRole('button', { name: 'File' }).closest('div')!.parentElement!;
    const rendered = Array.from(bar.querySelectorAll('button.chrome-menu-btn')).map(
      (b) => b.textContent
    );
    expect(rendered).toEqual(getMenuSections().map((s) => s.title));
  });

  it('opens the File dropdown on click and lists Open…', () => {
    render(<MenuBar />);
    expect(screen.queryByText('Open…')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'File' }));

    expect(screen.getByText('Open…')).toBeInTheDocument();
  });

  it('marks an item that needs an active document as disabled', () => {
    render(<MenuBar />);
    fireEvent.click(screen.getByRole('button', { name: 'File' }));

    // Export requires an active document; with none open it is disabled.
    const exportItem = screen.getByRole('button', { name: /Export…/ });
    expect(exportItem).toBeDisabled();
  });

  it('closes the dropdown on Escape', () => {
    render(<MenuBar />);
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    expect(screen.getByText('Open…')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByText('Open…')).not.toBeInTheDocument();
  });

  it('styles the top-level menu buttons as chrome items (G2)', () => {
    render(<MenuBar />);
    expect(screen.getByRole('button', { name: 'File' }).className).toContain('chrome-menu-btn');
  });

  it('closes the dropdown on outside click', () => {
    render(
      <div>
        <div data-testid="outside">outside</div>
        <MenuBar />
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    expect(screen.getByText('Open…')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId('outside'));

    expect(screen.queryByText('Open…')).not.toBeInTheDocument();
  });
});

// F11-5. The bug the user reported: opening Effects "create[s] a new space at
// the bottom of the app in electron pushing everything else up". The dropdown
// was `position: absolute` inside the titlebar, so it never changed any
// ancestor's LAYOUT box — but nothing between it and the viewport sets
// `overflow: hidden` (html/body/#root are height:100% and visible), so a panel
// taller than the window extended the DOCUMENT's scrollable overflow region and
// made the whole app scrollable. That scroll is the "new space at the bottom".
//
// The fix has two halves and this suite pins both:
//   1. the panel is portalled OUT of the app tree to document.body and
//      positioned `fixed`, so it can never be in any app container's flow OR
//      its scroll region (a fixed box generates no document scrollbar);
//   2. it is clamped to the room actually below the bar and scrolls itself.
describe('MenuBar dropdown overlay (F11-5)', () => {
  const REAL_INNER_HEIGHT = window.innerHeight;

  function setViewportHeight(px: number): void {
    Object.defineProperty(window, 'innerHeight', {
      value: px,
      configurable: true,
      writable: true,
    });
  }

  afterEach(() => {
    setViewportHeight(REAL_INNER_HEIGHT);
    jest.restoreAllMocks();
  });

  /** The title of whichever section currently has the most rows — the menu the
   * user hit this on. Derived, so it follows the menu rather than naming one. */
  function longestSectionTitle(): string {
    registerAllEffects();
    registerEffectCommands();
    return getMenuSections().reduce((a, b) => (b.items.length > a.items.length ? b : a)).title;
  }

  function openLongest(): HTMLElement {
    const title = longestSectionTitle();
    fireEvent.click(screen.getByRole('button', { name: title }));
    return screen.getByTestId('menu-dropdown');
  }

  it('the longest menu really is long enough for this to matter', () => {
    const title = longestSectionTitle();
    const longest = getMenuSections().find((s) => s.title === title)!;
    // Each row is 12px text in 6px/6px padding ≈ 27px, so 30 rows is ~810px of
    // panel — taller than the space under the bar in any window under ~850px.
    expect(longest.items.length).toBeGreaterThanOrEqual(30);
  });

  it('opening it adds NOTHING inside the app container', () => {
    render(
      <div data-testid="app-root">
        <MenuBar />
      </div>
    );
    const root = screen.getByTestId('app-root');
    const nodesBefore = root.querySelectorAll('*').length;

    const dropdown = openLongest();

    expect(root.querySelectorAll('*').length).toBe(nodesBefore);
    expect(root.contains(dropdown)).toBe(false);
    expect(dropdown.parentElement).toBe(document.body);
  });

  it('positions the panel fixed to the viewport, not absolute inside the chrome', () => {
    render(<MenuBar />);
    const dropdown = openLongest();

    expect(dropdown.style.position).toBe('fixed');
    expect(dropdown.style.overflowY).toBe('auto');
  });

  it('clamps its height to the room left under the bar, at a small window height', () => {
    setViewportHeight(320);
    render(<MenuBar />);

    const dropdown = openLongest();

    // 320px window, bar bottom at 0 in jsdom, 8px of air kept at the frame.
    expect(dropdown.style.maxHeight).toBe('312px');
  });

  it('re-derives that clamp from the window rather than hardcoding one', () => {
    setViewportHeight(900);
    render(<MenuBar />);

    expect(openLongest().style.maxHeight).toBe('892px');
  });

  it('subtracts the menu bar it hangs from, so the clamp is the room BELOW it', () => {
    setViewportHeight(500);
    jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 64, top: 0, bottom: 36, right: 100, width: 36, height: 36 } as DOMRect);
    render(<MenuBar />);

    const dropdown = openLongest();

    expect(dropdown.style.top).toBe('36px');
    expect(dropdown.style.left).toBe('64px');
    expect(dropdown.style.maxHeight).toBe('456px'); // 500 - 36 - 8
  });

  it('never clamps below a usable minimum, however short the window', () => {
    setViewportHeight(40);
    render(<MenuBar />);

    expect(openLongest().style.maxHeight).toBe('96px');
  });

  it('still runs an item clicked inside the portalled panel', () => {
    render(<MenuBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    const about = screen.getByRole('button', { name: 'About Auditorium' });

    // The outside-click guard closes on any mousedown outside the bar's own
    // subtree; the panel now lives outside it, so without a second containment
    // check the menu would close before the click ever landed.
    fireEvent.mouseDown(about);

    expect(screen.getByRole('button', { name: 'About Auditorium' })).toBeInTheDocument();
  });

  // F11 fix round (I4): the suite above proves the panel is positioned,
  // clamped, scrollable and not closed by its own mousedown — and every one of
  // those survived deleting the item's `onClick` entirely. A menu that renders
  // perfectly and does nothing is the failure this file could not see.
  it('RUNS the clicked item’s command, and closes the menu afterwards', async () => {
    const run = jest.spyOn(menuActions, 'runCommand').mockResolvedValue(undefined);
    try {
      render(<MenuBar />);
      fireEvent.click(screen.getByRole('button', { name: 'Help' }));

      fireEvent.click(screen.getByRole('button', { name: 'About Auditorium' }));

      expect(run).toHaveBeenCalledWith('help.about');
      // ...and the dropdown is gone, so the next click goes to the app rather
      // than to a menu still hanging over it.
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'About Auditorium' })).not.toBeInTheDocument()
      );
    } finally {
      run.mockRestore();
    }
  });

  it('routes a DISABLED item nowhere — the predicate is the menu’s, not a style', () => {
    const run = jest.spyOn(menuActions, 'runCommand').mockResolvedValue(undefined);
    try {
      render(<MenuBar />);
      fireEvent.click(screen.getByRole('button', { name: 'File' }));
      // Export needs an active document; this suite opens none. (Matched by
      // regex because a row's accessible name includes its shortcut label.)
      const exportItem = screen.getByRole('button', { name: /Export…/ });
      expect(exportItem).toBeDisabled();

      fireEvent.click(exportItem);

      expect(run).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });
});
