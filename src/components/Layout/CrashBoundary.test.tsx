import { render, screen, fireEvent, act } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import CrashBoundary, { describeError, isBenignGlobalError } from './CrashBoundary';
import { reloadWindow } from '../../services/appReload';

jest.mock('../../services/appReload', () => ({ reloadWindow: jest.fn() }));

const mockReload = reloadWindow as jest.MockedFunction<typeof reloadWindow>;

/**
 * T4 — the crash surface.
 *
 * The motivating incident is in this repo's own history: a renderer exception
 * (React 19's dev performance track raising DataCloneError) left the app
 * PERMANENTLY FROZEN with nothing on screen to say so. The app had no error
 * boundary and no global handlers, so an exception anywhere in a render pass
 * unmounted the tree to a blank window, and an exception outside React went
 * nowhere at all.
 *
 * Everything below drives a real throw. A boundary asserted by inspection is a
 * boundary nobody has watched catch anything.
 */

/** Throws on render, on demand. The only honest way to test a boundary. */
function Boom({ when = true, message = 'render exploded' }: { when?: boolean; message?: string }) {
  if (when) throw new Error(message);
  return <div data-testid="app-alive">the app</div>;
}

/** React logs caught errors through console.error; the noise is not the
 * subject. Silenced per test rather than globally so an UNEXPECTED console
 * error still shows up in the run. */
function silenceReactErrorLog() {
  return jest.spyOn(console, 'error').mockImplementation(() => {});
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the React boundary', () => {
  it('replaces the broken tree with a card instead of a blank window', () => {
    const log = silenceReactErrorLog();
    render(
      <CrashBoundary>
        <Boom message="clip decode exploded" />
      </CrashBoundary>
    );

    expect(screen.getByTestId('crash-card')).toBeInTheDocument();
    expect(screen.queryByTestId('app-alive')).not.toBeInTheDocument();
    // The three things the card owes the user: what happened, what to do about
    // their work, and a way out.
    expect(screen.getByTestId('crash-detail').textContent).toContain('clip decode exploded');
    expect(screen.getByTestId('crash-card').textContent).toMatch(/save your work/i);
    expect(screen.getByTestId('crash-reload')).toBeInTheDocument();
    log.mockRestore();
  });

  it('the error text can be selected, against a body that forbids selection', () => {
    // `src/index.css` sets `body { user-select: none }` for the whole app, which
    // is right for a timeline and wrong for the one screen whose text the user
    // needs to copy into a bug report. Without this the message is readable and
    // untransferable.
    const log = silenceReactErrorLog();
    render(
      <CrashBoundary>
        <Boom />
      </CrashBoundary>
    );
    expect(screen.getByTestId('crash-detail')).toHaveStyle({ userSelect: 'text' });
    log.mockRestore();
  });

  it('Reload reloads the window, and does nothing else', () => {
    const log = silenceReactErrorLog();
    render(
      <CrashBoundary>
        <Boom />
      </CrashBoundary>
    );
    fireEvent.click(screen.getByTestId('crash-reload'));
    expect(mockReload).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it('…and that reload really is `location.reload()`, not a mock all the way down', () => {
    // The seam above is mocked, so the button's behaviour is only as true as
    // what the real module does. jsdom makes `window.location` AND
    // `location.reload` non-configurable, so this is the honest way to close
    // the loop: assert the one line the seam exists to hide.
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'services', 'appReload.ts'),
      'utf8'
    );
    expect(source).toMatch(/export function reloadWindow\(\)[^{]*\{\s*window\.location\.reload\(\);\s*\}/);
  });

  it('a render crash is NOT dismissible — there is nothing to go back to', () => {
    // The global arm below is dismissible because the app is still standing.
    // Here React has unmounted the tree; a Dismiss button would offer a blank
    // window as the alternative to the card explaining it.
    const log = silenceReactErrorLog();
    render(
      <CrashBoundary>
        <Boom />
      </CrashBoundary>
    );
    expect(screen.queryByTestId('crash-dismiss')).not.toBeInTheDocument();
    log.mockRestore();
  });

  it('renders its children untouched when nothing throws', () => {
    render(
      <CrashBoundary>
        <Boom when={false} />
      </CrashBoundary>
    );
    expect(screen.getByTestId('app-alive')).toBeInTheDocument();
    expect(screen.queryByTestId('crash-card')).not.toBeInTheDocument();
  });
});

