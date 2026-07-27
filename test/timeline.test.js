/**
 * Timeline tests.
 *
 * Fully deterministic and DOM-free: elements are plain `{ style: {} }` objects
 * and time is injected through the shared ticker's manual `tick(ms)` (in Node
 * the ticker never schedules itself). Numeric assertions use `linear` easing
 * and unclamped properties so the expected frame is exact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ticker } from '@magic-spells/animation-engine';

import Timeline from '../src/timeline.js';
import { resolveTargets } from '../src/clip.js';

/** A fake element. */
function el() {
  return { style: {}, isConnected: true };
}

// ---- Placement ----

test('clips append to the current end by default', () => {
  const a = el();
  const b = el();
  const tl = new Timeline();

  tl.tween(a, { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 400 });
  tl.tween(b, { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 600 });

  assert.equal(tl.duration, 1000);
  assert.equal(tl._clips[0].at, 0);
  assert.equal(tl._clips[1].at, 400);
});

test('`at` positions a clip explicitly and can overlap earlier ones', () => {
  const tl = new Timeline();
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000 });
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000, at: 200 });

  assert.equal(tl._clips[1].at, 200);
  assert.equal(tl.duration, 1200);
});

test('labels name times and can be used as `at`', () => {
  const tl = new Timeline();
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 500 });
  tl.label('mid'); // no time: the current end
  tl.label('late', 900);

  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 100, at: 'mid' });
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 100, at: 'late' });

  assert.equal(tl._clips[1].at, 500);
  assert.equal(tl._clips[2].at, 900);
  assert.equal(tl.duration, 1000);
});

test('an unknown label throws', () => {
  const tl = new Timeline();
  assert.throws(() => tl.tween(el(), { 0: { opacity: 0 } }, { at: 'nope' }), /unknown label/);
});

test('duration accounts for the last staggered element', () => {
  const els = [el(), el(), el()];
  const tl = new Timeline();
  tl.tween(els, { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000, stagger: 200 });

  assert.equal(tl.duration, 1400);
});

test('negative stagger reverses element order without truncating duration', () => {
  const els = [el(), el(), el()];
  const tl = new Timeline();
  tl.tween(els, { 0: { opacity: 0 }, 100: { opacity: 1 } }, {
    duration: 1000,
    stagger: -200,
    easing: 'linear',
  });

  assert.equal(tl.duration, 1400);
  assert.deepEqual(tl.getFrames(0).map((frame) => frame.styles.opacity), ['0', '0', '0']);
  assert.deepEqual(tl.getFrames(200).map((frame) => frame.styles.opacity), ['0', '0', '0.2']);

  tl.seek(tl.duration);
  assert.deepEqual(els.map((target) => target.style.opacity), ['1', '1', '1']);
});

test('a selector matching nothing warns — but only when there is a DOM', (t) => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  t.after(() => {
    console.warn = originalWarn;
    delete globalThis.document;
  });

  // No document at all (Node, SSR) is the expected case, not a mistake: warning
  // here would fire on every selector clip in every server render.
  assert.deepEqual(resolveTargets('.missing-target'), []);
  assert.equal(warnings.length, 0);

  // A DOM that genuinely matched nothing is the silent-failure case worth
  // flagging — the clip still contributes its full window to `duration`.
  globalThis.document = { querySelectorAll: () => [] };
  assert.deepEqual(resolveTargets('.missing-target'), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\.missing-target/);

  // A DOM that matched is silent.
  globalThis.document = { querySelectorAll: () => [{ style: {} }] };
  assert.equal(resolveTargets('.present').length, 1);
  assert.equal(warnings.length, 1);
});

test('options.defaults supply duration and easing', () => {
  const tl = new Timeline({ defaults: { duration: 250, easing: 'linear' } });
  const target = el();
  tl.tween(target, { 0: { opacity: 0 }, 100: { opacity: 1 } });

  assert.equal(tl.duration, 250);
  assert.deepEqual(tl.getFrames(125)[0].styles, { opacity: '0.5' });
});

