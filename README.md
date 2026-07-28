# @magic-spells/timeline-engine

Scrubable animation timeline for the magic-spells ecosystem. Place keyframe clips at
offset start times on one time axis, then let anything drive the playhead — the clock,
a scrub position, or the scroll bar.

Think of it as a bunch of
[`@magic-spells/frame-engine`](https://github.com/magic-spells/frame-engine)s with offset
start times: the whole timeline is a pure function of time, so you can ask for the frame
at any millisecond, jump around freely, and bind progress straight to scroll. It's the
deterministic complement to
[`@magic-spells/animation-engine`](https://github.com/magic-spells/animation-engine),
whose async scenes deliberately can't seek.

🔍 **[Live Demo](https://magic-spells.github.io/timeline-engine/demo/)** - See it in action!

## Install

```sh
npm install @magic-spells/timeline-engine
```

Or self-contained via script tag (global `TimelineEngine`):

```html
<script src="https://unpkg.com/@magic-spells/timeline-engine"></script>
```

The script-tag build **inlines animation-engine** (14.6 kB gzipped, vs 5.8 kB for the
npm build, which leaves its `@magic-spells/*` deps external), so it re-exports `scene`,
`ticker`, `rand` and `registerPhysics` for you. Reach for those rather than loading
animation-engine with a second script tag — two copies means two ticker singletons and
two rAF loops, and `ticker.timeScale` would move one and not the other:

```js
const { timeline, scene, ticker } = TimelineEngine;  // one bundle, one ticker
```

It does **not** bundle the spring. If you want `{ physics }` scene steps, add
physics-engine's own script tag — it's dependency-free and has no singleton, so a second
script is harmless here — and register it through us:

```html
<script src="https://unpkg.com/@magic-spells/physics-engine"></script>
<script src="https://unpkg.com/@magic-spells/timeline-engine"></script>
```

```js
TimelineEngine.registerPhysics(PhysicsEngine);  // once, before any physics step
```

## Quick start

```js
import { timeline } from '@magic-spells/timeline-engine';

const tl = timeline();

tl.tween(
  '.hero',
  {
    0: { opacity: '0', transform: 'translateY(40px)' },
    100: { opacity: '1', transform: 'translateY(0px)' },
  },
  { at: 0, duration: 1000, easing: 'ease-out' }
)
  .tween('.card', { 0: { opacity: '0' }, 100: { opacity: '1' } }, { at: 400, duration: 800, stagger: 120 })
  .label('finale')
  .fromTo('.badge', { transform: 'scale(0)' }, { transform: 'scale(1)' }, { at: 'finale', easing: 'back-out' });

tl.seek(650);       // jump the playhead to 650ms — styles applied
tl.getFrames(650);  // …or just ask: [{ element, styles }], no DOM writes
tl.progress(0.5);   // seek by fraction
await tl.play();    // or play it like an animation
```

Clips append sequentially by default; pass `at` (a time in ms or a label) to position them
freely, and overlap them at will. Outside its window a clip holds its edge frames
(`fill: 'both'` — the default), so scrubbing anywhere always shows a complete picture.

**When two clips touch the same property of the same element**, the one actually
animating wins: an in-window clip always beats a clip that is merely holding an edge
frame, so chaining a fade-in and a fade-out on one element does what it looks like. When
both are in-window, the later-starting one wins. Per property, so an earlier clip keeps
properties the later one never mentions.

### Fill modes

| `fill` | Before its window | After its window |
| --- | --- | --- |
| `'both'` (default for `tween`/`fromTo`) | holds the 0% frame | holds the 100% frame |
| `'forwards'` (default for `set`) | contributes nothing | holds the 100% frame |
| `'backwards'` | holds the 0% frame | contributes nothing |
| `'none'` | contributes nothing | contributes nothing |

A property a clip stops contributing is released — `seek` clears it rather than leaving
the last value stuck on the element, so the same time always renders the same frame no
matter how you got there.

### Lazy values

Anywhere a value is accepted you can pass a zero-arg function returning one, which is how
animation-engine's `rand()` composes. Lazy values are resolved **once, at build time** —
scrubbing has to be repeatable, so a `rand()` is not re-rolled per frame:

```js
import { timeline, rand } from '@magic-spells/timeline-engine';

tl.tween(
  '.confetti',
  { 0: { opacity: '0', rotate: rand(-15, 15, 'deg') }, 100: { opacity: '1', rotate: '0deg' } },
  { duration: rand(600, 1200), stagger: rand(40, 120) }
);
```

## Scroll driving

Bind the playhead to a scroll range — the timeline scrubs as the user scrolls:

```js
import { timeline, scrollDriver } from '@magic-spells/timeline-engine';

const tl = timeline();
tl.tween('.panel', { 0: { transform: 'translateX(-100px)' }, 100: { transform: 'translateX(0px)' } });

const driver = scrollDriver(tl, {
  trigger: '#story',      // element defining the scroll range
  start: 'top bottom',    // progress 0: #story's top hits the viewport's bottom
  end: 'bottom top',      // progress 1: #story's bottom hits the viewport's top
  smoothing: 120,         // optional: ease the playhead toward the scroll position (ms)
});

// later: driver.refresh() after layout changes, driver.destroy() to unbind
```

`start`/`end` accept `"<triggerPoint> <viewportPoint>"` with `top`/`center`/`bottom` or
percentages (`'25% 80%'`), absolute pixel positions, or functions returning pixels.

Notes worth knowing before you wire one up:

- **Vertical scrolling only.** A horizontally-scrolling container maps to progress 0 and
  stays there.
- The driver **adopts the current scroll position in its constructor** so a page loaded or
  restored mid-scroll paints correctly. That bootstrap is silent: no timeline `call`s fire
  for it, whatever `silent` is set to.
- For the same reason `onEnter` cannot fire for a page loaded *already inside* the range —
  the driver starts out in that zone, and `onEnter` reports the transition into it.
- Attach `'update'` listeners to the timeline **before** constructing the driver, or the
  bootstrap frame lands before anything is listening.

**Mobile viewports are stable, with no configuration.** When the scroller is the window,
the driver measures the viewport with a hidden `100svh` probe rather than `innerHeight`, so
a URL bar sliding in and out doesn't move your scroll range under the user mid-scroll. The
resize events that animation fires still recompute the range — they just find the same one,
and a refresh that finds an unchanged range re-seeks nothing, which is what keeps a
smoothed playhead from being snapped on every frame of that animation.

## Triggering, and the physics question

Scrubbed clips are easing/cubic-bezier only — a physics spring has no closed-form
position-at-time, so it can't be sampled at an arbitrary playhead. Springs aren't locked
out, though: **trigger** an animation-engine scene from the timeline or the viewport and
it plays forward in real time, physics included.

Physics is no longer bundled. As of animation-engine 0.2.0 the spring is injected —
install `@magic-spells/physics-engine` and register it once, or a `{ physics }` step
throws.

```js
import { scene, registerPhysics } from '@magic-spells/animation-engine';
import PhysicsEngine from '@magic-spells/physics-engine';
import { timeline, viewTrigger } from '@magic-spells/timeline-engine';

registerPhysics(PhysicsEngine); // springs are opt-in — register once

const pop = scene().to('.bubble', { transform: 'scale(1)' }, { physics: { friction: 0.12 } });

// From a timeline position (fires when the playhead crosses, scrubbing included):
const tl = timeline();
tl.tween('.bg', { 0: { opacity: '0' }, 100: { opacity: '1' } });
tl.call(() => pop.play(), { at: 800, once: true, direction: 1 });

// Or from the viewport (play-when-scrolled-into-view):
viewTrigger('.bubble-section', { enter: () => pop.play(), once: true });
```

Combine freely: scroll-scrub one timeline while viewport triggers fire scenes as sections
arrive.

## API

### `timeline(options?)` → `Timeline`

| Option | Default | Meaning |
| --- | --- | --- |
| `defaults` | `{ duration: 1000, easing: 'ease' }` | Inherited by clips |
| `loop` | `1` | `true` = infinite, number = iterations (timed playback only) |

**Building** — all chainable:

- `.tween(target, keyframes, { at, duration, easing, fill, stagger })` — keyframes are
  percent-keyed (0-100) CSS objects, camelCase props, sparse keyframes get CSS
  `@keyframes` semantics. `stagger` offsets each element of a multi-element target; a
  negative `stagger` staggers in reverse order, still starting at `at`.
- `.fromTo(target, from, to, opts)` — sugar for `{ 0: from, 100: to }`.
- `.set(target, styles, { at, fill })` — instant styles from `at` onward
  (`fill` defaults to `'forwards'`).
- `.call(fn, { at, once, direction })` — fired when the playhead crosses `at`, with `1`
  (forward) or `-1` (backward). `direction` limits it to one of those; `once` fires at
  most once for the timeline's lifetime. A `call` at exactly `0` only fires when crossed
  backward, since forward playback starts *at* 0 rather than crossing it.
- `.label(name, time?)` — name a time (default: current end) for use as `at`.

Targets given as selector strings are resolved **once, when the clip is added**. Build
your timeline after the markup exists; elements inserted later are not picked up.

**Playhead**:

- `.getFrames(time)` — pure: `[{ element, styles }]` at `time`, no writes, no callbacks.
- `.seek(time, { silent? })` / `.time(t)` — apply styles, fire crossed calls.
- `.progress(p)` — seek by 0-1 fraction; no-arg forms of `time`/`progress` read.
- `.play()` → promise, `.pause()`, `.playing`, `.timeScale(n)`, `.duration`.
- `.destroy()` — release the ticker subscription, resolve a pending `play()`, drop
  listeners. Worth calling for a `loop: true` timeline you're done with.
- Events: `'update'`, `'seek'`, `'complete'`.

`timeScale` is signed: a **negative rate plays in reverse**, and reverse playback settles
at 0 (or wraps `0 → duration` when looping) exactly as forward playback settles at
`duration`. `pause()` keeps the playhead *and* the remaining loop iterations, so a
following `play()` resumes rather than restarting the loop budget.

A timeline writes nothing to the DOM until its first `seek`/`play` — constructing one
must not disturb the page. For a clock-driven timeline whose elements should sit at
their start states before playback, paint them with `tl.progress(0)` after building.

**Serialization** — `.toJSON()` / `fromJSON(data)` round-trip any timeline whose targets
were added as selector strings (built for a future visual timeline editor).

### `scrollDriver(timeline, options?)` → `ScrollDriver`

| Option | Default | Meaning |
| --- | --- | --- |
| `trigger` | — | Element or selector defining the scroll range |
| `start` / `end` | `'top bottom'` / `'bottom top'` | Range points (see above) |
| `scroller` | `window` | Scroll container |
| `smoothing` | `0` | ms time-constant; `0` locks playhead to scroll |
| `silent` | `false` | Suppress `call`s while scrubbing (the constructor's bootstrap seek is always silent) |
| `onEnter` / `onLeave` / `onEnterBack` / `onLeaveBack` / `onProgress` | — | Range callbacks |

Instance: `.progress`, `.refresh()`, `.destroy()`. Call `.refresh()` after any layout
change; it re-measures the px range and re-asserts the playhead — but only if the range
actually moved. Vertical axis only.

### `viewTrigger(target, { enter, leave, once, threshold, rootMargin })` → `{ destroy() }`

IntersectionObserver wrapper for play-on-scroll-into-view. One observer covers every
target. `once` is **per element** — each element stops being observed after its own first
`enter` (so `leave` never fires for it), and the observer disconnects itself once the last
one has fired.

## Development

```sh
npm run dev    # demo at localhost:3070
npm test       # deterministic Node tests (fake time via the shared ticker)
npm run build  # ESM (deps externalized) + self-contained UMD
```

## License

MIT

---

<p align="center">
  Made by <a href="https://github.com/coryschulz">Cory Schulz</a>
</p>