describe('the global arm: exceptions React never sees', () => {
  function fireGlobalError(message: string) {
    act(() => {
      window.dispatchEvent(
        new ErrorEvent('error', { message, error: new Error(message) })
      );
    });
  }

  function fireRejection(reason: unknown) {
    act(() => {
      // jsdom does not implement PromiseRejectionEvent; the listener reads
      // `.reason`, which is the only part of the shape that matters here.
      const event = new Event('unhandledrejection') as Event & { reason?: unknown };
      event.reason = reason;
      window.dispatchEvent(event);
    });
  }

  it('surfaces the same card for an uncaught error, over an app that is still standing', () => {
    render(
      <CrashBoundary>
        <Boom when={false} />
      </CrashBoundary>
    );
    fireGlobalError('worker died mid-render');

    expect(screen.getByTestId('crash-card')).toBeInTheDocument();
    expect(screen.getByTestId('crash-detail').textContent).toContain('worker died mid-render');
    // The app is NOT torn down: nothing about an exception outside React says
    // the React tree is broken, and throwing away a session over one would be a
    // worse outcome than the exception.
    expect(screen.getByTestId('app-alive')).toBeInTheDocument();
  });

  it('surfaces it for an unhandled rejection too', () => {
    render(
      <CrashBoundary>
        <Boom when={false} />
      </CrashBoundary>
    );
    fireRejection(new Error('stem separation promise rejected'));

    expect(screen.getByTestId('crash-detail').textContent).toContain(
      'stem separation promise rejected'
    );
  });

  it('…including a rejection with a non-Error reason, which is where a naive read throws', () => {
    render(
      <CrashBoundary>
        <Boom when={false} />
      </CrashBoundary>
    );
    fireRejection({ code: 17 });
    expect(screen.getByTestId('crash-card')).toBeInTheDocument();
    expect(screen.getByTestId('crash-detail').textContent).toMatch(/17/);
  });

  it('…and it does not freeze the app it just said is still standing', () => {
    // The card the fatal arm shows takes the screen, because there is nothing
    // behind it. This one must NOT: a full-screen modal over a working editor
    // blocks every gesture until acknowledged, which is a milder version of the
    // wedge this whole component exists to end — and it would stop a packaged
    // walker run dead on a notice that was never fatal.
    render(
      <CrashBoundary>
        <Boom when={false} />
      </CrashBoundary>
    );
    fireGlobalError('a background job died');

    const card = screen.getByTestId('crash-card');
    expect(card).toHaveAttribute('data-variant', 'notice');
    expect(card).toHaveStyle({ pointerEvents: 'none', background: 'transparent' });
    // …while the card itself stays clickable, or Dismiss would be scenery.
    expect(screen.getByTestId('crash-dismiss').closest('div')).toHaveStyle({
      pointerEvents: 'auto',
    });
  });

  it('the FATAL card, by contrast, does take the screen', () => {
    const log = silenceReactErrorLog();
    render(
      <CrashBoundary>
        <Boom />
      </CrashBoundary>
    );
    const card = screen.getByTestId('crash-card');
    expect(card).toHaveAttribute('data-variant', 'fatal');
    expect(card).toHaveStyle({ pointerEvents: 'auto' });
    expect(card).not.toHaveStyle({ background: 'transparent' });
    log.mockRestore();
  });

  it('that card IS dismissible, and dismissing leaves the app running', () => {
    render(
      <CrashBoundary>
        <Boom when={false} />
      </CrashBoundary>
    );
    fireGlobalError('one bad timer');
    fireEvent.click(screen.getByTestId('crash-dismiss'));

    expect(screen.queryByTestId('crash-card')).not.toBeInTheDocument();
    expect(screen.getByTestId('app-alive')).toBeInTheDocument();
  });

  it('ignores the ResizeObserver loop notice, which Chromium reports as an error', () => {
    // Not a crash and not this app's doing: Chromium raises it whenever an
    // observer callback changes layout, which is what every canvas in this app
    // does on resize (ten components use ResizeObserver). Surfacing a crash card
    // for it would put a fatal-looking dialog over a perfectly healthy app on an
    // ordinary window resize — and would fail every packaged walker run.
    render(
      <CrashBoundary>
        <Boom when={false} />
      </CrashBoundary>
    );
    fireGlobalError('ResizeObserver loop completed with undelivered notifications.');
    fireGlobalError('ResizeObserver loop limit exceeded');

    expect(screen.queryByTestId('crash-card')).not.toBeInTheDocument();
  });

  it('the suppression is that class and no other', () => {
    // Guards the guard: an over-broad filter would silently restore the wedge
    // this whole feature exists to end.
    expect(isBenignGlobalError('ResizeObserver loop limit exceeded')).toBe(true);
    expect(isBenignGlobalError('Cannot read properties of null')).toBe(false);
    expect(isBenignGlobalError('ResizeObserver is not defined')).toBe(false);
    expect(isBenignGlobalError('')).toBe(false);
  });

  it('unregisters its listeners when it goes away', () => {
    // A boundary that leaks a window listener per mount is a leak in the one
    // component whose whole job is to make failure visible.
    const { unmount } = render(
      <CrashBoundary>
        <Boom when={false} />
      </CrashBoundary>
    );
    const before = jest.spyOn(window, 'removeEventListener');
    unmount();
    const removed = before.mock.calls.map((c) => c[0]);
    expect(removed).toContain('error');
    expect(removed).toContain('unhandledrejection');
  });
});