// ---- getFrames ----

test('getFrames is pure: no writes, no callbacks, no playhead movement', () => {
  const target = el();
  let called = 0;
  const tl = new Timeline();
  tl.tween(target, { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000 });
  tl.call(() => (called += 1), { at: 500 });

  const frames = tl.getFrames(800);

  assert.deepEqual(target.style, {});
  assert.equal(called, 0);
  assert.equal(tl.time(), 0);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].element, target);
});

test('getFrames interpolates at boundaries and midpoints', () => {
  const target = el();
  const tl = new Timeline();
  tl.tween(target, { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000, easing: 'linear' });

  assert.deepEqual(tl.getFrames(0)[0].styles, { opacity: '0' });
  assert.deepEqual(tl.getFrames(250)[0].styles, { opacity: '0.25' });
  assert.deepEqual(tl.getFrames(500)[0].styles, { opacity: '0.5' });
  assert.deepEqual(tl.getFrames(1000)[0].styles, { opacity: '1' });
});

test('staggered elements get their own offset windows', () => {
  const els = [el(), el(), el()];
  const tl = new Timeline();
  tl.tween(els, { 0: { opacity: 0 }, 100: { opacity: 1 } }, {
    duration: 1000,
    stagger: 500,
    easing: 'linear',
  });

  const frames = tl.getFrames(1000);
  assert.deepEqual(frames.map((f) => f.styles.opacity), ['1', '0.5', '0']);
});

test('eased progress is not clamped: overshoot extrapolates past the end keyframe', () => {
  const target = el();
  const tl = new Timeline();
  // A deliberately overshooting easing: progress 0.75 eases to 1.5.
  tl.tween(target, { 0: { width: '0px' }, 100: { width: '100px' } }, {
    duration: 1000,
    easing: (t) => t * 2,
  });

  assert.deepEqual(tl.getFrames(750)[0].styles, { width: '150px' });
});

test('sparse keyframes interpolate straight through (CSS @keyframes semantics)', () => {
  const target = el();
  const tl = new Timeline();
  tl.tween(target, {
    0: { opacity: 0, width: '0px' },
    50: { opacity: 1 },
    100: { opacity: 0, width: '100px' },
  }, { duration: 1000, easing: 'linear' });

  // width is unspecified at 50%: it must keep travelling, not snap to a default.
  assert.equal(tl.getFrames(500)[0].styles.width, '50px');
});

// ---- Fill ----

test('fill modes decide what happens outside the window', () => {
  const targets = { both: el(), backwards: el(), forwards: el(), none: el() };
  const tl = new Timeline();

  for (const mode of ['both', 'backwards', 'forwards', 'none']) {
    tl.tween(targets[mode], { 0: { opacity: 0.25 }, 100: { opacity: 0.75 } }, {
      at: 1000,
      duration: 1000,
      fill: mode,
    });
  }

  const before = new Map(tl.getFrames(0).map((f) => [f.element, f.styles]));
  const after = new Map(tl.getFrames(3000).map((f) => [f.element, f.styles]));

  assert.deepEqual(before.get(targets.both), { opacity: '0.25' });
  assert.deepEqual(after.get(targets.both), { opacity: '0.75' });

  assert.deepEqual(before.get(targets.backwards), { opacity: '0.25' });
  assert.deepEqual(after.get(targets.backwards), {});

  assert.deepEqual(before.get(targets.forwards), {});
  assert.deepEqual(after.get(targets.forwards), { opacity: '0.75' });

  assert.deepEqual(before.get(targets.none), {});
  assert.deepEqual(after.get(targets.none), {});
});

test('fill defaults: both for tween/fromTo, forwards for set', () => {
  const tl = new Timeline();
  tl.tween(el(), { 0: { opacity: 0 } }, {});
  tl.fromTo(el(), { opacity: 0 }, { opacity: 1 }, {});
  tl.set(el(), { opacity: 1 }, {});

  assert.deepEqual(tl._clips.map((c) => c.fill), ['both', 'both', 'forwards']);
});

