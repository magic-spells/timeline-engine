/**
 * Viewport triggering via IntersectionObserver.
 *
 * The play-on-scroll-into-view mode: point `enter` at `scene.play()` or
 * `timeline.play()`. One observer covers every target; `once` unobserves each
 * element as it fires and the observer disconnects itself when the last one
 * has.
 *
 * Target normalisation is shared with clips (`resolveTargets` from clip.js) on
 * purpose: `viewTrigger('.card')` and `tl.tween('.card', …)` must agree on what
 * counts as one element versus a list, and a second copy of the rule drifted
 * once already.
 */

import { resolveTargets } from './clip.js';

/**
 * Fire callbacks when elements enter/leave the viewport.
 *
 * @param {object | object[] | ArrayLike<object> | string} target
 * @param {object} [options]
 * @param {(el: object) => void} [options.enter]
 * @param {(el: object) => void} [options.leave]
 * @param {boolean} [options.once=false] - Stop observing an element after its
 *   first `enter` (so `leave` never fires for it).
 * @param {number | number[]} [options.threshold=0]
 * @param {string} [options.rootMargin='0px']
 * @returns {{ destroy(): void }}
 */
export function viewTrigger(target, options = {}) {
  const { enter, leave, once = false, threshold = 0, rootMargin = '0px' } = options;

  // Read from globalThis at call time so a host that polyfills late (and tests
  // that stub) still work.
  const Observer = globalThis.IntersectionObserver;
  if (typeof Observer !== 'function') {
    throw new Error(
      'viewTrigger: IntersectionObserver is not available in this environment.'
    );
  }

  const elements = resolveTargets(target);
  // Elements currently considered in view. IntersectionObserver reports every
  // element on first observe — usually as not-intersecting — so `leave` must
  // only fire for elements that were actually seen entering.
  const inView = new Set();
  // `once` elements are done for good: any straggler entry delivered between
  // unobserve and the next frame must not fire enter or leave again.
  const fired = new Set();
  let remaining = elements.length;
  let destroyed = false;

  const observer = new Observer(
    (entries) => {
      for (const entry of entries) {
        if (destroyed) return;

        const el = entry.target;
        if (fired.has(el)) continue;

        const isIn =
          entry.isIntersecting !== undefined
            ? entry.isIntersecting
            : entry.intersectionRatio > 0;

        if (isIn) {
          if (inView.has(el)) continue;
          inView.add(el);
          if (typeof enter === 'function') enter(el);

          if (once) {
            fired.add(el);
            observer.unobserve(el);
            remaining -= 1;
            if (remaining <= 0) destroy();
          }
        } else if (inView.has(el)) {
          inView.delete(el);
          if (typeof leave === 'function') leave(el);
        }
      }
    },
    { threshold, rootMargin }
  );

  for (const el of elements) observer.observe(el);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    observer.disconnect();
  }

  return { destroy };
}

export default viewTrigger;
