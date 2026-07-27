import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticker } from '@magic-spells/animation-engine';

import { ScrollDriver } from '../src/scroll-driver.js';

/* ------------------------------------------------------------------ fakes */

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

test('refresh re-seeks a smoothed driver and snaps its playhead', () => {
  const { scroller, timeline, driver } = fixture({ smoothing: 100 });

  // Mapped progress is unchanged, but refresh() still has to re-assert it: the
  // layout it was computed from moved, which is the only reason `force` exists.
  const before = timeline.seeks.length;
  driver.refresh();
  assert.equal(timeline.seeks.length, before + 1);
  assert.equal(timeline.last().time, 0);

  // Mid-flight, refresh snaps rather than keeping on easing from a position
  // the stale range produced.
  scroller.scrollTo(1400);
  ticker.tick(16);
  assert.ok(driver._current > 0 && driver._current < 1, 'mid-ease before refresh');

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
