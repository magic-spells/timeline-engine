import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticker } from '@magic-spells/animation-engine';

import { ScrollDriver } from '../src/scroll-driver.js';
import { viewportMetrics } from '../src/viewport-metrics.js';

/* ------------------------------------------------------------------ fakes */

/**
 * Install a global for one test and restore it afterwards. Anything left
 * behind here — a stray `window` above all — changes which branch every later
 * test takes.
 * @param {object} t - Test context.
 * @param {string} name
 * @param {*} value
 */
function stubGlobal(t, name, value) {
  const had = name in globalThis;
  const original = globalThis[name];
  globalThis[name] = value;
  t.after(() => {
    if (had) globalThis[name] = original;
    else delete globalThis[name];
  });
}

/**
 * Stub requestAnimationFrame and hand back the queue of pending callbacks.
 * The suite normally runs without rAF (that is what makes it synchronous);
 * stub one in to observe scheduling itself.
 * @param {object} t - Test context.
 * @returns {Array<() => void>}
 */
function captureFrames(t) {
  const frames = [];
  stubGlobal(t, 'requestAnimationFrame', (fn) => frames.push(fn));
  return frames;
}

/**
 * A window-like scroll container with capturable listeners.
 * @param {number} [innerHeight]
 */
function makeScroller(innerHeight = 800) {
  const listeners = new Map();
  return {
    scrollY: 0,
    innerHeight,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    count(type) {
      return listeners.get(type)?.size ?? 0;
    },
    dispatch(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn({ type });
    },
    scrollTo(y) {
      this.scrollY = y;
      this.dispatch('scroll');
    },
  };
}

/**
 * A trigger element whose rect is derived from a document position and the
 * scroller's current offset — exactly how a real one behaves.
 * @param {object} scroller
 * @param {number} top - Position in document space.
 * @param {number} height
 */
function makeTrigger(scroller, top, height) {
  return {
    top,
    height,
    getBoundingClientRect() {
      const t = this.top - scroller.scrollY;
      return { top: t, bottom: t + this.height, height: this.height, left: 0, right: 0, width: 0 };
    },
  };
}

/** Minimal timeline stand-in recording every seek. */
function makeTimeline(duration = 1000) {
  return {
    duration,
    seeks: [],
    seek(time, opts) {
      this.seeks.push({ time, opts });
      return this;
    },
    last() {
      return this.seeks[this.seeks.length - 1];
    },
  };
}

/** Standard fixture: viewport 800, trigger at document 1000, 400 tall. */
function fixture(options = {}) {
  const scroller = makeScroller(800);
  const trigger = makeTrigger(scroller, 1000, 400);
  const timeline = makeTimeline(1000);
  const driver = new ScrollDriver(timeline, { trigger, scroller, ...options });
  return { scroller, trigger, timeline, driver };
}

/* ------------------------------------------------------------ range parse */

test('default range is "top bottom" → "bottom top"', () => {
  const { driver } = fixture();
  // start: 1000 + 0*400 - 800*1 = 200 ; end: 1000 + 1*400 - 800*0 = 1400
  assert.equal(driver._startPx, 200);
  assert.equal(driver._endPx, 1400);
  driver.destroy();
});

test('keyword and percentage points resolve to px', () => {
  const { driver } = fixture({ start: 'center center', end: '25% 80%' });
  assert.equal(driver._startPx, 1000 + 200 - 400); // 800
  assert.equal(driver._endPx, 1000 + 100 - 640); // 460
  driver.destroy();
});

test('single-token points align against the viewport top', () => {
  const { driver } = fixture({ start: 'bottom', end: '50%' });
  assert.equal(driver._startPx, 1400);
  assert.equal(driver._endPx, 1200);
  driver.destroy();
});

test('numeric and function points are absolute scroll positions', () => {
  const { driver } = fixture({ start: 100, end: () => 500 });
  assert.equal(driver._startPx, 100);
  assert.equal(driver._endPx, 500);
  driver.destroy();

  const { driver: strDriver } = fixture({ start: '250', end: 900 });
  assert.equal(strDriver._startPx, 250);
  assert.equal(strDriver._endPx, 900);
  strDriver.destroy();
});

