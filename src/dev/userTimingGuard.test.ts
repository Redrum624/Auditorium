import { suspendUserTiming, type UserTimingHost } from './userTimingGuard';

/** A stand-in for `Performance`: `measure` lives on the PROTOTYPE, exactly as
 * the real one does, so "restore" has to mean "uncover the inherited method"
 * and not "write a copy onto the instance". */
function makeHost(): { host: UserTimingHost; calls: string[] } {
  const calls: string[] = [];
  const proto = {
    measure(name: string) {
      calls.push(name);
    },
  };
  return { host: Object.create(proto) as UserTimingHost, calls };
}

describe('suspendUserTiming (F11-0) — react-dom’s timing-track probe', () => {
  it('makes measure non-callable SYNCHRONOUSLY, which is the only moment that matters', () => {
    const { host } = makeHost();
    expect(typeof host.measure).toBe('function');

    suspendUserTiming(host, () => {});

    // react-dom evaluates `typeof performance.measure === "function"` once, at
    // module-evaluation time. This is the value it would read.
    expect(typeof host.measure).not.toBe('function');
  });

  it('puts the INHERITED method back, rather than leaving a copy on the instance', () => {
    const { host, calls } = makeHost();
    const proto = Object.getPrototypeOf(host) as UserTimingHost;
    let scheduled: (() => void) | null = null;

    suspendUserTiming(host, (fn) => {
      scheduled = fn;
    });
    expect(Object.prototype.hasOwnProperty.call(host, 'measure')).toBe(true);

    scheduled!();

    expect(typeof host.measure).toBe('function');
    // The own shadow is gone: the object is byte-for-byte what it was.
    expect(Object.prototype.hasOwnProperty.call(host, 'measure')).toBe(false);
    expect(host.measure).toBe(proto.measure);
    (host.measure as (n: string) => void)('after');
    expect(calls).toEqual(['after']);
  });

  it('restores an OWN measure with its own descriptor', () => {
    const original = () => {};
    const host: UserTimingHost = {};
    Object.defineProperty(host, 'measure', {
      value: original,
      writable: false,
      configurable: true,
      enumerable: false,
    });

    const restore = suspendUserTiming(host, () => {});
    expect(typeof host.measure).not.toBe('function');

    restore();
    expect(host.measure).toBe(original);
    const desc = Object.getOwnPropertyDescriptor(host, 'measure');
    expect(desc?.writable).toBe(false);
    expect(desc?.enumerable).toBe(false);
  });

  it('restores on a MICROTASK by default — after module evaluation, before any app code', async () => {
    const { host } = makeHost();
    suspendUserTiming(host);

    // Still suspended for the whole of this synchronous run, which is the
    // window the import graph (and therefore react-dom's init) evaluates in.
    expect(typeof host.measure).not.toBe('function');

    await Promise.resolve();
    expect(typeof host.measure).toBe('function');
  });

  it('is idempotent on restore — running it twice leaves the same object', () => {
    const { host } = makeHost();
    const proto = Object.getPrototypeOf(host) as UserTimingHost;
    const restore = suspendUserTiming(host, () => {});

    restore();
    restore();

    expect(host.measure).toBe(proto.measure);
    expect(Object.prototype.hasOwnProperty.call(host, 'measure')).toBe(false);
  });

  it('leaves a host with no callable measure completely alone', () => {
    const host: UserTimingHost = {};
    const scheduled: Array<() => void> = [];

    suspendUserTiming(host, (fn) => scheduled.push(fn));

    expect(Object.prototype.hasOwnProperty.call(host, 'measure')).toBe(false);
    // Nothing was hidden, so nothing was scheduled to be put back.
    expect(scheduled).toHaveLength(0);
  });
});
