# @magic-spells/timeline-engine

## Purpose

Deterministic, scrubable animation timeline. Places keyframe "clips" — target +
frame-engine keyframes + easing — at offset start times on one shared time axis, then lets
anything own the playhead: the clock (`play()`/`pause()` on the shared ticker), direct
scrubbing (`seek(time)` / `progress(p)`), or scroll position (`scrollDriver`). The
complement to `@magic-spells/animation-engine`, whose scenes are async chains that
deliberately *can't* seek.

## Architecture

**A timeline is a pure function of time.** `getFrames(time)` returns every target's styles
at that time with no DOM writes and no side effects — conceptually a bunch of FrameEngines
with offset start times. `seek(time)` is `getFrames` + `writeStyles` + firing crossed
`call`s. Everything (scrubbing, timed playback, scroll driving) goes through `seek`.

`writeStyles` is not `Object.assign`: it diffs against the last frame written to that
element (kept in a `WeakMap`), so it skips unchanged properties on the scroll hot path,
routes `--custom-props` through `setProperty`, and — the part that makes the purity claim
true of the *DOM* and not just of `getFrames` — clears properties the new frame no longer
contributes, instead of leaving the last value stuck on the element.

**No physics on the scrubbed path — by design.** A spring has no closed-form
position-at-time, so scrubbed clips are easing/cubic-bezier only. Physics-based
animation-engine scenes are still first-class: trigger them from a timeline position
(`call`) or from the viewport (`viewTrigger`) and they play forward in real time. This split
(scrub = deterministic beziers, trigger = anything) is the intended way to combine the two.

**Clip windows and fill.** A clip occupies `[at, at + duration]`. Outside its window, `fill`
decides: `'both'` (default) holds the 0%/100% frames — before its window a clip pins its
start state, after it holds its end state, which is what scroll storytelling wants.
Overlapping clips on one element merge **active-beats-fill**: `getFrames` runs two passes,
applying out-of-window (fill) contributions first and in-window ones second, so a clip
that is actually animating always outranks one merely holding an edge frame. Ties inside
each pass break by ascending `at`, so two in-window clips still resolve later-wins.

That two-pass rule replaces a strict ascending-`at` merge, deliberately and against a test
that asserted the old behavior: with one pass, appending a second clip to an element made
the first one invisible (the later clip's backwards fill outranked the earlier clip's live
interpolation), which silently broke the README's own chaining example. If you are tempted
to simplify this back to one pass, that is the regression you will reintroduce.

`at` defaults to the timeline's current end (clips append sequentially); labels name
positions. A negative `stagger` means reverse order — the per-element offset is
`at + (stagger >= 0 ? i : last - i) * |stagger|`, so the clip window still begins at `at`
rather than running backwards off the front of the timeline.