// ---- Merging ----

test('overlapping clips merge in ascending `at` order — the later one wins', () => {
  const target = el();
  const tl = new Timeline();
  tl.tween(target, { 0: { opacity: 0 }, 100: { opacity: 1 } }, {
    at: 0,
    duration: 1000,
    easing: 'linear',
  });
  tl.tween(target, { 0: { opacity: 1 }, 100: { opacity: 0 } }, {
    at: 500,
    duration: 500,
    easing: 'linear',
  });

  // 600ms: clip A would say 0.6, clip B (later `at`) says 0.8 and wins.
  assert.deepEqual(tl.getFrames(600)[0].styles, { opacity: '0.8' });
  // Deliberate reversal: active A now beats B's out-of-window backwards fill.
  assert.deepEqual(tl.getFrames(200)[0].styles, { opacity: '0.2' });
});

test('merging is per property: an earlier clip keeps properties the later one omits', () => {
  const target = el();
  const tl = new Timeline();
  tl.tween(target, { 0: { width: '0px' }, 100: { width: '100px' } }, {
    at: 0,
    duration: 1000,
    easing: 'linear',
  });
  tl.tween(target, { 0: { opacity: 0 }, 100: { opacity: 1 } }, {
    at: 0,
    duration: 1000,
    easing: 'linear',
  });

  assert.deepEqual(tl.getFrames(500)[0].styles, { width: '50px', opacity: '0.5' });
});

// ---- seek ----

test('seek applies styles and moves the playhead', () => {
  const target = el();
  const tl = new Timeline();
  tl.tween(target, { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000, easing: 'linear' });

  tl.seek(400);

  assert.equal(target.style.opacity, '0.4');
  assert.equal(tl.time(), 400);
});

test('time() and progress() get and set the playhead', () => {
  const target = el();
  const tl = new Timeline();
  tl.tween(target, { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000, easing: 'linear' });

  tl.time(250);
  assert.equal(tl.time(), 250);
  assert.equal(tl.progress(), 0.25);

  tl.progress(0.75);
  assert.equal(tl.time(), 750);
  assert.equal(target.style.opacity, '0.75');
});

test('seek emits seek + update; playback emits update only', async () => {
  const seeks = [];
  const updates = [];
  const tl = new Timeline();
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000 });
  tl.on('seek', (t) => seeks.push(t));
  tl.on('update', (t) => updates.push(t));

  tl.seek(300);
  assert.deepEqual(seeks, [300]);
  assert.deepEqual(updates, [300]);

  const done = tl.play();
  ticker.tick(100);
  assert.deepEqual(seeks, [300]);
  assert.deepEqual(updates, [300, 400]);

  tl.pause();
  await done;
});

test('set() writes nothing before its time and holds its styles after', () => {
  const target = el();
  const tl = new Timeline();
  tl.set(target, { opacity: 0.5 }, { at: 500 });

  assert.equal(tl.duration, 500);
  assert.deepEqual(tl.getFrames(499)[0].styles, {});
  assert.deepEqual(tl.getFrames(500)[0].styles, { opacity: '0.5' });
  assert.deepEqual(tl.getFrames(5000)[0].styles, { opacity: '0.5' });
});

test('seeking backward past a set releases the styles it wrote', () => {
  const removed = [];
  const target = {
    isConnected: true,
    style: {
      setProperty(key, value) {
        this[key] = value;
      },
      removeProperty(key) {
        removed.push(key);
        delete this[key];
      },
    },
  };
  const tl = new Timeline();
  tl.set(target, { opacity: 0.5, '--tone': 20 }, { at: 500 });

  tl.seek(500);
  assert.equal(target.style.opacity, '0.5');
  assert.equal(target.style['--tone'], '20');

  tl.seek(499);
  assert.equal(target.style.opacity, '');
  assert.equal(target.style['--tone'], undefined);
  assert.deepEqual(removed, ['--tone']);
});

