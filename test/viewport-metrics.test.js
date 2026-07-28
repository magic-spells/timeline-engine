import { test } from 'node:test';
import assert from 'node:assert/strict';

import { viewportMetrics } from '../src/viewport-metrics.js';

/* ------------------------------------------------------------------ fakes */

/**
 * Install a global for one test and restore it afterwards. A leaked
 * `document`/`CSS` here would silently change what every later test measures.
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

/** Minimal element stand-in: enough DOM for the probe and its container. */
function makeElement(rectHeight = 0) {
  return {
    style: {},
    attrs: {},
    children: [],
    parentNode: null,
    rectHeight,
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    remove() {
      const parent = this.parentNode;
      if (!parent) return;
      const i = parent.children.indexOf(this);
      if (i !== -1) parent.children.splice(i, 1);
      this.parentNode = null;
    },
    getBoundingClientRect() {
      return { top: 0, bottom: this.rectHeight, height: this.rectHeight };
    },
  };
}

/**
 * A document whose created elements all measure `probeHeight` (only the probe
 * is ever measured) and which records what was made.
 * @param {number} probeHeight
 */
function makeDocument(probeHeight) {
  const created = [];
  return {
    documentElement: makeElement(),
    created,
    createElement() {
      const el = makeElement(probeHeight);
      created.push(el);
      return el;
    },
  };
}

/** A CSS stand-in recording every query it was asked. */
function makeCSS(supported) {
  const queries = [];
  return {
    queries,
    supports(query) {
      queries.push(query);
      return supported;
    },
  };
}

/* ------------------------------------------------------------------ tests */

test('without a document it reports the live viewport', (t) => {
  t.after(() => viewportMetrics._reset());
  stubGlobal(t, 'innerHeight', 900);

  assert.equal(viewportMetrics.height(), 900);
  assert.equal(viewportMetrics.probe, null);

  // visualViewport is the more accurate of the two when it exists.
  stubGlobal(t, 'visualViewport', { height: 740 });
  assert.equal(viewportMetrics.height(), 740);
});

test('no probe is created without 100svh support', (t) => {
  t.after(() => viewportMetrics._reset());
  const doc = makeDocument(1000);
  const css = makeCSS(false);
  stubGlobal(t, 'document', doc);
  stubGlobal(t, 'CSS', css);
  stubGlobal(t, 'innerHeight', 620);

  assert.equal(viewportMetrics.height(), 620);
  assert.deepEqual(css.queries, ['height: 100svh']);
  assert.equal(doc.created.length, 0, 'nothing appended to a browser that cannot measure it');
});

test('no CSS object at all falls back instead of throwing', (t) => {
  t.after(() => viewportMetrics._reset());
  const doc = makeDocument(1000);
  stubGlobal(t, 'document', doc);
  stubGlobal(t, 'innerHeight', 620);

  assert.equal('CSS' in globalThis, false, 'Node has no CSS — the stripped-host case');
  assert.equal(viewportMetrics.height(), 620);
  assert.equal(doc.created.length, 0);
});

test('the probe is created once and reused', (t) => {
  t.after(() => viewportMetrics._reset());
  const doc = makeDocument(800);
  stubGlobal(t, 'document', doc);
  stubGlobal(t, 'CSS', makeCSS(true));
  stubGlobal(t, 'innerHeight', 600);

  viewportMetrics.height();
  viewportMetrics.height();
  viewportMetrics.height();

  assert.equal(doc.created.length, 2, 'one container, one probe');
  assert.equal(doc.documentElement.children.length, 1);
  assert.equal(doc.documentElement.children[0].attrs['aria-hidden'], 'true');
  assert.equal(viewportMetrics.probe.style.height, '100svh');
});

test('the probe height wins over a chrome-shrunk viewport', (t) => {
  t.after(() => viewportMetrics._reset());
  stubGlobal(t, 'document', makeDocument(800));
  stubGlobal(t, 'CSS', makeCSS(true));
  // What the URL bar sliding into view does to the live numbers.
  stubGlobal(t, 'innerHeight', 640);
  stubGlobal(t, 'visualViewport', { height: 640 });

  assert.equal(viewportMetrics.height(), 800);
});

test('a probe that measures zero falls back to the live viewport', (t) => {
  t.after(() => viewportMetrics._reset());
  stubGlobal(t, 'document', makeDocument(0));
  stubGlobal(t, 'CSS', makeCSS(true));
  stubGlobal(t, 'innerHeight', 640);

  // Detached, display:none ancestor, or a browser that lies about svh.
  assert.equal(viewportMetrics.height(), 640);
  assert.ok(viewportMetrics.probe, 'the probe still exists, it just measured nothing');
});

test('_reset detaches the probe and the next read rebuilds it', (t) => {
  t.after(() => viewportMetrics._reset());
  const doc = makeDocument(800);
  stubGlobal(t, 'document', doc);
  stubGlobal(t, 'CSS', makeCSS(true));
  stubGlobal(t, 'innerHeight', 600);

  assert.equal(viewportMetrics.height(), 800);

  viewportMetrics._reset();
  assert.equal(viewportMetrics.probe, null);
  assert.equal(viewportMetrics.container, null);
  assert.equal(doc.documentElement.children.length, 0, 'no orphan left in the document');

  assert.equal(viewportMetrics.height(), 800);
  assert.equal(doc.created.length, 4, 'a fresh pair, not a resurrected one');
});