**Sparse keyframes are filled before reaching frame-engine** via animation-engine's
`fillSparseKeyframes` — same CSS `@keyframes` semantics, same shipped-bug rationale (see
animation-engine's CLAUDE.md).

**Per-clip FrameEngine instances are built once at `tween()` time**, keyframes parsed
upfront; scrubbing is pure math on the hot path. Lazy values (`rand()`) are resolved once at
build time — scrubbing must be repeatable, so re-rolling randomness per iteration
(animation-engine's behavior) does not exist here.

Selector targets are snapshotted the same way, and deliberately never re-queried — but a
selector matching nothing used to fail *completely* silently (`duration`, `seek`, `play`
and `toJSON` all behave normally while nothing animates), which is exactly what a
`fromJSON` running before its markup mounts hits. `resolveTargets` now warns, naming the
selector. Don't "fix" this with a re-query: build-once is what keeps the hot path pure and
the stagger stable.

**Timed playback rides animation-engine's shared ticker** — one rAF loop across the whole
ecosystem, `timeScale` composes, and in Node tests drive time manually with
`ticker.tick(ms)`. `play()` returns a promise; `loop` wraps at the end (timed playback
only — scroll driving ignores loop). `destroy()` releases the subscription.

"One rAF loop" is only true if the page has **one copy** of animation-engine. The UMD
build inlines it (ticker singleton included), so a page loading both that bundle and a
separate animation-engine script gets two tickers — which is exactly the bug the demo
shipped with. Hence the entry point re-exports `scene`/`ticker`/`rand`: script-tag
consumers reach the engine through us instead of loading it twice.

**`_advance` is symmetric.** It picks its bound from the sign of the step, so a negative
`timeScale` is real reverse playback that settles at 0 (or wraps `0 → duration` when
looping) exactly as forward playback settles at `duration` — not an unbounded walk into
negative time. It also consumes whole periods per frame (`periods`/`remainder`) rather
than one, so a frame longer than the timeline's own duration doesn't discard the carry.
Every `_seek` that can fire user callbacks is followed by an `if (!this._playing) return`
guard, because a `call` is free to invoke `pause()` mid-frame.

**User callbacks never escape into the ticker.** `call.fn`, `emit`, the driver's zone
callbacks and `_smooth` are all wrapped: the ticker re-arms its rAF only after `tick()`
returns while its internal `running` flag stays true, so one uncaught throw would
permanently kill every animation on the page — this timeline, every other timeline, and
every animation-engine scene — with no way to restart it.

**`call`s fire on crossing, direction-aware.** Seeking from t₁ to t₂ fires every `call`
strictly inside the crossed interval (and landing on t₂) with `+1`/`-1` direction; `once`
limits to a single firing; `seek(t, { silent: true })` (and `scrollDriver`'s `silent`)
suppresses them. Jump-seeks fire every crossed call exactly once — no skipping. An
optional `direction` filters which way counts, and it is checked *before* `once` is
consumed — otherwise a single backward scrub burns a forward-only `once` before it ever
fires, which is what the README's own trigger idiom used to do.

**ScrollDriver maps a px range to progress.** `start`/`end` use ScrollTrigger-style
`"<triggerPoint> <viewportPoint>"` syntax (`'top bottom'` → progress 0 when the trigger's
top hits the viewport's bottom). The px range is computed in `refresh()` (re-run on resize,
rAF-throttled); scroll listeners are passive and rAF-throttled. `smoothing` (ms
time-constant) lerps the playhead toward the scroll target via a ticker subscription
instead of locking to it — `refresh(force)` snaps such a driver rather than easing, or it
would silently do nothing when mapped progress hasn't changed. Vertical axis only.

The constructor adopts the current scroll position so a mid-scroll reload paints
correctly, and that bootstrap seek is **unconditionally silent** regardless of `silent` —
otherwise every `call` below the restored position fires at load, off-screen. The flip
side: `_zone` is seeded from that same bootstrap, so `onEnter` cannot fire for a page
loaded already inside the range.

**Serialization is a first-class constraint.** Clips store plain JSON-able config;
`toJSON()`/`fromJSON()` round-trip any timeline whose targets were added as selector
strings. A future timeline-editor web app draws timelines and exports this shape — don't add
clip state that can't serialize (functions, element refs) without a string form.

## Key files

- `src/timeline.js` — Timeline class: clip placement, getFrames/seek, playback, JSON
- `src/clip.js` — clip construction: target resolution, sparse fill, FrameEngine, stagger
- `src/scroll-driver.js` — scroll → progress mapping, range parsing, smoothing
- `src/view-trigger.js` — IntersectionObserver enter/leave triggering
- `src/timeline-engine.js` — entry point / public exports
- `src/timeline-engine.d.ts` — public TypeScript declarations (keep in sync)
- `demo/index.html` — scroll showcase (port 3070); loads the built UMD, not `src/`

## Commands

- `npm run dev` — Vite dev server at localhost:3070 (opens demo/index.html)
- `npm test` — Node built-in test runner over `test/*.test.js` (all deterministic; fake
  time via `ticker.tick`, fake elements as `{ style: {} }` objects, fake scroller objects)
- `npm run build` — TWO Vite passes keyed off `BUILD_FORMAT`: `es` (externalizes
  `@magic-spells/*` deps) then `umd` (self-contained `dist/timeline-engine.min.js`,
  global `TimelineEngine`). Keep the split — same rationale as animation-engine.

## Demo & GitHub Pages

Same setup as animation-engine (see its CLAUDE.md for the full rationale): the demo is
served statically at `https://magic-spells.github.io/timeline-engine/demo/` off `main`,
so **`dist/` is committed deliberately** and **the demo loads the UMD via script tag**
(`src/` bare-imports `@magic-spells/*` deps a static host can't resolve). Rebuild + commit
`dist/` alongside any change meant to show up in the demo.

The demo loads **only** that one bundle and takes `scene` from `TimelineEngine`. It used
to also load a vendored `animation-engine.min.js`, which gave the page two tickers; don't
reintroduce a second engine script.

## Conventions

- Plain JS + JSDoc, `.d.ts` maintained by hand — no TypeScript sources.
- Dependencies stay published npm versions, never `file:` links.
- Demo code asides must show the REAL code driving each section.
- Time is milliseconds everywhere; keyframe keys are percents (0-100) like frame-engine.
