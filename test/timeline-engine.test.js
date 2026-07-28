/**
 * Entry-point tests.
 *
 * The public surface is a contract: script-tag consumers reach animation-engine
 * only through what this module re-exports, so a dropped re-export is invisible
 * to every other test here and only breaks at the consumer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as TimelineEngine from '../src/timeline-engine.js';

test('re-exports registerPhysics from animation-engine', () => {
  // Physics is injected, not bundled (animation-engine 0.2.0): without this
  // re-export a script-tag page has no way to register PhysicsEngine into the
  // engine copy our UMD inlines, and every `{ physics }` scene step throws.
  assert.equal(typeof TimelineEngine.registerPhysics, 'function');
});

test('re-exports the rest of the engine surface', () => {
  assert.equal(typeof TimelineEngine.scene, 'function');
  assert.equal(typeof TimelineEngine.rand, 'function');
  assert.ok(TimelineEngine.ticker, 'ticker singleton is re-exported');
});