test('unrecognised point tokens throw', () => {
  const scroller = makeScroller();
  assert.throws(
    () => new ScrollDriver(makeTimeline(), { scroller, start: 'sideways bottom' }),
    /unrecognised scroll point/
  );
});

/* --------------------------------------------------------------- mapping */

test('maps scroll position onto progress and clamps at both ends', () => {
  const { scroller, timeline, driver } = fixture();

  scroller.scrollTo(200);
  assert.equal(driver.progress, 0);

  scroller.scrollTo(800);
  assert.equal(driver.progress, 0.5);
  assert.equal(timeline.last().time, 500);

  scroller.scrollTo(1400);
  assert.equal(driver.progress, 1);
  assert.equal(timeline.last().time, 1000);

  scroller.scrollTo(4000);
  assert.equal(driver.progress, 1);

  scroller.scrollTo(-500);
  assert.equal(driver.progress, 0);

  driver.destroy();
});

test('zero-length range switches instead of dividing by zero', () => {
  const scroller = makeScroller();
  const timeline = makeTimeline(1000);
  const driver = new ScrollDriver(timeline, { scroller, start: 500, end: 500 });

  scroller.scrollTo(499);
  assert.equal(driver.progress, 0);
  scroller.scrollTo(500);
  assert.equal(driver.progress, 1);
  assert.ok(Number.isFinite(timeline.last().time));

  driver.destroy();
});

test('silent option passes through to seek', () => {
  const { scroller, timeline, driver } = fixture({ silent: true });
  scroller.scrollTo(800);
  assert.deepEqual(timeline.last().opts, { silent: true });
  driver.destroy();

  const plain = fixture();
  plain.scroller.scrollTo(800);
  assert.deepEqual(plain.timeline.last().opts, { silent: false });
  plain.driver.destroy();
});

test('falls back to progress() when the timeline has no seek', () => {
  const scroller = makeScroller();
  const trigger = makeTrigger(scroller, 1000, 400);
  const calls = [];
  const timeline = { progress: (p) => calls.push(p) };
  const driver = new ScrollDriver(timeline, { trigger, scroller });

  scroller.scrollTo(800);
  assert.deepEqual(calls, [0, 0.5]);
  driver.destroy();
});

test('applies the current scroll position on construction', () => {
  const scroller = makeScroller(800);
  const trigger = makeTrigger(scroller, 1000, 400);
  const timeline = makeTimeline(1000);
  scroller.scrollY = 800;

  const driver = new ScrollDriver(timeline, { trigger, scroller });
  assert.equal(driver.progress, 0.5);
  assert.equal(timeline.seeks.length, 1);
  assert.equal(timeline.seeks[0].time, 500);

  driver.destroy();
});

test('the bootstrap seek is silent even when silent is false', () => {
  const scroller = makeScroller(800);
  const trigger = makeTrigger(scroller, 1000, 400);
  const timeline = makeTimeline(1000);
  scroller.scrollY = 800; // reload restored halfway through the range

  const driver = new ScrollDriver(timeline, { trigger, scroller, silent: false });

  // Adopting a scroll position is not scrolling through it: firing every call
  // between 0 and 500ms here would detonate the whole first half off-screen.
  assert.deepEqual(timeline.seeks[0].opts, { silent: true });

  // Only the bootstrap is forced — real scrolling still fires calls.
  scroller.scrollTo(1100);
  assert.deepEqual(timeline.last().opts, { silent: false });

  driver.destroy();
});

/* ------------------------------------------------------------- callbacks */

test('fires enter/leave/enterBack/leaveBack on zone transitions', () => {
  const events = [];
  const { scroller, driver } = fixture({
    onEnter: () => events.push('enter'),
    onLeave: () => events.push('leave'),
    onEnterBack: () => events.push('enterBack'),
    onLeaveBack: () => events.push('leaveBack'),
  });

  // Construction below the range must not report an entry.
  assert.deepEqual(events, []);

  scroller.scrollTo(800);
  scroller.scrollTo(1400);
  scroller.scrollTo(2000);
  scroller.scrollTo(800);
  scroller.scrollTo(0);

  assert.deepEqual(events, ['enter', 'leave', 'enterBack', 'leaveBack']);

  // A jump across the whole range reports both edges it crossed.
  events.length = 0;
  scroller.scrollTo(4000);
  assert.deepEqual(events, ['enter', 'leave']);

  events.length = 0;
  scroller.scrollTo(-100);
  assert.deepEqual(events, ['enterBack', 'leaveBack']);

  driver.destroy();
});

