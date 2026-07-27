import { test } from 'node:test';
import assert from 'node:assert/strict';

import { viewTrigger } from '../src/view-trigger.js';

/* ------------------------------------------------------------------ fakes */

/** Records what was observed and lets tests push entries by hand. */
class FakeObserver {
  static instances = [];

  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.observed = [];
    this.disconnected = false;
    FakeObserver.instances.push(this);
  }

  observe(el) {
    this.observed.push(el);
  }

  unobserve(el) {
    const i = this.observed.indexOf(el);
    if (i !== -1) this.observed.splice(i, 1);
  }

  disconnect() {
    this.disconnected = true;
    this.observed.length = 0;
  }

  /** @param {Array<[object, boolean]>} pairs - [element, isIntersecting] */
  emit(pairs) {
    this.callback(
      pairs.map(([target, isIntersecting]) => ({ target, isIntersecting })),
      this
    );
  }
}

/**
 * Install the fake for one test, returning a helper to grab the observer.
 * @param {object} t - The node:test context.
 */
function withObserver(t) {
  const original = globalThis.IntersectionObserver;
  FakeObserver.instances = [];
  globalThis.IntersectionObserver = FakeObserver;
  t.after(() => {
    if (original === undefined) delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = original;
  });
  return () => FakeObserver.instances[FakeObserver.instances.length - 1];
}

const el = (id) => ({ id, style: {} });

/* ------------------------------------------------------------------ tests */

test('fires enter and leave for an observed element', (t) => {
  const latest = withObserver(t);
  const a = el('a');
  const events = [];

  const trigger = viewTrigger(a, {
    enter: (e) => events.push(['enter', e.id]),
    leave: (e) => events.push(['leave', e.id]),
  });

  const io = latest();
  assert.deepEqual(io.observed, [a]);

  // The initial not-intersecting report must not read as a leave.
  io.emit([[a, false]]);
  assert.deepEqual(events, []);

  io.emit([[a, true]]);
  io.emit([[a, true]]); // repeat intersection reports are idempotent
  io.emit([[a, false]]);

  assert.deepEqual(events, [
    ['enter', 'a'],
    ['leave', 'a'],
  ]);

  trigger.destroy();
});

test('once unobserves each element after its enter and disconnects at the end', (t) => {
  const latest = withObserver(t);
  const a = el('a');
  const b = el('b');
  const events = [];

  viewTrigger([a, b], {
    once: true,
    enter: (e) => events.push(['enter', e.id]),
    leave: (e) => events.push(['leave', e.id]),
  });

  const io = latest();
  assert.deepEqual(io.observed, [a, b]);

  io.emit([[a, true]]);
  assert.deepEqual(io.observed, [b]);
  assert.equal(io.disconnected, false);

  // Already-fired elements never report a leave.
  io.emit([[a, false]]);
  assert.deepEqual(events, [['enter', 'a']]);

  io.emit([[b, true]]);
  assert.equal(io.disconnected, true);
  assert.deepEqual(events, [
    ['enter', 'a'],
    ['enter', 'b'],
  ]);

  // Nothing fires after the observer is gone.
  io.emit([[b, true]]);
  assert.deepEqual(events, [
    ['enter', 'a'],
    ['enter', 'b'],
  ]);
});

test('one observer covers array, array-like and selector targets', (t) => {
  const latest = withObserver(t);
  const a = el('a');
  const b = el('b');

  const fromArray = viewTrigger([a, b], { enter() {} });
  assert.deepEqual(latest().observed, [a, b]);
  assert.equal(FakeObserver.instances.length, 1);
  fromArray.destroy();

  const nodeList = { length: 2, 0: a, 1: b, [Symbol.iterator]: [a, b][Symbol.iterator].bind([a, b]) };
  const fromList = viewTrigger(nodeList, { enter() {} });
  assert.deepEqual(latest().observed, [a, b]);
  fromList.destroy();

  const originalDocument = globalThis.document;
  globalThis.document = { querySelectorAll: () => [a, b] };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });

  const fromSelector = viewTrigger('.card', { enter() {} });
  assert.deepEqual(latest().observed, [a, b]);
  fromSelector.destroy();
});

test('a style-bearing target is one element even when it has a length', (t) => {
  const latest = withObserver(t);
  // <form> and <select> both carry a `length`. Targets resolve through the same
  // helper clips use, so this must observe the element itself rather than
  // expanding it as an array-like — the two rules used to disagree here.
  const form = { id: 'form', style: {}, length: 2, 0: el('a'), 1: el('b') };

  viewTrigger(form, { enter() {} });
  assert.deepEqual(latest().observed, [form]);
});

test('threshold and rootMargin default and pass through', (t) => {
  const latest = withObserver(t);

  viewTrigger(el('a'), { enter() {} });
  assert.deepEqual(latest().options, { threshold: 0, rootMargin: '0px' });

  viewTrigger(el('b'), { enter() {}, threshold: [0, 0.5, 1], rootMargin: '-10% 0px' });
  assert.deepEqual(latest().options, { threshold: [0, 0.5, 1], rootMargin: '-10% 0px' });
});

test('destroy disconnects and silences callbacks', (t) => {
  const latest = withObserver(t);
  const a = el('a');
  let entered = 0;

  const trigger = viewTrigger(a, { enter: () => (entered += 1) });
  const io = latest();

  trigger.destroy();
  assert.equal(io.disconnected, true);

  io.emit([[a, true]]);
  assert.equal(entered, 0);

  trigger.destroy(); // idempotent
});

test('falls back to intersectionRatio when isIntersecting is absent', (t) => {
  const latest = withObserver(t);
  const a = el('a');
  const events = [];

  viewTrigger(a, { enter: () => events.push('enter'), leave: () => events.push('leave') });
  const io = latest();

  io.callback([{ target: a, intersectionRatio: 0.4 }], io);
  io.callback([{ target: a, intersectionRatio: 0 }], io);

  assert.deepEqual(events, ['enter', 'leave']);
});

test('throws a clear error without IntersectionObserver', () => {
  const original = globalThis.IntersectionObserver;
  delete globalThis.IntersectionObserver;
  try {
    assert.throws(() => viewTrigger(el('a'), { enter() {} }), /IntersectionObserver is not available/);
  } finally {
    if (original !== undefined) globalThis.IntersectionObserver = original;
  }
});