describe('describeError', () => {
  it('reads an Error, a string and an object without throwing on any of them', () => {
    // The handler runs INSIDE the failure path. A `describeError` that can
    // itself throw turns one exception into an infinite one.
    expect(describeError(new Error('boom')).message).toBe('boom');
    expect(describeError(new Error('boom')).detail).toMatch(/boom/);
    expect(describeError('a bare string').message).toBe('a bare string');
    expect(describeError({ code: 17 }).detail).toMatch(/17/);
    expect(describeError(null).message.length).toBeGreaterThan(0);
    expect(describeError(undefined).message.length).toBeGreaterThan(0);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeError(circular)).not.toThrow();
  });
});

describe('it is actually mounted', () => {
  it('wraps the whole app in main.tsx', () => {
    // A boundary that exists and is not in the tree is worse than none: it
    // reads, in review and in a report, as coverage. main.tsx cannot be
    // imported here (it calls createRoot against a real #root), so its source
    // is the assertion — the same approach splash.test.cjs takes to main.cjs.
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'main.tsx'), 'utf8');
    expect(source).toMatch(/import CrashBoundary from '\.\/components\/Layout\/CrashBoundary'/);
    expect(source).toMatch(/<CrashBoundary>\s*<App \/>\s*<\/CrashBoundary>/);
  });
});

describe('the card reports nowhere but the screen', () => {
  it('contains no network call of any kind', () => {
    // Explicit requirement, and the one a crash reporter is most likely to grow
    // by accident. Asserted against the source because the point is that no such
    // path EXISTS, not that it went unused in one run.
    const source = fs.readFileSync(
      path.join(__dirname, 'CrashBoundary.tsx'),
      'utf8'
    );
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'import(']) {
      expect([forbidden, source.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });
});
