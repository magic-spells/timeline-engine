/**
 * @magic-spells/timeline-engine — type declarations.
 *
 * A deterministic, scrubable timeline: keyframe clips placed at offset start
 * times on a shared time axis. The playhead can be set to any time (pure
 * `getFrames`, applied `seek`), driven by the clock (`play`/`pause` via
 * animation-engine's shared ticker), or driven by scroll position
 * (`scrollDriver`). Physics steps are deliberately unsupported on the scrubbed
 * path — a spring has no closed-form position-at-time — but physics-based
 * animation-engine scenes can be *triggered* from the timeline (`call`) or from
 * the viewport (`viewTrigger`) and play forward in real time.
 */

/**
 * A value that may be supplied lazily, as a zero-arg function returning it —
 * which is how animation-engine's `rand()` composes. Lazy values are resolved
 * once, at build time: scrubbing must be repeatable, so randomness is not
 * re-rolled per frame.
 */
export type Lazy<T> = T | (() => T);

/** Keyframe map: percent positions (0-100) → CSS style objects (camelCase props). */
export type Keyframes = Record<number, Record<string, Lazy<string | number>>>;

/** Plain CSS style object (camelCase props; `--custom-props` allowed). */
export type Styles = Record<string, Lazy<string | number>>;

/** Anything accepted as a clip target. */
export type Target =
  | Element
  | Element[]
  | NodeList
  | ArrayLike<Element>
  | string
  | { style: Record<string, any>; isConnected?: boolean };

/** An easing: a named preset, a `cubic-bezier(...)` string, or a custom function. */
export type Easing = string | ((t: number) => number);

/**
 * How a clip behaves when the playhead is outside its window.
 * - 'both' (default): holds its 0% frame before `at` and its 100% frame after
 *   `at + duration` — what scroll storytelling almost always wants.
 * - 'backwards': holds the 0% frame before, writes nothing after.
 * - 'forwards': writes nothing before, holds the 100% frame after.
 * - 'none': writes nothing outside its window.
 */
export type Fill = 'both' | 'backwards' | 'forwards' | 'none';

/** Options for `tween()` / `fromTo()`. */
export interface TweenOptions {
  /**
   * Start time in ms, or a label name. Defaults to the current end of the
   * timeline (clips append sequentially unless positioned).
   */
  at?: Lazy<number | string>;
  /** Clip length in ms. Default 1000. */
  duration?: Lazy<number>;
  /** Default 'ease'. Overshoot easings (back/elastic) extrapolate via frame-engine. */
  easing?: Easing;
  /** Fill behavior outside the clip window. Default 'both'. */
  fill?: Fill;
  /**
   * For multi-element targets: offset each element's clip window by
   * `index * stagger` ms. Timeline duration accounts for the last element.
   * A negative stagger staggers in reverse order (last element first); the
   * clip window still begins at `at` either way.
   * Default 0 (all elements share the window).
   */
  stagger?: Lazy<number>;
}

/** Options for `set()`. */
export interface SetOptions {
  /** Time in ms or label. Defaults to the current end of the timeline. */
  at?: Lazy<number | string>;
  /**
   * Fill behavior. Default 'forwards': the styles apply from `at` onward and
   * the element is untouched before it.
   */
  fill?: Fill;
}

/** Options for `call()`. */
export interface CallOptions {
  /** Time in ms or label. Defaults to the current end of the timeline. */
  at?: Lazy<number | string>;
  /**
   * Fire at most once for the lifetime of the timeline. Default false.
   * Checked *after* `direction`, so a direction-filtered `once` is not spent
   * by a crossing the other way.
   */
  once?: boolean;
  /**
   * Only fire when crossed this way: 1 forward, -1 backward. Default: both.
   * Pair with `once` for a trigger that fires on the first forward crossing
   * and survives any number of backward scrubs before it.
   */
  direction?: 1 | -1;
}

/** Timeline construction options. */
export interface TimelineOptions {
  /** Defaults inherited by clips. */
  defaults?: { duration?: number; easing?: Easing };
  /** true = infinite; a number = total iterations (timed playback only). Default 1. */
  loop?: boolean | number;
}

/** One entry of `getFrames()`: an element and the styles due at that time. */
export interface FrameEntry {
  element: Element | { style: Record<string, any> };
  styles: Record<string, string>;
}

/**
 * A deterministic, scrubable timeline. Extends EventEmitter; emits
 * 'update' (time), 'complete', 'seek' (time).
 */
export class Timeline {
  constructor(options?: TimelineOptions);

