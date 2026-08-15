import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCw, X } from 'lucide-react';
import { reloadWindow } from '../../services/appReload';

/**
 * The crash surface (T4).
 *
 * The app had none. The motivating incident is in this repo's own history: a
 * renderer exception — React 19's dev performance track raising a
 * DataCloneError — left the app PERMANENTLY FROZEN, with nothing on screen to
 * say what had happened or to offer a way out. React unmounts the whole tree
 * when a render throws and no boundary catches it, so the failure mode was a
 * blank window; an exception raised outside React went nowhere at all.
 *
 * Two arms, deliberately not symmetric:
 *
 *   * **The React boundary.** A render or lifecycle throw means the tree is
 *     gone. The card REPLACES the app, and its only action is Reload — there is
 *     no intact app behind it to dismiss back to.
 *   * **`error` / `unhandledrejection`.** An exception outside React says
 *     nothing about the React tree; the app is usually still standing and the
 *     session in it is still worth something. The same card is shown OVER the
 *     app and can be dismissed, so a failed background job cannot cost a user
 *     their unsaved work.
 *
 * It reports nowhere but the screen: no telemetry, no network, no
 * file writing. What it does is tell the user the truth and let them copy it —
 * the error text is explicitly selectable, because `body { user-select: none }`
 * in index.css is right for a timeline and wrong for the one screen whose text
 * belongs in a bug report.
 */

/** What a thrown value is, in the two forms the card shows: a one-line summary
 * and the fullest text available (a stack, when there is one).
 *
 * Total by construction. This runs INSIDE the failure path, so a version that
 * can throw turns one exception into a loop. Every branch is reachable: the
 * global arm receives whatever was thrown or rejected, which is frequently not
 * an Error. */
export function describeError(err: unknown): { message: string; detail: string } {
  if (err instanceof Error) {
    const message = err.message || err.name || 'Error';
    return { message, detail: err.stack || `${err.name}: ${message}` };
  }
  if (typeof err === 'string' && err.length > 0) return { message: err, detail: err };
  if (err === null) return { message: 'null was thrown', detail: 'null was thrown' };
  if (err === undefined) {
    return { message: 'undefined was thrown', detail: 'undefined was thrown' };
  }
  let detail: string;
  try {
    detail = JSON.stringify(err) ?? String(err);
  } catch {
    // Circular, or a getter that throws. String() is the fallback that cannot.
    detail = String(err);
  }
  return { message: detail.slice(0, 200), detail };
}

/**
 * The one class of `error` event that is not a crash.
 *
 * Chromium raises "ResizeObserver loop …" whenever an observer callback changes
 * layout — which is what every canvas in this app does when its lane resizes;
 * ten components use ResizeObserver. It is a notification that a layout pass
 * was deferred, not an exception, and nothing is broken when it arrives. A card
 * over a healthy app on an ordinary window resize would be worse than no card
 * at all, and would fail every packaged walker run.
 *
 * Matched on the LOOP messages specifically, not on the word ResizeObserver:
 * `ResizeObserver is not defined` is a genuine crash and must still surface.
 */
export function isBenignGlobalError(message: string): boolean {
  return /^(uncaught\s+)?resizeobserver loop\b/i.test(message.trim());
}

export interface CrashInfo {
  /** Where it came from, so the card can say something true about it. */
  origin: 'render' | 'error' | 'rejection';
  message: string;
  detail: string;
}

const ORIGIN_TEXT: Record<CrashInfo['origin'], string> = {
  render: 'The editor hit an error while drawing and had to stop.',
  error: 'Something in the app threw an error that nothing was waiting for.',
  rejection: 'A background job failed and nothing was waiting to hear about it.',
};

/**
 * One card, two placements — and the difference is the honest part.
 *
 * `fatal` takes the screen, because there is nothing behind it: React has
 * unmounted the tree.
 *
 * `notice` does NOT. The app behind an uncaught background exception is still
 * standing, and a full-screen modal over a working editor would freeze it until
 * acknowledged — a milder version of the exact failure this component exists to
 * end. So the wrapper takes no pointer events and paints no backdrop: the card
 * sits in the corner, over an app the user can keep using mid-drag, and only the
 * card itself is clickable.
 */