test("fill: 'none' releases styles when the playhead exits the clip window", () => {
  const target = el();
  const tl = new Timeline();
  tl.tween(target, { 0: { opacity: 0 }, 100: { opacity: 1 } }, {
    duration: 1000,
    easing: 'linear',
    fill: 'none',
  });

  tl.seek(500);
  assert.equal(target.style.opacity, '0.5');

  tl.seek(1001);
  assert.equal(target.style.opacity, '');
});

test('seek does not rewrite unchanged style properties', () => {
  let opacity = '';
  let writes = 0;
  const style = {};
  Object.defineProperty(style, 'opacity', {
    configurable: true,
    enumerable: true,
    get: () => opacity,
    set: (value) => {
      opacity = value;
      writes += 1;
    },
  });
  const target = { style, isConnected: true };
  const tl = new Timeline();
  tl.tween(target, { 0: { opacity: 0 }, 100: { opacity: 1 } }, {
    duration: 1000,
    easing: 'linear',
  });

  tl.seek(500);
  tl.seek(500);

  assert.equal(opacity, '0.5');
  assert.equal(writes, 1);
});

test('fromTo is sugar for a two-keyframe clip', () => {
  const target = el();
  const tl = new Timeline();
  tl.fromTo(target, { opacity: 0.2 }, { opacity: 0.6 }, { duration: 1000, easing: 'linear' });

  assert.deepEqual(tl.getFrames(0)[0].styles, { opacity: '0.2' });
  assert.deepEqual(tl.getFrames(500)[0].styles, { opacity: '0.4' });
  assert.deepEqual(tl.getFrames(1000)[0].styles, { opacity: '0.6' });
});

test('lazy values are resolved once at build time so scrubbing repeats', () => {
  let rolls = 0;
  const target = el();
  const tl = new Timeline();
  tl.tween(target, { 0: { opacity: 0 }, 100: { opacity: () => (rolls += 1) / 4 } }, {
    duration: () => 1000,
    easing: 'linear',
  });

  assert.equal(rolls, 1);
  assert.equal(tl.duration, 1000);
  const first = tl.getFrames(1000)[0].styles.opacity;
  const second = tl.getFrames(1000)[0].styles.opacity;
  assert.equal(first, '0.25');
  assert.equal(second, '0.25');
  assert.equal(rolls, 1);
});

// ---- call ----

test('calls fire on crossing, direction-aware, including landing exactly on one', () => {
  const fired = [];
  const tl = new Timeline();
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000 });
  tl.call((d) => fired.push(['a', d]), { at: 300 });
  tl.call((d) => fired.push(['b', d]), { at: 700 });

  tl.seek(300); // landing exactly on 'a'
  assert.deepEqual(fired, [['a', 1]]);

  tl.seek(1000); // crosses 'b' only — 'a' is not re-crossed from 300
  assert.deepEqual(fired, [['a', 1], ['b', 1]]);

  tl.seek(0); // backward across both, nearest first
  assert.deepEqual(fired, [['a', 1], ['b', 1], ['b', -1], ['a', -1]]);
});

test('a jump-seek fires every crossed call exactly once', () => {
  let count = 0;
  const tl = new Timeline();
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000 });
  for (const at of [100, 200, 300, 400]) tl.call(() => (count += 1), { at });

  tl.seek(1000);
  assert.equal(count, 4);
});

test('once: true fires at most once ever', () => {
  let count = 0;
  const tl = new Timeline();
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000 });
  tl.call(() => (count += 1), { at: 500, once: true });

  tl.seek(1000);
  tl.seek(0);
  tl.seek(1000);
  assert.equal(count, 1);
});

