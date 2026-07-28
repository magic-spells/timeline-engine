/**
 * Stable viewport height.
 *
 * Mobile browsers grow and shrink the visual viewport as their chrome slides
 * away, so `innerHeight` changes mid-scroll and every px range resolved from it
 * moves under the user — the resize storm that follows re-seeks the playhead,
 * which reads as a jerk. A `100svh` probe measures the *small* viewport (the
 * height with the chrome showing), which does not move during that animation,
 * so ranges computed against it stay put.
 *
 * Nothing here touches `document`, `window` or `CSS` at import time: this
 * module is imported by the Node test suite, and the driver itself must stay
 * usable in environments that have no DOM. Every global is read at call time,
 * which is also what lets tests stub them.
 *
 * Singleton, and the probe is never removed once created — it is a zero-sized
 * hidden div, and re-creating it per read would be a layout thrash. Internal
 * module: deliberately not exported from `src/timeline-engine.js`.
 */

/** Parks the probe outside layout, painting, hit-testing and a11y. */
const CONTAINER_STYLE =
  'position: fixed; top: 0; left: 0; width: 0; height: 0; ' +
  'overflow: hidden; visibility: hidden; pointer-events: none; z-index: -1;';

/**
 * The live viewport height, used until (or unless) a probe exists.
 * @returns {number}
 */
function liveHeight() {
  return globalThis.visualViewport?.height || globalThis.innerHeight || 0;
}

const viewportMetrics = {
  /** @type {object | null} The `100svh` element that gets measured. */
  probe: null,
  /** @type {object | null} Its hidden wrapper, kept for `_reset()`. */
  container: null,

  /**
   * Create the probe if it can be created. Re-entrant and re-tried on every
   * `height()` call: a host that has no DOM yet (or no `100svh`) simply keeps
   * falling back, and one that gains one later starts measuring.
   */
  init() {
    if (this.probe) return;
    if (typeof document === 'undefined' || !document.documentElement) return;

    // `100svh` is the whole point — without it there is no stable height to
    // measure and the live viewport is as good as it gets.
    const css = globalThis.CSS;
    if (typeof css?.supports !== 'function' || !css.supports('height: 100svh')) return;

    const container = document.createElement('div');
    const probe = document.createElement('div');
    container.setAttribute('aria-hidden', 'true');
    container.style.cssText = CONTAINER_STYLE;
    probe.style.height = '100svh';
    container.appendChild(probe);
    document.documentElement.appendChild(container);

    this.container = container;
    this.probe = probe;
  },

  /**
   * Viewport height that mobile chrome cannot move.
   * @returns {number} Probe height, or the live viewport when there is none —
   *   including a probe that measured 0 (detached, or a hidden ancestor).
   */
  height() {
    this.init();
    if (this.probe) {
      const measured = this.probe.getBoundingClientRect().height;
      if (measured) return measured;
    }
    return liveHeight();
  },

  /** Test hook: detach the probe so the next `height()` starts clean. */
  _reset() {
    if (typeof this.container?.remove === 'function') this.container.remove();
    this.container = null;
    this.probe = null;
  },
};

export { viewportMetrics };
export default viewportMetrics;
