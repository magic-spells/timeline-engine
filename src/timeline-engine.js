/**
 * @magic-spells/timeline-engine
 *
 * A deterministic, scrubable timeline for the magic-spells ecosystem —
 * keyframe clips at offset start times, driven by the clock, a scrub
 * position, or scroll.
 *
 * It composes @magic-spells/frame-engine (progress → interpolated CSS) and
 * reuses @magic-spells/animation-engine's easings, sparse-keyframe fill and
 * shared ticker. timeline-engine owns the time axis: clip placement,
 * scrubbing, scroll mapping and viewport triggering.
 */

import Timeline from './timeline.js';
import { ScrollDriver } from './scroll-driver.js';
import { viewTrigger } from './view-trigger.js';

// Re-exported from animation-engine, deliberately. The UMD build inlines
// animation-engine (including its module-level `ticker` singleton), so a page
// that loads this bundle *and* a separate animation-engine script gets two
// tickers and two rAF loops — `ticker.timeScale` would then move one and not
// the other. Reaching the engine through this entry point is the only way a
// script-tag consumer can be sure it shares our ticker.
//
// `registerPhysics` rides along for the same reason. As of animation-engine
// 0.2.0 the spring implementation is injected, not bundled: physics-engine is
// a peer the consumer supplies, and a `{ physics }` scene step throws until it
// is registered. A script-tag page loads physics-engine's own UMD (global
// `PhysicsEngine` — dependency-free, no singleton, so a second script tag is
// harmless here) and registers it through *our* copy of the engine:
// `TimelineEngine.registerPhysics(PhysicsEngine)`. Registering through a
// separately-loaded animation-engine would register into the wrong module.
import { scene, ticker, rand, registerPhysics } from '@magic-spells/animation-engine';

/**
 * Create a new Timeline. See the Timeline constructor for the options shape.
 * @param {object} [options]
 * @returns {Timeline}
 */
function timeline(options) {
  return new Timeline(options);
}

/**
 * Rebuild a Timeline from `toJSON()` output.
 * @param {object} data
 * @returns {Timeline}
 */
function fromJSON(data) {
  return Timeline.fromJSON(data);
}

/**
 * Create a ScrollDriver mapping scroll position onto `timeline.progress()`.
 * @param {Timeline} tl
 * @param {object} [options]
 * @returns {ScrollDriver}
 */
function scrollDriver(tl, options) {
  return new ScrollDriver(tl, options);
}

export { timeline, Timeline, fromJSON, scrollDriver, ScrollDriver, viewTrigger };
export { scene, ticker, rand, registerPhysics };