test('once with a direction filter survives a crossing in the other direction', () => {
  let count = 0;
  const tl = new Timeline();
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000 });
  tl.call(() => (count += 1), { at: 500, once: true, direction: 1 });

  tl.seek(1000, { silent: true });
  tl.seek(0);
  assert.equal(count, 0);

  tl.seek(1000);
  tl.seek(0);
  tl.seek(1000);
  assert.equal(count, 1);
});

test('silent seeks skip callbacks but still apply styles', () => {
  let count = 0;
  const target = el();
  const tl = new Timeline();
  tl.tween(target, { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000, easing: 'linear' });
  tl.call(() => (count += 1), { at: 500 });

  tl.seek(1000, { silent: true });
  assert.equal(count, 0);
  assert.equal(target.style.opacity, '1');
});

test('call() with no `at` lands on the current end', () => {
  const tl = new Timeline();
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 400 });
  tl.call(() => {});

  assert.equal(tl._calls[0].at, 400);
});

// ---- Playback ----

test('play advances on the shared ticker, completes and resolves', async () => {
  const target = el();
  let completes = 0;
  const tl = new Timeline();
  tl.tween(target, { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000, easing: 'linear' });
  tl.on('complete', () => (completes += 1));

  const done = tl.play();
  assert.equal(tl.playing, true);
  assert.equal(target.style.opacity, '0'); // the 0% frame is painted at play()

  ticker.tick(400);
  assert.equal(target.style.opacity, '0.4');

  ticker.tick(400);
  assert.equal(target.style.opacity, '0.8');

  ticker.tick(400); // overshoots the end
  await done;

  assert.equal(tl.time(), 1000);
  assert.equal(target.style.opacity, '1');
  assert.equal(tl.playing, false);
  assert.equal(completes, 1);
});

test('pause freezes the playhead and resolves the play promise; play resumes', async () => {
  const target = el();
  const tl = new Timeline();
  tl.tween(target, { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000, easing: 'linear' });

  const done = tl.play();
  ticker.tick(300);
  tl.pause();
  await done;

  assert.equal(tl.playing, false);
  assert.equal(tl.time(), 300);

  // A ticker tick while paused must not move anything.
  ticker.tick(500);
  assert.equal(tl.time(), 300);

  const again = tl.play();
  ticker.tick(200);
  assert.equal(tl.time(), 500);
  tl.pause();
  await again;
});

test('play from the end restarts at 0', async () => {
  const tl = new Timeline();
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000 });

  tl.seek(1000);
  const done = tl.play();
  assert.equal(tl.time(), 0);

  ticker.tick(1000);
  await done;
  assert.equal(tl.time(), 1000);
});

test('loop wraps, carries the overshoot, and fires calls once per iteration', async () => {
  let count = 0;
  const tl = new Timeline({ loop: 2 });
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000 });
  tl.call(() => (count += 1), { at: 500 });

  const done = tl.play();

  ticker.tick(600); // iteration 1: crosses 500
  assert.equal(count, 1);

  ticker.tick(600); // wraps: 1000 → 0 → 200 (no backward re-firing)
  assert.equal(tl.time(), 200);
  assert.equal(count, 1);

  ticker.tick(400); // iteration 2: crosses 500
  assert.equal(count, 2);

  ticker.tick(600); // iteration 2 ends: no third iteration
  await done;

  assert.equal(tl.time(), 1000);
  assert.equal(count, 2);
});

test('an infinite loop consumes multiple periods and carries the remainder in one frame', async (t) => {
  const tl = new Timeline({ loop: true });
  t.after(() => tl.destroy());
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000 });

  const done = tl.play();
  ticker.tick(3500);

  assert.equal(tl.playing, true);
  assert.equal(tl._iteration, 3);
  assert.equal(tl.time(), 500);
  assert.notEqual(tl.time(), 0);

  tl.pause();
  await done;
});