test('onProgress fires on every raw progress change only', () => {
  const seen = [];
  const { scroller, driver } = fixture({ onProgress: (p) => seen.push(p) });

  scroller.scrollTo(800);
  scroller.scrollTo(800);
  scroller.scrollTo(1100);
  scroller.scrollTo(4000);
  scroller.scrollTo(5000); // still clamped at 1 — no change

  assert.deepEqual(seen, [0.5, 0.75, 1]);
  driver.destroy();
});

test('a throwing zone or progress callback cannot escape the driver', (t) => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  t.after(() => {
    console.error = originalError;
  });

  const { scroller, timeline, driver } = fixture({
    onEnter: () => {
      throw new Error('boom enter');
    },
    onProgress: () => {
      throw new Error('boom progress');
    },
  });

  // These run inside a rAF callback (and, for smoothed drivers, inside the
  // shared ticker); one throw there stops the loop re-arming and kills every
  // animation on the page.
  assert.doesNotThrow(() => scroller.scrollTo(800));
  assert.equal(errors.length, 2);

  // And a bad callback must not stall the playhead behind it.
  assert.equal(timeline.last().time, 500);

  driver.destroy();
});

/* ------------------------------------------------- refresh / resize / life */

test('refresh recomputes the range after the trigger moves', () => {
  const { scroller, trigger, timeline, driver } = fixture();

  scroller.scrollTo(800);
  assert.equal(driver.progress, 0.5);

  trigger.top = 1600; // start 800, end 2000
  driver.refresh();

  assert.equal(driver._startPx, 800);
  assert.equal(driver._endPx, 2000);
  assert.equal(driver.progress, 0);
  assert.equal(timeline.last().time, 0);

  driver.destroy();
});

test('resize triggers a refresh', () => {
  const { scroller, driver } = fixture();
  assert.equal(scroller.count('resize'), 1);

  scroller.scrollTo(800);
  assert.equal(driver.progress, 0.5);

  scroller.innerHeight = 400; // start 600, end 1400
  scroller.dispatch('resize');

  assert.equal(driver._startPx, 600);
  assert.equal(driver.progress, 0.25);

  driver.destroy();
});

test('a resize that leaves the range alone is a no-op', () => {
  const { scroller, timeline, driver } = fixture();

  scroller.scrollTo(800);
  const seeks = timeline.seeks.length;

  // Mobile chrome sliding away fires resize without moving anything the range
  // is computed from; re-asserting the playhead there is what jerks it.
  scroller.dispatch('resize');
  scroller.dispatch('resize');

  assert.equal(driver._startPx, 200);
  assert.equal(driver.progress, 0.5);
  assert.equal(timeline.seeks.length, seeks);

  driver.destroy();
});

test('the range must move more than half a pixel to force a re-seek', () => {
  const { trigger, timeline, driver } = fixture();
  const seeks = timeline.seeks.length;

  trigger.top = 1000.25; // sub-pixel jitter, which a chrome animation produces
  driver.refresh();
  assert.equal(driver._startPx, 200.25, 'the range is recomputed either way');
  assert.equal(timeline.seeks.length, seeks, 'nothing is re-asserted for it');

  trigger.top = 1002.25;
  driver.refresh();
  assert.equal(timeline.seeks.length, seeks + 1);

  driver.destroy();
});

