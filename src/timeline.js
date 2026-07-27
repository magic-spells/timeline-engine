/**
 * Timeline: keyframe clips placed at offset start times on one shared time
 * axis, plus everything that can own the playhead.
 *
 * The core is a pure function of time. `getFrames(time)` answers "what should
 * every target look like at `time`" with no writes and no callbacks; `seek`
 * is that plus applying the styles and firing the `call`s the move crossed.
 * Timed playback, scrubbing and scroll driving all funnel through the same
 * path, which is what makes a timeline reproducible: the same time always
 * produces the same frame.
 *
 * Physics is deliberately absent — a spring has no closed-form
 * position-at-time, so it cannot be scrubbed. Trigger animation-engine scenes
 * (physics included) from a `call` instead.
 */

import EventEmitter from '@magic-spells/event-emitter';
import { ticker } from '@magic-spells/animation-engine';

import { createClip, clipEnd, clipPhaseAt, clipStylesAt, resolveValue } from './clip.js';

const DEFAULT_DURATION = 1000;
const DEFAULT_EASING = 'ease';

/**
 * Write a style object onto an element, including CSS custom properties
 * (`Object.assign` can't set those on a real CSSStyleDeclaration).
 * @param {object} el
 * @param {Object<string, string>} styles
 * @param {Object<string, string>} [previous]
 */
function writeStyles(el, styles, previous = {}) {
  for (const key in previous) {
    if (key in styles) continue;
    if (key.startsWith('--') && typeof el.style.removeProperty === 'function') {
      el.style.removeProperty(key);
    } else {
      el.style[key] = '';
    }
  }

  for (const key in styles) {
    if (previous[key] === styles[key]) continue;
    if (key.startsWith('--') && typeof el.style.setProperty === 'function') {
      el.style.setProperty(key, String(styles[key]));
    } else {
      el.style[key] = styles[key];
    }
  }
}