test('a finite loop can consume all iterations and settle in one frame', async () => {
  let completes = 0;
  let resolved = false;
  const tl = new Timeline({ loop: 3 });
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000 });
  tl.on('complete', () => (completes += 1));

  const done = tl.play().then(() => {
    resolved = true;
  });
  ticker.tick(3500);
  await done;

  assert.equal(tl.time(), 1000);
  assert.equal(tl.playing, false);
  assert.equal(tl._iteration, 3);
  assert.equal(completes, 1);
  assert.equal(resolved, true);

  // A retained ticker subscription would advance and complete it again.
  ticker.tick(500);
  assert.equal(tl.time(), 1000);
  assert.equal(completes, 1);
});

test('reverse playback completes at 0, resolves, and unsubscribes', async () => {
  let completes = 0;
  let resolved = false;
  const tl = new Timeline();
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000 });
  tl.timeScale(-1);
  tl.on('complete', () => (completes += 1));

  const done = tl.play().then(() => {
    resolved = true;
  });
  assert.equal(tl.time(), 1000);

  ticker.tick(1200);
  await done;

  assert.equal(tl.time(), 0);
  assert.equal(tl.playing, false);
  assert.equal(completes, 1);
  assert.equal(resolved, true);

  ticker.tick(200);
  assert.equal(tl.time(), 0);
  assert.equal(completes, 1);
});

// The boundary the two directions disagree on: forward, `next === duration`
// floors to one whole iteration, but reverse, `next === 0` ceils to zero — so
// without the max(1, …) the playhead advanced no iteration and a non-looping
// timeline wrapped to the end forever instead of settling.
test('reverse playback that lands exactly on 0 still completes', async () => {
  let completes = 0;
  let resolved = false;
  const tl = new Timeline();
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000 });
  tl.seek(100);
  tl.timeScale(-1);
  tl.on('complete', () => (completes += 1));

  const done = tl.play().then(() => {
    resolved = true;
  });
  ticker.tick(100); // step of exactly -100 lands the playhead on 0, not past it
  await done;

  assert.equal(tl.time(), 0);
  assert.equal(tl.playing, false);
  assert.equal(completes, 1);
  assert.equal(resolved, true);
});

test('reverse looping wraps from 0 back to duration', async (t) => {
  const updates = [];
  const tl = new Timeline({ loop: 2 });
  t.after(() => tl.destroy());
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000 });
  tl.timeScale(-1);
  tl.on('update', (time) => updates.push(time));

  const done = tl.play();
  ticker.tick(1200);

  assert.equal(tl.playing, true);
  assert.equal(tl._iteration, 1);
  assert.equal(tl.time(), 800);
  assert.deepEqual(updates.slice(-3), [0, 1000, 800]);

  tl.pause();
  await done;
});

test('pause inside a call stops completion and freezes the playhead', async () => {
  let completes = 0;
  const tl = new Timeline();
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000 });
  tl.call(() => tl.pause(), { at: 500 });
  tl.on('complete', () => (completes += 1));

  const done = tl.play();
  ticker.tick(1200);
  await done;

  assert.equal(tl.playing, false);
  assert.equal(tl.time(), 1000);
  assert.equal(completes, 0);

  ticker.tick(500);
  assert.equal(tl.time(), 1000);
  assert.equal(completes, 0);
});

test('pause and resume preserve a finite loop iteration budget', async (t) => {
  let calls = 0;
  let completes = 0;
  const tl = new Timeline({ loop: 3 });
  t.after(() => tl.destroy());
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000 });
  tl.call(() => (calls += 1), { at: 500 });
  tl.on('complete', () => (completes += 1));

  const first = tl.play();
  ticker.tick(1200);
  assert.equal(tl._iteration, 1);
  assert.equal(tl.time(), 200);
  tl.pause();
  await first;

  const resumed = tl.play();
  ticker.tick(800);
  ticker.tick(500);
  ticker.tick(500);

  assert.equal(tl.playing, false);
  await resumed;
  assert.equal(tl._iteration, 3);
  assert.equal(tl.time(), 1000);
  assert.equal(calls, 3);
  assert.equal(completes, 1);
});

