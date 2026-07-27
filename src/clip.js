/**
 * Clip construction and evaluation — the atomic unit of a timeline.
 *
 * A clip is a set of resolved target elements, a prebuilt FrameEngine, and a
 * window on the shared time axis. Everything expensive or non-deterministic
 * happens here exactly once, at add time: targets are resolved, lazy values are
 * called, sparse keyframes are filled, and the keyframe map is parsed. Both
 * matter — scrubbing is a hot path (pure math only), and it must be repeatable,
 * so a `rand()` re-rolled per evaluation would make the same time produce
 * different styles.
 */

import FrameEngine from '@magic-spells/frame-engine';
import { fillSparseKeyframes, resolveEasing } from '@magic-spells/animation-engine';

/**
 * Normalise any accepted target form into an array of element-like objects.
 * Accepts a CSS selector string, a single Element (or plain {style} test
 * object), an Element[]/NodeList/ArrayLike, or null. Selector strings resolve
 * to nothing outside a DOM (Node tests).
 * @param {string | object | ArrayLike<object> | null | undefined} target
 * @returns {object[]}
 */
export function resolveTargets(target) {
  if (target == null) return [];

  if (typeof target === 'string') {
    // No document at all (Node, SSR) is expected, not a mistake — only warn
    // when there was a DOM to search and the selector still found nothing,
    // which is the silent-failure case: the clip contributes its full window
    // to `duration` and serializes fine while animating nothing.
    if (typeof document === 'undefined' || !document.querySelectorAll) return [];

    const elements = Array.from(document.querySelectorAll(target));
    if (elements.length === 0) {
      console.warn(
        `Timeline: selector "${target}" matched no elements — this clip will animate ` +
          'nothing. Targets are resolved once, when the clip is added.'
      );
    }
    return elements;
  }

  if (Array.isArray(target)) return target;

  // NodeList / HTMLCollection: array-like, but not a style-bearing element.
  if (
    typeof target.length === 'number' &&
    typeof target !== 'function' &&
    target.style === undefined &&
    target.nodeType === undefined
  ) {
    return Array.from(target);
  }

  return [target];
}

/**
 * Resolve a possibly-lazy value: call it if it's a zero-arg function.
 * @template T
 * @param {T | (() => T)} value
 * @returns {T}
 */
export function resolveValue(value) {
  return typeof value === 'function' ? value() : value;
}

/**
 * Resolve every value in a style object (each may be lazy).
 * @param {Object<string, *>} styles
 * @returns {Object<string, string | number>}
 */
export function resolveStyles(styles) {
  const out = {};
  for (const key in styles) out[key] = resolveValue(styles[key]);
  return out;
}

/**
 * Resolve a raw keyframe map ({ 0: {...}, 100: {...} }), resolving any lazy
 * values inside each keyframe's style object.
 * @param {Object<number, Object<string, *>>} keyframes
 * @returns {Object<number, Object<string, string | number>>}
 */
export function resolveKeyframes(keyframes) {
  const out = {};
  for (const pct in keyframes) out[pct] = resolveStyles(keyframes[pct]);
  return out;
}

/**
 * Build a clip. `at` and `duration` arrive already resolved to numbers — the
 * Timeline owns label lookup and the append-at-current-end default.
 *
 * @param {Object} config
 * @param {'tween' | 'set'} config.kind
 * @param {*} config.target - Raw target, kept verbatim for `toJSON`.
 * @param {Object<number, object>} [config.keyframes] - Tween clips.
 * @param {Object<string, *>} [config.styles] - `set` clips.
 * @param {number} config.at - Window start in ms.
 * @param {number} config.duration - Window length in ms (0 for `set`).
 * @param {string | ((t: number) => number)} [config.easing]
 * @param {'both' | 'backwards' | 'forwards' | 'none'} config.fill
 * @param {number} [config.stagger=0]
 * @returns {object} The clip.
 */
export function createClip({ kind, target, keyframes, styles, at, duration, easing, fill, stagger }) {
  const elements = resolveTargets(target);

  // Keep the pre-fill map for `toJSON`: the fill is a lossy expansion (it bakes
  // interpolated values into every key) and re-filling a dense map is a no-op,
  // so serializing the raw form round-trips exactly.
  const raw =
    kind === 'set'
      ? (() => {
          const s = resolveStyles(styles);
          return { 0: s, 100: s };
        })()
      : resolveKeyframes(keyframes);

  const fe = new FrameEngine(fillSparseKeyframes(raw));

  return {
    kind,
    target,
    elements,
    /** Resolved, unfilled keyframes — the serializable form. */
    keyframes: raw,
    /** Resolved `set` styles, or null. Also the serializable form. */
    styles: kind === 'set' ? raw[0] : null,
    fe,
    at,
    duration,
    /** The easing as given, so `toJSON` can tell strings from functions apart. */
    easingSpec: easing,
    // `set` clips carry no easing; resolveEasing(undefined) would warn.
    easing: easing === undefined ? (t) => t : resolveEasing(easing),
    fill,
    stagger: stagger || 0,
    // Fill frames are cached: they're requested on every out-of-window
    // evaluation, which for a scroll-driven timeline is most clips most frames.
    frame0: fe.getFrame(0),
    frame1: fe.getFrame(1),
  };
}

/**
 * The stagger-adjusted start for one element. A negative stagger reverses the
 * element order without moving any element before the clip's `at`.
 * @param {object} clip
 * @param {number} index
 * @returns {number}
 */
function clipStartAt(clip, index) {
  const last = Math.max(clip.elements.length - 1, 0);
  const order = clip.stagger >= 0 ? index : last - index;
  return clip.at + order * Math.abs(clip.stagger);
}

/**
 * The clip's end on the time axis, last staggered element included.
 * @param {object} clip
 * @returns {number}
 */
export function clipEnd(clip) {
  const last = Math.max(clip.elements.length - 1, 0);
  const lastToStart = clip.stagger >= 0 ? last : 0;
  return clipStartAt(clip, lastToStart) + clip.duration;
}

/**
 * Whether an element is before, inside, or after its staggered clip window.
 * @param {object} clip
 * @param {number} index
 * @param {number} time
 * @returns {-1 | 0 | 1}
 */
export function clipPhaseAt(clip, index, time) {
  const start = clipStartAt(clip, index);
  if (time < start) return -1;
  if (time > start + clip.duration) return 1;
  return 0;
}

/**
 * The styles clip `clip` contributes to its element at `index` at `time`, or
 * null when it contributes nothing (outside its window with a `fill` that
 * doesn't hold). Pure — the returned object may be a cached fill frame, so
 * callers must copy rather than mutate it.
 * @param {object} clip
 * @param {number} index - Element index, for the stagger offset.
 * @param {number} time - Timeline time in ms.
 * @returns {Object<string, string> | null}
 */
export function clipStylesAt(clip, index, time) {
  const phase = clipPhaseAt(clip, index, time);

  if (phase === -1) {
    return clip.fill === 'both' || clip.fill === 'backwards' ? clip.frame0 : null;
  }
  if (phase === 1) {
    return clip.fill === 'both' || clip.fill === 'forwards' ? clip.frame1 : null;
  }

  // Zero-duration clips (`set`) are their end state the moment they're reached.
  const start = clipStartAt(clip, index);
  const progress = clip.duration > 0 ? (time - start) / clip.duration : 1;

  // Eased progress goes to frame-engine unclamped on purpose: overshoot easings
  // (back/elastic) leave 0..1 mid-curve and rely on its extrapolation.
  return clip.fe.getFrame(clip.easing(progress));
}
