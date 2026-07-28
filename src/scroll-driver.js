/**
 * Scroll → progress mapping.
 *
 * A ScrollDriver owns nothing but a px range: it resolves `start`/`end`
 * ScrollPoints into absolute scroll positions (`refresh()`), maps the live
 * scroll position onto 0-1, and pushes that onto a Timeline through its public
 * API (`seek(time, { silent })`, falling back to `progress(p)`). It never
 * touches timeline internals — anything with `{ duration, seek }` drives.
 *
 * Everything is guarded so the module runs in Node: `document`, `window` and
 * `requestAnimationFrame` are all optional. Without rAF the scroll handler
 * applies synchronously, which is what makes the test-suite deterministic —
 * same detection animation-engine's ticker uses.
 *
 * Vertical scrolling only in v1.
 */

import { ticker } from '@magic-spells/animation-engine';
import { viewportMetrics } from './viewport-metrics.js';

/** Below this gap the smoothed playhead snaps to target and unsubscribes. */
const SNAP_EPSILON = 0.0005;

/** Px the range must move before `refresh()` re-asserts the playhead. */
const RANGE_EPSILON = 0.5;

/** Alignment keywords → fraction of the box (vertical axis). */
const KEYWORDS = {
  top: 0,
  start: 0,
  center: 0.5,
  middle: 0.5,
  bottom: 1,
  end: 1,
};

/**
 * @param {number} n
 * @returns {number}
 */