test('a throwing call is isolated so the shared ticker keeps advancing', async () => {
  const errors = [];
  const originalError = console.error;
  const tl = new Timeline();
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000 });
  tl.call(() => {
    throw new Error('boom');
  }, { at: 100 });

  console.error = (...args) => errors.push(args);
  const done = tl.play();
  try {
    assert.doesNotThrow(() => ticker.tick(200));
    assert.equal(tl.time(), 200);

    ticker.tick(200);
    assert.equal(tl.time(), 400);
    assert.equal(errors.length, 1);
  } finally {
    console.error = originalError;
    tl.destroy();
    await done;
  }
});

test('timeScale multiplies the playback rate', async () => {
  const tl = new Timeline();
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000 });

  assert.equal(tl.timeScale(), 1);
  tl.timeScale(2);
  assert.equal(tl.timeScale(), 2);

  const done = tl.play();
  ticker.tick(250);
  assert.equal(tl.time(), 500);

  ticker.tick(250);
  await done;
  assert.equal(tl.time(), 1000);
});

test('an empty timeline plays to completion immediately', async () => {
  let completes = 0;
  const tl = new Timeline();
  tl.on('complete', () => (completes += 1));

  await tl.play();
  assert.equal(completes, 1);
  assert.equal(tl.playing, false);
});

test('destroy unsubscribes, resolves pending playback, removes listeners, and disables playback', async () => {
  let resolved = false;
  let events = 0;
  const tl = new Timeline();
  tl.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 1000 });
  tl.on('custom', () => (events += 1));

  const done = tl.play().then(() => {
    resolved = true;
  });
  ticker.tick(200);
  tl.destroy();
  await done;

  assert.equal(resolved, true);
  assert.equal(tl.playing, false);
  assert.equal(tl.time(), 200);

  ticker.tick(500);
  tl.seek(900);
  await tl.play();
  tl.emit('custom');

  assert.equal(tl.time(), 200);
  assert.equal(events, 0);
});

// ---- Serialization ----

test('toJSON / fromJSON round-trip', () => {
  const tl = new Timeline({ loop: 2, defaults: { duration: 500, easing: 'linear' } });
  tl.tween('.box', { 0: { opacity: 0 }, 100: { opacity: 1 } }, { duration: 800, stagger: 100 });
  tl.label('mid');
  tl.set('.dot', { opacity: 1 }, { at: 'mid' });
  tl.fromTo('.bar', { width: '0px' }, { width: '10px' }, { at: 0, easing: 'ease-out', fill: 'none' });

  const json = tl.toJSON();

  assert.deepEqual(json.options, { loop: 2, defaults: { duration: 500, easing: 'linear' } });
  assert.deepEqual(json.labels, { mid: 800 });
  assert.equal(json.clips.length, 3);
  assert.deepEqual(json.clips[0], {
    kind: 'tween',
    target: '.box',
    at: 0,
    keyframes: { 0: { opacity: 0 }, 100: { opacity: 1 } },
    duration: 800,
    easing: 'linear',
    fill: 'both',
    stagger: 100,
  });
  assert.deepEqual(json.clips[1], {
    kind: 'set',
    target: '.dot',
    at: 800,
    styles: { opacity: 1 },
    fill: 'forwards',
  });

  const rebuilt = Timeline.fromJSON(json);
  assert.deepEqual(rebuilt.toJSON(), json);
  assert.equal(rebuilt.duration, tl.duration);
});

test('toJSON throws for element targets and function easings', () => {
  const elementTargets = new Timeline();
  elementTargets.tween(el(), { 0: { opacity: 0 }, 100: { opacity: 1 } });
  assert.throws(() => elementTargets.toJSON(), /selector strings/);

  const fnEasing = new Timeline();
  fnEasing.tween('.box', { 0: { opacity: 0 }, 100: { opacity: 1 } }, { easing: (t) => t });
  assert.throws(() => fnEasing.toJSON(), /function easings/);
});