function CrashCard({
  info,
  onDismiss,
  variant,
}: {
  info: CrashInfo;
  onDismiss?: () => void;
  variant: 'fatal' | 'notice';
}) {
  const fatal = variant === 'fatal';
  return (
    <div
      data-testid="crash-card"
      data-variant={variant}
      role="alertdialog"
      aria-label="Something went wrong"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: fatal ? 'center' : 'flex-end',
        justifyContent: fatal ? 'center' : 'flex-end',
        padding: 24,
        background: fatal ? 'rgba(10,10,12,0.82)' : 'transparent',
        pointerEvents: fatal ? 'auto' : 'none',
      }}
    >
      <div
        style={{
          pointerEvents: 'auto',
          width: fatal ? 'min(560px, 100%)' : 'min(420px, 100%)',
          maxHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: 20,
          borderRadius: 'var(--radius-card, 20px)',
          border: '1px solid var(--glass-border, rgba(255,255,255,0.08))',
          background: 'var(--glass-bg, rgba(15,15,19,0.95))',
          boxShadow: 'var(--glass-shadow, 0 24px 64px rgba(0,0,0,0.5))',
          color: 'var(--glass-text-label, #d4d4d8)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangle size={16} color="#f2b93b" />
          <span
            style={{ fontSize: 14, fontWeight: 600, color: 'var(--glass-text-title, #f4f4f5)' }}
          >
            Something went wrong
          </span>
        </div>

        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}>
          {ORIGIN_TEXT[info.origin]} Save your work if possible — use{' '}
          <strong>File → Save As…</strong> on anything you cannot lose
          {fatal ? ' — then reload' : ''}. Nothing has been sent anywhere; this message exists only
          on this screen.
        </p>

        <pre
          data-testid="crash-detail"
          style={{
            margin: 0,
            padding: 10,
            overflow: 'auto',
            maxHeight: 220,
            fontSize: 11,
            lineHeight: 1.45,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            borderRadius: 10,
            border: '1px solid var(--glass-border, rgba(255,255,255,0.08))',
            background: 'rgba(0,0,0,0.35)',
            color: 'var(--glass-text-secondary, #a1a1aa)',
            // Load-bearing: index.css sets `body { user-select: none }`, so
            // without this the one text a user needs to copy cannot be.
            userSelect: 'text',
            cursor: 'text',
          }}
        >
          {info.detail}
        </pre>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {onDismiss ? (
            <button
              type="button"
              data-testid="crash-dismiss"
              onClick={onDismiss}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                fontSize: 12,
                borderRadius: 8,
                cursor: 'pointer',
                border: '1px solid var(--glass-border, rgba(255,255,255,0.08))',
                background: 'rgba(255,255,255,0.04)',
                color: 'var(--glass-text-label, #d4d4d8)',
              }}
            >
              <X size={13} />
              Dismiss
            </button>
          ) : null}
          <button
            type="button"
            data-testid="crash-reload"
            onClick={reloadWindow}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              fontSize: 12,
              borderRadius: 8,
              cursor: 'pointer',
              border: '1px solid var(--accent-ring, rgba(38,198,218,0.35))',
              background: 'var(--accent, #26c6da)',
              color: '#08282c',
              fontWeight: 600,
            }}
          >
            <RotateCw size={13} />
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}

interface State {
  /** A render/lifecycle throw. Fatal: the tree is gone. */
  renderCrash: CrashInfo | null;
  /** An exception React never saw. The app behind this is still standing. */
  globalCrash: CrashInfo | null;
}

/**
 * Wraps the whole app (see src/main.tsx). A class component because
 * `getDerivedStateFromError` has no hook form — that is the only reason.
 */
export default class CrashBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { renderCrash: null, globalCrash: null };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    const { message, detail } = describeError(error);
    return { renderCrash: { origin: 'render', message, detail } };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The console is the only place this goes. It is where a developer with the
    // window open is already looking, and it costs the user nothing.
    // eslint-disable-next-line no-console
    console.error('Auditorium: render crash', error, info.componentStack);
  }

  componentDidMount(): void {
    window.addEventListener('error', this.onWindowError);
    window.addEventListener('unhandledrejection', this.onRejection);
  }

  componentWillUnmount(): void {
    window.removeEventListener('error', this.onWindowError);
    window.removeEventListener('unhandledrejection', this.onRejection);
  }

  private onWindowError = (event: Event): void => {
    const e = event as ErrorEvent;
    const raw = e.error ?? e.message ?? 'unknown error';
    const { message, detail } = describeError(raw);
    if (isBenignGlobalError(e.message ?? message)) return;
    this.show({ origin: 'error', message, detail });
  };

  private onRejection = (event: Event): void => {
    const reason = (event as Event & { reason?: unknown }).reason;
    const { message, detail } = describeError(reason);
    if (isBenignGlobalError(message)) return;
    this.show({ origin: 'rejection', message, detail });
  };

  /** First one wins. A failing timer can fire many times a second, and a card
   * that reshuffles under the user while they read it is a card they cannot
   * read; the first exception is also the one most likely to be the cause
   * rather than a consequence. */
  private show(info: CrashInfo): void {
    this.setState((prev) => (prev.globalCrash ? null : { ...prev, globalCrash: info }));
  }

  private dismiss = (): void => {
    this.setState((prev) => ({ ...prev, globalCrash: null }));
  };

  render(): ReactNode {
    const { renderCrash, globalCrash } = this.state;
    // Fatal arm: nothing of the app is left to render behind it, and no Dismiss
    // — a blank window is not an alternative worth offering.
    if (renderCrash) return <CrashCard info={renderCrash} variant="fatal" />;
    return (
      <>
        {this.props.children}
        {globalCrash ? (
          <CrashCard info={globalCrash} variant="notice" onDismiss={this.dismiss} />
        ) : null}
      </>
    );
  }
}