function clamp01(n) {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Whether a real requestAnimationFrame exists (checked at call time so tests
 * can stub it either way).
 * @returns {boolean}
 */
function hasRAF() {
  return typeof requestAnimationFrame === 'function';
}

/**
 * Run a user callback without letting it escape the driver.
 *
 * Zone and progress callbacks fire from inside a rAF callback, and a smoothed
 * driver's seeks fire from inside the shared ticker's subscription. A throw
 * there stops the ticker's rAF chain re-arming while its internal `running`
 * flag stays true — every animation on the page dies permanently, from one bad
 * user callback. Report and carry on instead.
 * @param {*} fn - Callback candidate; ignored unless it is a function.
 * @param {*} [arg]
 */
function safeCall(fn, arg) {
  if (typeof fn !== 'function') return;
  try {
    fn(arg);
  } catch (error) {
    console.error(error);
  }
}

/**
 * One alignment token → a fraction of its box. Accepts the keywords
 * top/center/bottom (plus start/middle/end) and percentages like '25%'.
 * @param {string} token
 * @param {string} source - The full point string, for error messages.
 * @returns {number}
 */
function tokenToFraction(token, source) {
  const key = token.toLowerCase();
  if (key in KEYWORDS) return KEYWORDS[key];

  if (key.endsWith('%')) {
    const n = parseFloat(key);
    if (!Number.isNaN(n)) return n / 100;
  }

  throw new Error(
    `ScrollDriver: unrecognised scroll point "${token}" in "${source}" — ` +
      'use top | center | bottom or a percentage like "25%".'
  );
}

/**
 * Parse a ScrollPoint into a resolvable descriptor. Strings are
 * `"<triggerPoint> <viewportPoint>"`; a lone token pairs with the viewport's
 * top. Numbers are absolute scroll positions; functions are called on every
 * `refresh()` and return one.
 * @param {string | number | (() => number)} point
 * @returns {{ kind: 'px', value: number } | { kind: 'fn', fn: () => number } |
 *   { kind: 'align', trigger: number, viewport: number }}
 */
function parsePoint(point) {
  if (typeof point === 'function') return { kind: 'fn', fn: point };
  if (typeof point === 'number') return { kind: 'px', value: point };

  if (typeof point !== 'string') {
    throw new Error(`ScrollDriver: invalid scroll point ${String(point)}.`);
  }

  const parts = point.trim().split(/\s+/);

  // A bare number in string form is an absolute scroll position.
  if (parts.length === 1 && !parts[0].endsWith('%') && !(parts[0].toLowerCase() in KEYWORDS)) {
    const n = parseFloat(parts[0]);
    if (!Number.isNaN(n)) return { kind: 'px', value: n };
  }

  return {
    kind: 'align',
    trigger: tokenToFraction(parts[0], point),
    viewport: tokenToFraction(parts[1] === undefined ? 'top' : parts[1], point),
  };
}

/**
 * Binds a Timeline's progress to a scroll position.
 */
class ScrollDriver {
  /**
   * @param {object} timeline - Anything exposing `duration` + `seek(time, opts)`
   *   (or `progress(p)`).
   * @param {object} [options]
   * @param {object | string} [options.trigger] - Element or selector whose
   *   position defines the range.
   * @param {string | number | (() => number)} [options.start='top bottom']
   * @param {string | number | (() => number)} [options.end='bottom top']
   * @param {object} [options.scroller=window] - Scroll container.
   * @param {number} [options.smoothing=0] - Time-constant in ms; 0 locks to scroll.
   * @param {boolean} [options.silent=false] - Seek without firing timeline calls.
   *   The constructor's bootstrap seek is always silent regardless of this.
   * @param {() => void} [options.onEnter] - Crossing into the range from before
   *   it. A page loaded (or scroll-restored) *already* inside the range never
   *   reports an enter: `_zone` is seeded from the bootstrap progress, and
   *   `onEnter` only fires on a -1 → 0 transition. Do first-paint work outside
   *   the callback, or check `driver.progress` after constructing.
   * @param {() => void} [options.onLeave]
   * @param {() => void} [options.onEnterBack]
   * @param {() => void} [options.onLeaveBack]
   * @param {(progress: number) => void} [options.onProgress]
   */
  constructor(timeline, options = {}) {
    this._timeline = timeline;
    this._options = options;

    this._scroller = options.scroller ?? (typeof window !== 'undefined' ? window : null);
    this._trigger = resolveTrigger(options.trigger);
    this._start = parsePoint(options.start ?? 'top bottom');
    this._end = parsePoint(options.end ?? 'bottom top');
    this._smoothing = options.smoothing ?? 0;
    this._silent = options.silent ?? false;

    this._startPx = 0;
    this._endPx = 0;
    this._progress = 0;
    /** -1 before the range, 0 inside it, 1 past it. */
    this._zone = 0;
    this._current = 0;
    this._target = 0;
    this._unsubscribe = null;
    this._rafId = null;
    this._resizeRafId = null;
    this._destroyed = false;

    // Bound once so add/removeEventListener see the same reference.
    this._onScroll = () => this._schedule();
    this._onResize = () => this._scheduleRefresh();
    this._onTick = (delta) => this._smooth(delta);

    // Resolve the range and adopt the current scroll position before any
    // listener exists: a page loaded mid-scroll must paint correctly, and that
    // bootstrap is not an "enter" — no callbacks fire for it. That includes the
    // timeline's own `call`s: the bootstrap seek is forced silent even when
    // `options.silent` is false, or a page restored mid-range would fire every
    // call between 0 and the current position at load, off-screen and out of
    // context. Zone callbacks are likewise skipped — `_zone` is seeded here.
    this._recompute();
    this._progress = this._computeProgress();
    this._zone = zoneOf(this._progress);
    this._current = this._progress;
    this._target = this._progress;
    this._seek(this._progress, true);

    this._attach();
  }

  /**
   * Current mapped progress (0-1, before smoothing).
   * @returns {number}
   */
  get progress() {
    return this._progress;
  }

  /**
   * Recompute the px range and re-apply the current scroll position. Runs on
   * resize; call it manually after any layout change.
   *
   * The re-seek is forced only when the range actually moved. Mobile chrome
   * sliding away fires resize continuously, and forcing there would snap every
   * smoothed driver on the page mid-ease for a range that never changed —
   * `RANGE_EPSILON` covers the sub-pixel jitter that animation produces.
   */
  refresh() {
    if (this._destroyed) return;
    const prevStart = this._startPx;
    const prevEnd = this._endPx;
    this._recompute();
    const moved =
      Math.abs(this._startPx - prevStart) > RANGE_EPSILON ||
      Math.abs(this._endPx - prevEnd) > RANGE_EPSILON;
    this._apply(moved);
  }

  /** Unbind every listener and ticker subscription; the timeline keeps its state. */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._detach();
    this._stopSmoothing();
    if (typeof cancelAnimationFrame === 'function') {
      if (this._rafId !== null) cancelAnimationFrame(this._rafId);
      if (this._resizeRafId !== null) cancelAnimationFrame(this._resizeRafId);
    }
    this._rafId = null;
    this._resizeRafId = null;
  }

  /* ---------------------------------------------------------------- range */

  /** @returns {number} */
  _scrollPos() {
    const s = this._scroller;
    if (!s) return 0;
    if (typeof s.scrollY === 'number') return s.scrollY;
    if (typeof s.pageYOffset === 'number') return s.pageYOffset;
    if (typeof s.scrollTop === 'number') return s.scrollTop;
    return 0;
  }

  /** @returns {number} */
  _viewportHeight() {
    const s = this._scroller;
    if (!s) return 0;
    // Identity, not duck-typing: only the real window gets the stable 100svh
    // measurement. Window-shaped objects (test fakes, custom hosts) keep
    // reporting their own innerHeight.
    if (typeof window !== 'undefined' && s === window) return viewportMetrics.height();
    if (typeof s.innerHeight === 'number') return s.innerHeight;
    if (typeof s.clientHeight === 'number') return s.clientHeight;
    return 0;
  }

  /** Window-like scrollers measure rects against the viewport itself. */
  get _isWindowScroller() {
    const s = this._scroller;
    return !!s && typeof s.innerHeight === 'number';
  }

  /**
   * The trigger's box in scroll-container coordinates (document space for a
   * window scroller). Missing trigger → a zero-height box at the origin.
   * @returns {{ top: number, height: number }}
   */
  _triggerBox() {
    const el = this._trigger;
    if (!el || typeof el.getBoundingClientRect !== 'function') return { top: 0, height: 0 };

    const rect = el.getBoundingClientRect();
    const height = typeof rect.height === 'number' ? rect.height : rect.bottom - rect.top;
    const scroll = this._scrollPos();

    if (this._isWindowScroller) return { top: rect.top + scroll, height };

    // Element scroller: rect is viewport-relative, so subtract the scroller's
    // own offset before adding its scroll position.
    const s = this._scroller;
    const sTop = s && typeof s.getBoundingClientRect === 'function' ? s.getBoundingClientRect().top : 0;
    return { top: rect.top - sTop + scroll, height };
  }

  /**
   * @param {ReturnType<typeof parsePoint>} point
   * @returns {number}
   */
  _resolvePoint(point) {
    if (point.kind === 'px') return point.value;
    if (point.kind === 'fn') {
      const value = Number(point.fn());
      return Number.isFinite(value) ? value : 0;
    }
    const box = this._triggerBox();
    return box.top + point.trigger * box.height - this._viewportHeight() * point.viewport;
  }

  _recompute() {
    this._startPx = this._resolvePoint(this._start);
    this._endPx = this._resolvePoint(this._end);
  }

  /* -------------------------------------------------------------- mapping */

  /** @returns {number} */
  _computeProgress() {
    const range = this._endPx - this._startPx;
    // Zero-length range: no gradient to map onto, so it is a hard switch.
    if (range === 0) return this._scrollPos() >= this._startPx ? 1 : 0;
    return clamp01((this._scrollPos() - this._startPx) / range);
  }

  /**
   * rAF-throttle in browsers; apply synchronously where there is no rAF.
   *
   * A driver whose range is off-screen sits pinned at 0 or 1 and would burn a
   * frame per scroll event re-deriving the same number, so it skips the frame
   * entirely. Any scroll that moves progress or zone falls through, which is
   * what keeps a jump across the whole range firing both edge callbacks.
   */
  _schedule() {
    if (this._destroyed) return;

    // Safe only because progress is a pure function of scroll position against
    // the cached px range — no layout reads here, nothing else to observe.
    const next = this._computeProgress();
    if (next === this._progress && zoneOf(next) === this._zone && (next === 0 || next === 1)) return;

    if (!hasRAF()) {
      this._apply(false);
      return;
    }
    if (this._rafId !== null) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      if (!this._destroyed) this._apply(false);
    });
  }

  /**
   * Same rAF throttle for resize. A raw resize stream fires dozens of events
   * per drag, and `refresh()` is the expensive path — a synchronous layout
   * (`getBoundingClientRect`) plus a full re-seek, per driver, per event.
   * Kept on its own rafId so a pending scroll frame can't swallow a refresh
   * (or vice versa); without rAF it stays synchronous, as tests rely on.
   */
  _scheduleRefresh() {
    if (this._destroyed) return;
    if (!hasRAF()) {
      this.refresh();
      return;
    }
    if (this._resizeRafId !== null) return;
    this._resizeRafId = requestAnimationFrame(() => {
      this._resizeRafId = null;
      if (!this._destroyed) this.refresh();
    });
  }

  /**
   * Map the live scroll position, fire boundary callbacks, drive the timeline.
   * @param {boolean} force - Seek even if progress is unchanged. Only
   *   `refresh()` passes true, and only when the px range actually moved.
   */
  _apply(force) {
    const next = this._computeProgress();
    const changed = next !== this._progress;
    this._progress = next;

    const zone = zoneOf(next);
    if (zone !== this._zone) {
      const prev = this._zone;
      this._zone = zone;
      this._fireZone(prev, zone);
    }

    if (changed) safeCall(this._options.onProgress, next);

    if (this._smoothing > 0) {
      this._target = next;

      // `force` only ever comes from a `refresh()` that found a moved range,
      // i.e. the layout shifted under us. Easing from `_current` would be
      // easing from a position the old range produced, so snap instead — and
      // seek here, because this branch returns before the `changed || force`
      // seek below.
      if (force) {
        this._current = next;
        this._stopSmoothing();
        this._seek(next);
        return;
      }

      if (Math.abs(this._target - this._current) > SNAP_EPSILON) this._startSmoothing();
      return;
    }

    if (changed || force) {
      this._current = next;
      this._seek(next);
    }
  }

  /**
   * Boundary callbacks, derived from zone transitions so a jump-scroll across
   * the whole range still reports both edges it crossed.
   * @param {number} prev
   * @param {number} next
   */
  _fireZone(prev, next) {
    const o = this._options;
    if (next > prev) {
      if (prev === -1) safeCall(o.onEnter);
      if (next === 1) safeCall(o.onLeave);
    } else {
      if (prev === 1) safeCall(o.onEnterBack);
      if (next === -1) safeCall(o.onLeaveBack);
    }
  }

  /**
   * Push progress onto the timeline. `seek` is preferred so `silent` survives;
   * `progress()` is the fallback for timelines that only expose it.
   * @param {number} p
   * @param {boolean} [forceSilent=false] - Suppress timeline calls for this
   *   seek regardless of `options.silent`. Used by the constructor's bootstrap,
   *   which adopts a scroll position rather than scrolling through one.
   */
  _seek(p, forceSilent = false) {
    const tl = this._timeline;
    if (!tl) return;

    if (typeof tl.seek === 'function') {
      const duration = typeof tl.duration === 'number' ? tl.duration : 0;
      tl.seek(p * duration, { silent: forceSilent || this._silent });
      return;
    }
    if (typeof tl.progress === 'function') tl.progress(p);
  }

  /* ------------------------------------------------------------ smoothing */

  _startSmoothing() {
    if (this._unsubscribe || this._destroyed) return;
    this._unsubscribe = ticker.subscribe(this._onTick);
  }

  _stopSmoothing() {
    if (!this._unsubscribe) return;
    this._unsubscribe();
    this._unsubscribe = null;
  }

  /**
   * Exponential approach to the scroll target: `smoothing` is the ms
   * time-constant (~63% of the remaining gap per that many ms), which makes it
   * frame-rate independent. Unsubscribes once settled so an idle driver costs
   * no frames.
   * @param {number} delta - Scaled ms from the shared ticker.
   */
  _smooth(delta) {
    // The one function here that literally *is* a ticker subscription, so it
    // gets the outer net safeCall gives the option callbacks: whatever the
    // driven timeline does on seek, the shared rAF loop must survive it.
    try {
      const diff = this._target - this._current;

      if (Math.abs(diff) <= SNAP_EPSILON) {
        if (this._current !== this._target) {
          this._current = this._target;
          this._seek(this._current);
        }
        this._stopSmoothing();
        return;
      }

      this._current += diff * (1 - Math.exp(-delta / this._smoothing));
      this._seek(this._current);
    } catch (error) {
      console.error(error);
      // Unsubscribe rather than re-enter the same failure every frame; the
      // next scroll event restarts smoothing if the timeline recovers.
      this._stopSmoothing();
    }
  }

  /* ------------------------------------------------------------ listeners */

  _attach() {
    const s = this._scroller;
    if (s && typeof s.addEventListener === 'function') {
      s.addEventListener('scroll', this._onScroll, { passive: true });
    }

    // Resize invalidates the px range. Window-like scrollers emit it
    // themselves; element scrollers rely on the window when there is one.
    const resizeTarget = this._isWindowScroller
      ? s
      : typeof window !== 'undefined'
        ? window
        : null;
    this._resizeTarget = resizeTarget;
    if (resizeTarget && typeof resizeTarget.addEventListener === 'function') {
      resizeTarget.addEventListener('resize', this._onResize);
    }
  }

  _detach() {
    const s = this._scroller;
    if (s && typeof s.removeEventListener === 'function') {
      s.removeEventListener('scroll', this._onScroll);
    }
    const r = this._resizeTarget;
    if (r && typeof r.removeEventListener === 'function') {
      r.removeEventListener('resize', this._onResize);
    }
    this._resizeTarget = null;
  }
}

/**
 * @param {number} p
 * @returns {number} -1 before the range, 0 inside, 1 past it.
 */
function zoneOf(p) {
  if (p >= 1) return 1;
  if (p <= 0) return -1;
  return 0;
}

/**
 * Resolve a trigger option to an element-like object. Selector strings need a
 * document; without one (Node) there is no trigger and keyword points fall
 * back to a zero-height box at the scroll origin.
 * @param {object | string | undefined} trigger
 * @returns {object | null}
 */
function resolveTrigger(trigger) {
  if (trigger == null) return null;
  if (typeof trigger === 'string') {
    if (typeof document !== 'undefined' && document.querySelector) {
      return document.querySelector(trigger);
    }
    return null;
  }
  return trigger;
}

export { ScrollDriver };
export default ScrollDriver;