export default class Timeline extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {{ duration?: number, easing?: string | ((t: number) => number) }} [options.defaults]
   * @param {boolean | number} [options.loop=1] - true = infinite, number = total iterations.
   */
  constructor(options = {}) {
    super();

    this._defaults = options.defaults ?? {};
    this._loop = options.loop ?? 1;

    this._clips = [];
    this._calls = [];
    this._labels = {};

    this._time = 0;
    this._timeScale = 1;

    // Nothing is written to the DOM until the first seek/play — constructing a
    // timeline must not disturb the page it describes.
    this._applied = false;
    this._written = new WeakMap();

    this._playing = false;
    this._playPromise = null;
    this._resolvePlay = null;
    this._onTick = null;
    this._iteration = 0;
    this._destroyed = false;

    // Invalidated by every add; see _sortedClips / duration.
    this._sorted = null;
    this._duration = null;
  }

  // ---- Building ----

  /**
   * Add a keyframe clip. Sparse keyframes get CSS `@keyframes` semantics
   * (a property missing from a key interpolates straight through) via
   * animation-engine's `fillSparseKeyframes`.
   * @param {*} target - Element, Element[]/NodeList, selector string, or {style} object.
   * @param {Object<number, Object<string, *>>} keyframes - Percent (0-100) → styles.
   * @param {Object} [opts]
   * @param {number | string} [opts.at] - Start time in ms or a label. Default: current end.
   * @param {number} [opts.duration=1000]
   * @param {string | ((t: number) => number)} [opts.easing='ease']
   * @param {'both' | 'backwards' | 'forwards' | 'none'} [opts.fill='both']
   * @param {number} [opts.stagger=0] - Per-element offset in ms.
   * @returns {this}
   */
  tween(target, keyframes, opts = {}) {
    this._addClip({
      kind: 'tween',
      target,
      keyframes,
      at: this._resolveAt(opts.at),
      duration: resolveValue(opts.duration) ?? resolveValue(this._defaults.duration) ?? DEFAULT_DURATION,
      easing: opts.easing ?? this._defaults.easing ?? DEFAULT_EASING,
      fill: opts.fill ?? 'both',
      stagger: resolveValue(opts.stagger) ?? 0,
    });
    return this;
  }

  /**
   * Sugar for a two-keyframe clip: `{ 0: from, 100: to }`.
   * @param {*} target
   * @param {Object<string, *>} from
   * @param {Object<string, *>} to
   * @param {Object} [opts] - Same shape as `tween`.
   * @returns {this}
   */
  fromTo(target, from, to, opts = {}) {
    return this.tween(target, { 0: from, 100: to }, opts);
  }

  /**
   * Zero-duration clip: applies `styles` from `at` onward.
   * @param {*} target
   * @param {Object<string, *>} styles
   * @param {Object} [opts]
   * @param {number | string} [opts.at] - Time in ms or a label. Default: current end.
   * @param {'both' | 'backwards' | 'forwards' | 'none'} [opts.fill='forwards']
   * @returns {this}
   */
  set(target, styles, opts = {}) {
    this._addClip({
      kind: 'set',
      target,
      styles,
      at: this._resolveAt(opts.at),
      duration: 0,
      easing: undefined,
      fill: opts.fill ?? 'forwards',
      stagger: 0,
    });
    return this;
  }

  /**
   * Register a callback fired when the playhead crosses its time, in either
   * direction. Receives 1 (forward) or -1 (backward). Use it to trigger
   * animation-engine scenes — including physics ones — from a timeline position.
   * @param {(direction: 1 | -1) => void} fn
   * @param {Object} [opts]
   * @param {number | string} [opts.at] - Time in ms or a label. Default: current end.
   * @param {boolean} [opts.once=false] - Fire at most once for the timeline's lifetime.
   * @param {1 | -1} [opts.direction] - Only fire while crossing in this direction.
   * @returns {this}
   */
  call(fn, opts = {}) {
    this._calls.push({
      fn,
      at: this._resolveAt(opts.at),
      once: !!opts.once,
      direction: opts.direction,
      fired: false,
    });
    return this;
  }

  /**
   * Name a time. With no `time`, labels the current end of the timeline.
   * @param {string} name
   * @param {number} [time]
   * @returns {this}
   */
  label(name, time) {
    this._labels[name] = time === undefined ? this.duration : time;
    return this;
  }

  /**
   * Total duration in ms: the largest clip end, stagger included.
   * @returns {number}
   */
  get duration() {
    if (this._duration === null) {
      let max = 0;
      for (const clip of this._clips) max = Math.max(max, clipEnd(clip));
      this._duration = max;
    }
    return this._duration;
  }

  /**
   * Whether timed playback is currently running.
   * @returns {boolean}
   */
  get playing() {
    return this._playing;
  }

  // ---- Querying / scrubbing ----

  /**
   * The styles every target should have at `time`. Pure: no DOM writes, no
   * callbacks, no playhead movement. One entry per element; clips merge in
   * ascending `at` order (insertion order breaks ties). Fill contributions are
   * merged first so an active clip always wins over an out-of-window hold.
   * @param {number} time
   * @returns {{ element: object, styles: Object<string, string> }[]}
   */
  getFrames(time) {
    const merged = new Map();
    const clips = this._sortedClips();

    // Fill is the fallback layer. Creating every entry here also preserves an
    // empty style object for clips whose fill contributes nothing.
    for (const clip of clips) {
      clip.elements.forEach((el, i) => {
        let styles = merged.get(el);
        if (styles === undefined) {
          styles = {};
          merged.set(el, styles);
        }
        if (clipPhaseAt(clip, i, time) === 0) return;
        const contribution = clipStylesAt(clip, i, time);
        if (contribution) Object.assign(styles, contribution);
      });
    }

    // Active windows are authoritative, with the usual ascending-`at` tie
    // breaking inside this pass.
    for (const clip of clips) {
      clip.elements.forEach((el, i) => {
        if (clipPhaseAt(clip, i, time) !== 0) return;
        const styles = merged.get(el);
        const contribution = clipStylesAt(clip, i, time);
        if (contribution) Object.assign(styles, contribution);
      });
    }

    const out = [];
    for (const [element, styles] of merged) out.push({ element, styles });
    return out;
  }

  /**
   * Move the playhead: applies every target's styles and fires the `call`s
   * crossed between the previous time and `time`, direction-aware.
   * @param {number} time
   * @param {Object} [opts]
   * @param {boolean} [opts.silent=false] - Skip the callbacks.
   * @returns {this}
   */
  seek(time, opts = {}) {
    if (this._destroyed) return this;
    return this._seek(time, !!opts.silent, true);
  }

  /**
   * Get (no arg) or set (with arg — same as `seek`) the playhead in ms.
   * @param {number} [t]
   * @returns {number | this}
   */
  time(t) {
    if (t === undefined) return this._time;
    return this.seek(t);
  }

  /**
   * Get or set the playhead as a 0-1 fraction of `duration`.
   * @param {number} [p]
   * @returns {number | this}
   */
  progress(p) {
    const total = this.duration;
    if (p === undefined) return total > 0 ? this._time / total : 0;
    return this.seek(p * total);
  }

  /**
   * Get or set the playback rate multiplier. Composes with the shared ticker's
   * own global `timeScale`.
   * @param {number} [n]
   * @returns {number | this}
   */
  timeScale(n) {
    if (n === undefined) return this._timeScale;
    this._timeScale = n;
    return this;
  }

  // ---- Timed playback ----

  /**
   * Play from the current playhead (restarting from 0 if it's already at the
   * end). Resolves when playback completes or is paused. Driven by
   * animation-engine's shared ticker, so tests drive it with `ticker.tick(ms)`.
   * @returns {Promise<void>}
   */
  play() {
    if (this._destroyed) return Promise.resolve();
    if (this._playing) return this._playPromise;

    const total = this.duration;

    // Nothing to play: still land on (and paint) the end state, and still
    // report completion, so callers can await `play()` unconditionally.
    if (total <= 0) {
      this._seek(0, false, false);
      this.emit('complete');
      return Promise.resolve();
    }

    const reverse = this._timeScale < 0;
    const atEnd = reverse ? this._time <= 0 : this._time >= total;
    if (atEnd) {
      this._seek(reverse ? total : 0, true, false);
      this._iteration = 0;
    } else if (!this._applied) {
      this._seek(this._time, true, false);
    }

    this._playing = true;
    this._playPromise = new Promise((resolve) => {
      this._resolvePlay = resolve;
    });

    this._onTick = (delta) => {
      try {
        this._advance(delta);
      } catch (error) {
        console.error(error);
      }
    };
    ticker.subscribe(this._onTick);

    return this._playPromise;
  }

  /**
   * Freeze the playhead in place and resolve the `play()` promise. The position
   * is kept, so a following `play()` resumes from it.
   * @returns {this}
   */
  pause() {
    if (!this._playing) return this;
    this._settle(false);
    return this;
  }

  /**
   * Permanently stop this timeline and release its ticker and event listeners.
   * Any pending `play()` promise resolves as a paused playback would.
   * @returns {this}
   */
  destroy() {
    if (this._destroyed) return this;
    this._settle(false);
    this.removeAllListeners();
    this._destroyed = true;
    return this;
  }

  /**
   * Serialize clips, labels and options to plain JSON. Every clip target must
   * have been added as a selector string and every easing as a string —
   * elements and functions have no serializable form (throws).
   * @returns {object}
   */
  toJSON() {
    const clips = this._clips.map((clip) => {
      if (typeof clip.target !== 'string') {
        throw new Error(
          'Timeline.toJSON(): clips can only serialize targets added as selector strings.'
        );
      }

      const out = { kind: clip.kind, target: clip.target, at: clip.at };

      if (clip.kind === 'set') {
        out.styles = clip.styles;
      } else {
        out.keyframes = clip.keyframes;
        out.duration = clip.duration;
        if (typeof clip.easingSpec !== 'string') {
          throw new Error('Timeline.toJSON(): function easings cannot serialize; use a named or cubic-bezier() easing.');
        }
        out.easing = clip.easingSpec;
      }

      out.fill = clip.fill;
      if (clip.stagger) out.stagger = clip.stagger;
      return out;
    });

    const data = { clips };

    if (Object.keys(this._labels).length > 0) data.labels = { ...this._labels };

    const options = {};
    if (this._loop !== 1) options.loop = this._loop;
    if (Object.keys(this._defaults).length > 0) {
      if (this._defaults.easing !== undefined && typeof this._defaults.easing !== 'string') {
        throw new Error('Timeline.toJSON(): function easings cannot serialize; use a named or cubic-bezier() easing.');
      }
      options.defaults = { ...this._defaults };
    }
    if (Object.keys(options).length > 0) data.options = options;

    return data;
  }

  /**
   * Rebuild a Timeline from `toJSON()` output. `call`s can't serialize and are
   * absent from the result.
   * @param {object} data
   * @returns {Timeline}
   */
  static fromJSON(data) {
    const tl = new Timeline(data.options);

    // Labels first: clips may position themselves against them.
    if (data.labels) {
      for (const name in data.labels) tl.label(name, data.labels[name]);
    }

    for (const clip of data.clips || []) {
      if (clip.kind === 'set') {
        tl.set(clip.target, clip.styles, { at: clip.at, fill: clip.fill });
      } else {
        tl.tween(clip.target, clip.keyframes, {
          at: clip.at,
          duration: clip.duration,
          easing: clip.easing,
          fill: clip.fill,
          stagger: clip.stagger,
        });
      }
    }

    return tl;
  }

  // ---- Internals ----

  /**
   * Resolve a clip/call position: a number, a label name, or undefined for the
   * timeline's current end (clips append sequentially).
   * @param {number | string | (() => number | string) | undefined} at
   * @returns {number}
   */
  _resolveAt(at) {
    const value = resolveValue(at);
    if (value === undefined || value === null) return this.duration;
    if (typeof value === 'string') {
      if (!(value in this._labels)) throw new Error(`Timeline: unknown label "${value}".`);
      return this._labels[value];
    }
    return value;
  }

  /**
   * @param {object} config - See `createClip`.
   */
  _addClip(config) {
    this._clips.push(createClip(config));
    this._sorted = null;
    this._duration = null;
  }

  /**
   * Clips in merge order: ascending `at`, insertion order breaking ties.
   * @returns {object[]}
   */
  _sortedClips() {
    if (this._sorted === null) {
      this._sorted = this._clips
        .map((clip, index) => ({ clip, index }))
        .sort((a, b) => a.clip.at - b.clip.at || a.index - b.index)
        .map((entry) => entry.clip);
    }
    return this._sorted;
  }

  /**
   * The one path that moves the playhead. `isSeek` separates an explicit scrub
   * (emits 'seek') from playback advancing on its own (emits 'update' only).
   * @param {number} time
   * @param {boolean} silent
   * @param {boolean} isSeek
   * @returns {this}
   */
  _seek(time, silent, isSeek) {
    if (this._destroyed) return this;
    const previous = this._time;

    for (const { element, styles } of this.getFrames(time)) {
      const written = this._written.get(element);
      writeStyles(element, styles, written);
      this._written.set(element, { ...styles });
    }

    this._time = time;
    this._applied = true;

    if (!silent) this._fireCalls(previous, time);

    if (isSeek) {
      try {
        this.emit('seek', time);
      } catch (error) {
        console.error(error);
      }
    }
    try {
      this.emit('update', time);
    } catch (error) {
      console.error(error);
    }

    return this;
  }

  /**
   * Fire every `call` the move from `previous` to `time` crossed — strictly
   * past `previous`, up to and including `time`, so a jump-seek fires each one
   * exactly once and landing on a call's time counts as crossing it.
   * @param {number} previous
   * @param {number} time
   */
  _fireCalls(previous, time) {
    if (time === previous || this._calls.length === 0) return;

    const forward = time > previous;
    const crossed = this._calls.filter((call) =>
      forward ? call.at > previous && call.at <= time : call.at < previous && call.at >= time
    );
    crossed.sort((a, b) => (forward ? a.at - b.at : b.at - a.at));

    const direction = forward ? 1 : -1;
    for (const call of crossed) {
      if (call.direction !== undefined && call.direction !== direction) continue;
      if (call.once && call.fired) continue;
      call.fired = true;
      try {
        call.fn(direction);
      } catch (error) {
        console.error(error);
      }
    }
  }

  /**
   * One playback frame. The shared ticker's delta is already globally scaled;
   * this timeline's own `timeScale` layers on top.
   * @param {number} delta
   */
  _advance(delta) {
    const total = this.duration;
    const step = delta * this._timeScale;
    if (step === 0) return;

    const back = step < 0;
    const next = this._time + step;
    const bound = back ? 0 : total;

    if (back ? next > bound : next < bound) {
      this._seek(next, false, false);
      return;
    }

    // Calls catch up once per frame even when this step crosses many periods.
    // The `max(1, …)` keeps the two directions symmetric at the boundary:
    // forward, `next === total` floors to 1, but reverse, `next === 0` ceils to
    // 0 — which would advance no iteration and send a non-looping timeline
    // wrapping to the end forever instead of settling.
    const periods = back ? Math.max(1, Math.ceil(-next / total)) : Math.floor(next / total);
    const remainder = back ? next + periods * total : next - periods * total;
    this._iteration += periods;

    const iterations =
      this._loop === true ? Infinity : typeof this._loop === 'number' ? this._loop : 1;

    this._seek(bound, false, false);
    if (!this._playing) return;

    if (this._iteration >= iterations) {
      this._settle(true);
      return;
    }

    this._seek(back ? total : 0, true, false);
    if (this._playing) this._seek(remainder, false, false);
  }

  /**
   * End timed playback: unsubscribe, then emit before resolving so listeners
   * run ahead of whatever awaits `play()`.
   * @param {boolean} complete - True on natural completion, false on pause.
   */
  _settle(complete) {
    if (this._onTick) {
      ticker.unsubscribe(this._onTick);
      this._onTick = null;
    }
    this._playing = false;

    const resolve = this._resolvePlay;
    this._resolvePlay = null;
    this._playPromise = null;

    try {
      if (complete) this.emit('complete');
    } finally {
      if (resolve) resolve();
    }
  }
}