  on(event: 'update' | 'seek', listener: (time: number) => void): this;
  on(event: 'complete', listener: () => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;
  removeAllListeners(event?: string): this;

  /**
   * Add a keyframe clip. Sparse keyframes get CSS @keyframes semantics
   * (missing properties interpolate straight through) via
   * animation-engine's `fillSparseKeyframes`.
   */
  tween(target: Target, keyframes: Keyframes, opts?: TweenOptions): this;

  /** Sugar for a two-keyframe clip: `{ 0: from, 100: to }`. */
  fromTo(target: Target, from: Styles, to: Styles, opts?: TweenOptions): this;

  /** Zero-duration clip: applies `styles` from `at` onward (fill 'forwards'). */
  set(target: Target, styles: Styles, opts?: SetOptions): this;

  /**
   * Register a callback fired when the playhead crosses its time in either
   * direction (during `seek` or timed playback). Receives the crossing
   * direction: 1 forward, -1 backward. Use it to trigger animation-engine
   * scenes — including physics ones — from a timeline position.
   */
  call(fn: (direction: 1 | -1) => void, opts?: CallOptions): this;

  /**
   * Release the ticker subscription, resolve a pending `play()` and drop
   * listeners; the timeline stops responding to `play`/`seek` afterwards.
   * Worth calling for a `loop: true` timeline you are done with — nothing else
   * unsubscribes it.
   */
  destroy(): void;

  /** Name a time. With no `time`, labels the current end of the timeline. */
  label(name: string, time?: number): this;

  /** Total duration in ms: the max clip end (stagger included). */
  readonly duration: number;

  /** Whether timed playback is currently running. */
  readonly playing: boolean;

  /**
   * Pure query: the styles every target should have at `time`. No DOM writes,
   * no callbacks. One entry per element known to the timeline (`styles` is
   * `{}` when nothing applies, e.g. `fill: 'none'` outside its window).
   *
   * Clips merge active-beats-fill: a clip inside its window always outranks a
   * clip merely holding an edge frame, so chaining two clips on one element
   * works. Between two clips that are both in-window, the later-starting one
   * wins. Per property — an earlier clip keeps properties the later one omits.
   */
  getFrames(time: number): FrameEntry[];

  /**
   * Move the playhead: applies styles to every target and fires `call`s
   * crossed between the previous time and `time` (direction-aware): strictly
   * past the previous time, up to and including `time`. Note the initial
   * playhead is 0, so a `call` at exactly 0 only fires when crossed backward
   * onto — put it at a small positive time to fire on forward playback.
   * `silent: true` skips the callbacks.
   */
  seek(time: number, opts?: { silent?: boolean }): this;

  /** Get (no arg) or set (with arg — same as `seek`) the playhead in ms. */
  time(): number;
  time(t: number): this;

  /** Get or set the playhead as a 0-1 fraction of `duration`. */
  progress(): number;
  progress(p: number): this;

  /**
   * Play from the current playhead (from 0 if already at the end); resolves
   * when playback completes or is paused. Driven by animation-engine's shared
   * ticker — tests drive it with `ticker.tick(ms)`.
   */
  play(): Promise<void>;

  /**
   * Freeze the playhead in place; resolves the `play()` promise. Both the
   * position *and* the remaining loop iterations are kept, so a following
   * `play()` resumes rather than restarting the loop budget. Safe to call from
   * inside a `call` — the frame in progress stops advancing the playhead and
   * emits no 'complete'.
   */
  pause(): this;

  /**
   * Get (no arg) or set (with arg) the playback rate multiplier. Composes with
   * the shared ticker's own global `timeScale`. Signed: a negative rate plays
   * in reverse, settling at 0 (or wrapping `0 → duration` when looping) just as
   * a positive rate settles at `duration`.
   */
  timeScale(): number;
  timeScale(n: number): this;

  /**
   * Serialize the timeline's clips, labels and options to plain JSON.
   * Requires every target to have been added as a selector string — element
   * targets can't serialize (throws). The future timeline-editor web app
   * exports this shape.
   */
  toJSON(): TimelineJSON;

  /** Rebuild a Timeline from `toJSON()` output (also exported as `fromJSON`). */
  static fromJSON(data: TimelineJSON): Timeline;
}

/** Serialized timeline shape (see `Timeline.toJSON` / `fromJSON`). */
export interface TimelineJSON {
  /** Function easings can't serialize — `toJSON` throws on them. */
  options?: { defaults?: { duration?: number; easing?: string }; loop?: boolean | number };
  labels?: Record<string, number>;
  clips: Array<{
    kind: 'tween' | 'set';
    target: string;
    keyframes?: Keyframes;
    styles?: Styles;
    at: number;
    duration?: number;
    easing?: string;
    fill?: Fill;
    stagger?: number;
  }>;
}

/** Create a new Timeline. */
export function timeline(options?: TimelineOptions): Timeline;

/** Rebuild a Timeline from `toJSON()` output. `call`s can't serialize and are absent. */
export function fromJSON(data: TimelineJSON): Timeline;

/**
 * A scroll-range point: `"<triggerPoint> <viewportPoint>"` with keywords
 * top | center | bottom or percentages (e.g. 'top bottom', 'center center',
 * '25% 80%'), an absolute scroll position in px, or a function returning one.
 */
export type ScrollPoint = string | number | (() => number);

/**
 * Options for `scrollDriver()`.
 *
 * Vertical axis only: every internal measurement is Y, so a horizontally
 * scrolling container maps to progress 0 and stays there.
 */
export interface ScrollDriverOptions {
  /** Element (or selector) whose position defines the scroll range. */
  trigger?: Element | string | { getBoundingClientRect(): { top: number; height: number } };
  /** Progress 0 when this alignment is reached. Default 'top bottom'. */
  start?: ScrollPoint;
  /** Progress 1 when this alignment is reached. Default 'bottom top'. */
  end?: ScrollPoint;
  /**
   * Scroll container. Default window. Anything exposing scroll position
   * (`scrollY`/`pageYOffset`/`scrollTop`), a viewport size
   * (`innerHeight`/`clientHeight`) and add/removeEventListener works —
   * tests pass fake scroller objects.
   *
   * The real window is measured with a hidden `100svh` probe rather than
   * `innerHeight`, so mobile chrome showing/hiding doesn't move the range
   * mid-scroll. Zero config; other scrollers report their own height.
   */
  scroller?: Element | Window | Record<string, any>;
  /**
   * Smoothing time-constant in ms: the playhead lerps toward the scroll
   * position instead of locking to it (~63% of the gap closed per
   * `smoothing` ms). 0 (default) locks the playhead to scroll exactly.
   */
  smoothing?: number;
  /**
   * Seek silently (don't fire timeline `call`s from scrubbing). Default false.
   * The constructor's bootstrap seek — which adopts the current scroll
   * position so a mid-scroll reload paints correctly — is always silent
   * regardless, or every `call` below the restored position would fire at load.
   */
  silent?: boolean;
  /**
   * Fired on entering the range from above. Cannot fire for a page loaded
   * already *inside* the range: the driver starts out in that zone, and this
   * reports the transition into it.
   */
  onEnter?: () => void;
  onLeave?: () => void;
  onEnterBack?: () => void;
  onLeaveBack?: () => void;
  onProgress?: (progress: number) => void;
}

/** Binds a Timeline's progress to a scroll position. */
export class ScrollDriver {
  constructor(timeline: Timeline, options?: ScrollDriverOptions);
  /** Current mapped progress (0-1, before smoothing). */
  readonly progress: number;
  /**
   * Recompute the px range and re-assert the playhead (call after layout
   * changes; auto on resize, rAF-throttled). The re-seek is forced only when
   * the range actually moved — a refresh that finds the same range does
   * nothing, so a mobile resize storm can't snap a smoothed driver mid-ease.
   * When it did move, a smoothed driver snaps rather than easing from a
   * position the old range produced.
   */
  refresh(): void;
  /** Unbind all listeners; the timeline keeps its last state. */
  destroy(): void;
}

/** Create a ScrollDriver mapping scroll position onto `timeline.progress()`. */
export function scrollDriver(timeline: Timeline, options?: ScrollDriverOptions): ScrollDriver;

/** Options for `viewTrigger()`. */
export interface ViewTriggerOptions {
  /** Fired when the target enters the viewport. */
  enter?: (el: Element) => void;
  /** Fired when the target leaves the viewport. */
  leave?: (el: Element) => void;
  /**
   * Stop observing each element after its own first `enter`, so `leave` never
   * fires for it; the observer disconnects itself once every element has
   * fired. Per element, not per trigger — with a multi-element target, every
   * element still gets one `enter`. Default false.
   */
  once?: boolean;
  /** IntersectionObserver threshold. Default 0. */
  threshold?: number | number[];
  /** IntersectionObserver rootMargin. Default '0px'. */
  rootMargin?: string;
}

/**
 * Fire callbacks when elements enter/leave the viewport
 * (IntersectionObserver). The play-on-scroll-into-view mode: point `enter` at
 * `scene.play()` or `timeline.play()`.
 */
export function viewTrigger(
  target: Element | Element[] | NodeList | string,
  options?: ViewTriggerOptions
): { destroy(): void };

/**
 * Re-exported from `@magic-spells/animation-engine`, which the UMD build
 * inlines. Script-tag consumers should reach the engine through these rather
 * than loading animation-engine with a second script tag: two copies means two
 * ticker singletons and two rAF loops, and `ticker.timeScale` would move one
 * and not the other.
 */
export { scene, ticker, rand } from '@magic-spells/animation-engine';