test('resize refreshes once per frame, not once per event', (t) => {
  // The suite normally runs without rAF (that is what makes it synchronous and
  // deterministic); stub one in to observe the throttle itself.
  const original = globalThis.requestAnimationFrame;
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  t.after(() => {
    if (original === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = original;
  });

  const { scroller, driver } = fixture();
  let refreshes = 0;
  const real = driver.refresh.bind(driver);
  driver.refresh = () => {
    refreshes += 1;
    real();
  };

  scroller.innerHeight = 400; // start 600, end 1400
  scroller.dispatch('resize');
  scroller.dispatch('resize');
  scroller.dispatch('resize');

  // refresh() forces a layout read plus a full re-seek — a resize drag must
  // not pay that per event.
  assert.equal(refreshes, 0, 'nothing runs before the frame does');
  assert.equal(frames.length, 1, 'three events, one scheduled frame');

  frames[0]();
  assert.equal(refreshes, 1);
  assert.equal(driver._startPx, 600);

  // The next burst schedules a fresh frame.
  scroller.dispatch('resize');
  assert.equal(frames.length, 2);

  driver.destroy();
});

test('destroy removes every listener and stops updating', () => {
  const { scroller, timeline, driver } = fixture();
  assert.equal(scroller.count('scroll'), 1);
  assert.equal(scroller.count('resize'), 1);

  driver.destroy();
  assert.equal(scroller.count('scroll'), 0);
  assert.equal(scroller.count('resize'), 0);

  const seekCount = timeline.seeks.length;
  scroller.scrollTo(800);
  assert.equal(timeline.seeks.length, seekCount);

  // The timeline keeps its last state.
  assert.equal(timeline.last().time, 0);
});

/* ------------------------------------------------------- stable viewport */

test('the real window measures a stable viewport height, fakes do not', (t) => {
  const fakeWindow = makeScroller(800);
  stubGlobal(t, 'window', fakeWindow);
  // No document here, so the 100svh probe cannot exist and viewportMetrics
  // falls back to visualViewport — a different number from innerHeight, which
  // is exactly what proves which branch ran.
  stubGlobal(t, 'visualViewport', { height: 600 });
  t.after(() => viewportMetrics._reset());

  const trigger = makeTrigger(fakeWindow, 1000, 400);
  const driver = new ScrollDriver(makeTimeline(1000), { trigger });

  assert.equal(driver._startPx, 400, '1000 - 600, not 1000 - 800');
  assert.equal(driver._endPx, 1400);
  driver.destroy();

  // The branch is an identity check, not duck-typing: a window-shaped fake
  // keeps reporting its own innerHeight even while a real window exists.
  const fake = fixture();
  assert.equal(fake.driver._startPx, 200);
  fake.driver.destroy();
});

/* ---------------------------------------------------------- off-range gate */

test('scrolling outside the range schedules no frames', (t) => {
  const frames = captureFrames(t);
  const { scroller, timeline, driver } = fixture();
  const seeks = timeline.seeks.length;

  // Range is 200 → 1400; everything below 200 maps to a pinned 0.
  scroller.scrollTo(50);
  scroller.scrollTo(120);
  scroller.scrollTo(199);
  assert.equal(frames.length, 0, 'pinned progress costs nothing per event');
  assert.equal(timeline.seeks.length, seeks);

  // Entering the range falls through — once, the existing throttle covers the
  // rest of the burst.
  scroller.scrollTo(800);
  scroller.scrollTo(1100);
  assert.equal(frames.length, 1);
  frames[0]();
  assert.equal(driver.progress, 0.75);

  scroller.scrollTo(4000);
  assert.equal(frames.length, 2);
  frames[1]();
  assert.equal(driver.progress, 1);

  // Past the end it goes quiet again.
  const applied = timeline.seeks.length;
  scroller.scrollTo(9000);
  scroller.scrollTo(12000);
  assert.equal(frames.length, 2);
  assert.equal(timeline.seeks.length, applied);

  driver.destroy();
});

test('a jump across the whole range still fires both edges', (t) => {
  const frames = captureFrames(t);
  const events = [];
  const { scroller, driver } = fixture({
    onEnter: () => events.push('enter'),
    onLeave: () => events.push('leave'),
  });

  // The skip is progress-based, not visibility-based, on purpose: an
  // IntersectionObserver gate gets no callback for a jump like this at all.
  scroller.scrollTo(4000);
  assert.equal(frames.length, 1, 'progress changed, so the frame is scheduled');
  frames[0]();
  assert.deepEqual(events, ['enter', 'leave']);

  driver.destroy();
});

/* ------------------------------------------------------------- smoothing */

test('smoothing lerps toward the scroll target and settles', () => {
  const { scroller, timeline, driver } = fixture({ smoothing: 100 });

  scroller.scrollTo(1400); // raw target = 1
  assert.equal(driver.progress, 1);
  // Smoothed drivers do not seek on the scroll event itself.
  assert.equal(timeline.seeks.length, 1);

  ticker.tick(16);
  const first = timeline.last().time;
  assert.ok(Math.abs(first - 1000 * (1 - Math.exp(-0.16))) < 1e-9);

  let previous = first;
  for (let i = 0; i < 200; i += 1) {
    ticker.tick(16);
    const now = timeline.last().time;
    assert.ok(now >= previous, 'progress must advance monotonically');
    previous = now;
  }

  assert.equal(timeline.last().time, 1000); // snapped exactly
  const settled = timeline.seeks.length;
  ticker.tick(16);
  ticker.tick(16);
  assert.equal(timeline.seeks.length, settled, 'no work once settled');

  driver.destroy();
});

test('refresh snaps a smoothed driver when the range actually moved', () => {
  const { scroller, trigger, timeline, driver } = fixture({ smoothing: 100 });

  // A refresh that finds the same range does nothing at all. Deliberate: this
  // test used to assert the opposite, and mobile chrome resizes fire
  // continuously — re-asserting there snaps every smoothed driver on the page.
  const before = timeline.seeks.length;
  driver.refresh();
  assert.equal(timeline.seeks.length, before);

  // Mid-flight, a refresh whose range *did* move snaps rather than keeping on
  // easing from a position the stale range produced.
  scroller.scrollTo(1400);
  ticker.tick(16);
  assert.ok(driver._current > 0 && driver._current < 1, 'mid-ease before refresh');

  trigger.top = 900; // start 100, end 1300 — scroll 1400 is still past the end
  driver.refresh();
  assert.equal(driver._current, 1);
  assert.equal(driver._target, 1);
  assert.equal(timeline.last().time, 1000);

  // Snapping also releases the ticker — there is nothing left to ease toward.
  const settled = timeline.seeks.length;
  ticker.tick(16);
  ticker.tick(16);
  assert.equal(timeline.seeks.length, settled);

  driver.destroy();
});

test('a chrome-driven resize does not snap a mid-ease smoothed driver', () => {
  const { scroller, driver } = fixture({ smoothing: 100 });

  scroller.scrollTo(1400);
  ticker.tick(16);
  const mid = driver._current;
  assert.ok(mid > 0 && mid < 1, 'mid-ease');

  scroller.dispatch('resize'); // same viewport height → same range
  assert.equal(driver._current, mid, 'the ease survives the resize storm');

  ticker.tick(16);
  assert.ok(driver._current > mid, 'and keeps going');

  driver.destroy();
});

test('smoothing unsubscribes from the shared ticker once settled', () => {
  const original = ticker.subscribe.bind(ticker);
  let active = 0;
  ticker.subscribe = (fn) => {
    active += 1;
    const off = original(fn);
    return () => {
      active -= 1;
      off();
    };
  };

  try {
    const { scroller, driver } = fixture({ smoothing: 100 });
    assert.equal(active, 0, 'idle driver holds no subscription');

    scroller.scrollTo(1400);
    assert.equal(active, 1);

    for (let i = 0; i < 200; i += 1) ticker.tick(16);
    assert.equal(active, 0, 'settled driver releases the ticker');

    // A later scroll re-subscribes.
    scroller.scrollTo(800);
    assert.equal(active, 1);

    driver.destroy();
    assert.equal(active, 0, 'destroy releases the ticker mid-flight');
  } finally {
    delete ticker.subscribe;
  }
});

/* -------------------------------------------------------- element scroller */

test('element scrollers use scrollTop/clientHeight and their own rect', () => {
  const listeners = new Map();
  const scroller = {
    scrollTop: 0,
    clientHeight: 500,
    getBoundingClientRect: () => ({ top: 50, bottom: 550, height: 500 }),
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn({ type });
    },
  };
  // Content at 600 inside the scroller: rect.top = 50 + 600 - scrollTop.
  const trigger = {
    getBoundingClientRect: () => ({ top: 50 + 600 - scroller.scrollTop, height: 200, bottom: 0 }),
  };
  const timeline = makeTimeline(1000);
  const driver = new ScrollDriver(timeline, { trigger, scroller });

  // start: 600 + 0 - 500 = 100 ; end: 600 + 200 - 0 = 800
  assert.equal(driver._startPx, 100);
  assert.equal(driver._endPx, 800);

  scroller.scrollTop = 450;
  scroller.dispatch('scroll');
  assert.equal(driver.progress, 0.5);

  driver.destroy();
  assert.equal(listeners.get('scroll').size, 0);
});
