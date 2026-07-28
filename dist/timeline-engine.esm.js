import e from "@magic-spells/event-emitter";
import { fillSparseKeyframes as t, rand as n, registerPhysics as r, resolveEasing as i, scene as a, ticker as o, ticker as s } from "@magic-spells/animation-engine";
import c from "@magic-spells/frame-engine";
//#region src/clip.js
function l(e) {
	if (e == null) return [];
	if (typeof e == "string") {
		if (typeof document > "u" || !document.querySelectorAll) return [];
		let t = Array.from(document.querySelectorAll(e));
		return t.length === 0 && console.warn(`Timeline: selector "${e}" matched no elements — this clip will animate nothing. Targets are resolved once, when the clip is added.`), t;
	}
	return Array.isArray(e) ? e : typeof e.length == "number" && typeof e != "function" && e.style === void 0 && e.nodeType === void 0 ? Array.from(e) : [e];
}
function u(e) {
	return typeof e == "function" ? e() : e;
}
function d(e) {
	let t = {};
	for (let n in e) t[n] = u(e[n]);
	return t;
}
function f(e) {
	let t = {};
	for (let n in e) t[n] = d(e[n]);
	return t;
}
function p({ kind: e, target: n, keyframes: r, styles: a, at: o, duration: s, easing: u, fill: p, stagger: m }) {
	let h = l(n), g = e === "set" ? (() => {
		let e = d(a);
		return {
			0: e,
			100: e
		};
	})() : f(r), _ = new c(t(g));
	return {
		kind: e,
		target: n,
		elements: h,
		keyframes: g,
		styles: e === "set" ? g[0] : null,
		fe: _,
		at: o,
		duration: s,
		easingSpec: u,
		easing: u === void 0 ? (e) => e : i(u),
		fill: p,
		stagger: m || 0,
		frame0: _.getFrame(0),
		frame1: _.getFrame(1)
	};
}
function m(e, t) {
	let n = Math.max(e.elements.length - 1, 0), r = e.stagger >= 0 ? t : n - t;
	return e.at + r * Math.abs(e.stagger);
}
function h(e) {
	let t = Math.max(e.elements.length - 1, 0);
	return m(e, e.stagger >= 0 ? t : 0) + e.duration;
}
function g(e, t, n) {
	let r = m(e, t);
	return n < r ? -1 : +(n > r + e.duration);
}
function _(e, t, n) {
	let r = g(e, t, n);
	if (r === -1) return e.fill === "both" || e.fill === "backwards" ? e.frame0 : null;
	if (r === 1) return e.fill === "both" || e.fill === "forwards" ? e.frame1 : null;
	let i = m(e, t), a = e.duration > 0 ? (n - i) / e.duration : 1;
	return e.fe.getFrame(e.easing(a));
}
//#endregion
//#region src/timeline.js
var v = 1e3, y = "ease";
function b(e, t, n = {}) {
	for (let r in n) r in t || (r.startsWith("--") && typeof e.style.removeProperty == "function" ? e.style.removeProperty(r) : e.style[r] = "");
	for (let r in t) n[r] !== t[r] && (r.startsWith("--") && typeof e.style.setProperty == "function" ? e.style.setProperty(r, String(t[r])) : e.style[r] = t[r]);
}
var x = class t extends e {
	constructor(e = {}) {
		super(), this._defaults = e.defaults ?? {}, this._loop = e.loop ?? 1, this._clips = [], this._calls = [], this._labels = {}, this._time = 0, this._timeScale = 1, this._applied = !1, this._written = /* @__PURE__ */ new WeakMap(), this._playing = !1, this._playPromise = null, this._resolvePlay = null, this._onTick = null, this._iteration = 0, this._destroyed = !1, this._sorted = null, this._duration = null;
	}
	tween(e, t, n = {}) {
		return this._addClip({
			kind: "tween",
			target: e,
			keyframes: t,
			at: this._resolveAt(n.at),
			duration: u(n.duration) ?? u(this._defaults.duration) ?? v,
			easing: n.easing ?? this._defaults.easing ?? y,
			fill: n.fill ?? "both",
			stagger: u(n.stagger) ?? 0
		}), this;
	}
	fromTo(e, t, n, r = {}) {
		return this.tween(e, {
			0: t,
			100: n
		}, r);
	}
	set(e, t, n = {}) {
		return this._addClip({
			kind: "set",
			target: e,
			styles: t,
			at: this._resolveAt(n.at),
			duration: 0,
			easing: void 0,
			fill: n.fill ?? "forwards",
			stagger: 0
		}), this;
	}
	call(e, t = {}) {
		return this._calls.push({
			fn: e,
			at: this._resolveAt(t.at),
			once: !!t.once,
			direction: t.direction,
			fired: !1
		}), this;
	}
	label(e, t) {
		return this._labels[e] = t === void 0 ? this.duration : t, this;
	}
	get duration() {
		if (this._duration === null) {
			let e = 0;
			for (let t of this._clips) e = Math.max(e, h(t));
			this._duration = e;
		}
		return this._duration;
	}
	get playing() {
		return this._playing;
	}
	getFrames(e) {
		let t = /* @__PURE__ */ new Map(), n = this._sortedClips();
		for (let r of n) r.elements.forEach((n, i) => {
			let a = t.get(n);
			if (a === void 0 && (a = {}, t.set(n, a)), g(r, i, e) === 0) return;
			let o = _(r, i, e);
			o && Object.assign(a, o);
		});
		for (let r of n) r.elements.forEach((n, i) => {
			if (g(r, i, e) !== 0) return;
			let a = t.get(n), o = _(r, i, e);
			o && Object.assign(a, o);
		});
		let r = [];
		for (let [e, n] of t) r.push({
			element: e,
			styles: n
		});
		return r;
	}
	seek(e, t = {}) {
		return this._destroyed ? this : this._seek(e, !!t.silent, !0);
	}
	time(e) {
		return e === void 0 ? this._time : this.seek(e);
	}
	progress(e) {
		let t = this.duration;
		return e === void 0 ? t > 0 ? this._time / t : 0 : this.seek(e * t);
	}
	timeScale(e) {
		return e === void 0 ? this._timeScale : (this._timeScale = e, this);
	}
	play() {
		if (this._destroyed) return Promise.resolve();
		if (this._playing) return this._playPromise;
		let e = this.duration;
		if (e <= 0) return this._seek(0, !1, !1), this.emit("complete"), Promise.resolve();
		let t = this._timeScale < 0;
		return (t ? this._time <= 0 : this._time >= e) ? (this._seek(t ? e : 0, !0, !1), this._iteration = 0) : this._applied || this._seek(this._time, !0, !1), this._playing = !0, this._playPromise = new Promise((e) => {
			this._resolvePlay = e;
		}), this._onTick = (e) => {
			try {
				this._advance(e);
			} catch (e) {
				console.error(e);
			}
		}, s.subscribe(this._onTick), this._playPromise;
	}
	pause() {
		return this._playing && this._settle(!1), this;
	}
	destroy() {
		return this._destroyed ? this : (this._settle(!1), this.removeAllListeners(), this._destroyed = !0, this);
	}
	toJSON() {
		let e = { clips: this._clips.map((e) => {
			if (typeof e.target != "string") throw Error("Timeline.toJSON(): clips can only serialize targets added as selector strings.");
			let t = {
				kind: e.kind,
				target: e.target,
				at: e.at
			};
			if (e.kind === "set") t.styles = e.styles;
			else {
				if (t.keyframes = e.keyframes, t.duration = e.duration, typeof e.easingSpec != "string") throw Error("Timeline.toJSON(): function easings cannot serialize; use a named or cubic-bezier() easing.");
				t.easing = e.easingSpec;
			}
			return t.fill = e.fill, e.stagger && (t.stagger = e.stagger), t;
		}) };
		Object.keys(this._labels).length > 0 && (e.labels = { ...this._labels });
		let t = {};
		if (this._loop !== 1 && (t.loop = this._loop), Object.keys(this._defaults).length > 0) {
			if (this._defaults.easing !== void 0 && typeof this._defaults.easing != "string") throw Error("Timeline.toJSON(): function easings cannot serialize; use a named or cubic-bezier() easing.");
			t.defaults = { ...this._defaults };
		}
		return Object.keys(t).length > 0 && (e.options = t), e;
	}
	static fromJSON(e) {
		let n = new t(e.options);
		if (e.labels) for (let t in e.labels) n.label(t, e.labels[t]);
		for (let t of e.clips || []) t.kind === "set" ? n.set(t.target, t.styles, {
			at: t.at,
			fill: t.fill
		}) : n.tween(t.target, t.keyframes, {
			at: t.at,
			duration: t.duration,
			easing: t.easing,
			fill: t.fill,
			stagger: t.stagger
		});
		return n;
	}
	_resolveAt(e) {
		let t = u(e);
		if (t == null) return this.duration;
		if (typeof t == "string") {
			if (!(t in this._labels)) throw Error(`Timeline: unknown label "${t}".`);
			return this._labels[t];
		}
		return t;
	}
	_addClip(e) {
		this._clips.push(p(e)), this._sorted = null, this._duration = null;
	}
	_sortedClips() {
		return this._sorted === null && (this._sorted = this._clips.map((e, t) => ({
			clip: e,
			index: t
		})).sort((e, t) => e.clip.at - t.clip.at || e.index - t.index).map((e) => e.clip)), this._sorted;
	}
	_seek(e, t, n) {
		if (this._destroyed) return this;
		let r = this._time;
		for (let { element: t, styles: n } of this.getFrames(e)) b(t, n, this._written.get(t)), this._written.set(t, { ...n });
		if (this._time = e, this._applied = !0, t || this._fireCalls(r, e), n) try {
			this.emit("seek", e);
		} catch (e) {
			console.error(e);
		}
		try {
			this.emit("update", e);
		} catch (e) {
			console.error(e);
		}
		return this;
	}
	_fireCalls(e, t) {
		if (t === e || this._calls.length === 0) return;
		let n = t > e, r = this._calls.filter((r) => n ? r.at > e && r.at <= t : r.at < e && r.at >= t);
		r.sort((e, t) => n ? e.at - t.at : t.at - e.at);
		let i = n ? 1 : -1;
		for (let e of r) if (!(e.direction !== void 0 && e.direction !== i) && !(e.once && e.fired)) {
			e.fired = !0;
			try {
				e.fn(i);
			} catch (e) {
				console.error(e);
			}
		}
	}
	_advance(e) {
		let t = this.duration, n = e * this._timeScale;
		if (n === 0) return;
		let r = n < 0, i = this._time + n, a = r ? 0 : t;
		if (r ? i > a : i < a) {
			this._seek(i, !1, !1);
			return;
		}
		let o = r ? Math.max(1, Math.ceil(-i / t)) : Math.floor(i / t), s = r ? i + o * t : i - o * t;
		this._iteration += o;
		let c = this._loop === !0 ? Infinity : typeof this._loop == "number" ? this._loop : 1;
		if (this._seek(a, !1, !1), this._playing) {
			if (this._iteration >= c) {
				this._settle(!0);
				return;
			}
			this._seek(r ? t : 0, !0, !1), this._playing && this._seek(s, !1, !1);
		}
	}
	_settle(e) {
		this._onTick &&= (s.unsubscribe(this._onTick), null), this._playing = !1;
		let t = this._resolvePlay;
		this._resolvePlay = null, this._playPromise = null;
		try {
			e && this.emit("complete");
		} finally {
			t && t();
		}
	}
}, S = "position: fixed; top: 0; left: 0; width: 0; height: 0; overflow: hidden; visibility: hidden; pointer-events: none; z-index: -1;";
function C() {
	return globalThis.visualViewport?.height || globalThis.innerHeight || 0;
}
var w = {
	probe: null,
	container: null,
	init() {
		if (this.probe || typeof document > "u" || !document.documentElement) return;
		let e = globalThis.CSS;
		if (typeof e?.supports != "function" || !e.supports("height: 100svh")) return;
		let t = document.createElement("div"), n = document.createElement("div");
		t.setAttribute("aria-hidden", "true"), t.style.cssText = S, n.style.height = "100svh", t.appendChild(n), document.documentElement.appendChild(t), this.container = t, this.probe = n;
	},
	height() {
		if (this.init(), this.probe) {
			let e = this.probe.getBoundingClientRect().height;
			if (e) return e;
		}
		return C();
	},
	_reset() {
		typeof this.container?.remove == "function" && this.container.remove(), this.container = null, this.probe = null;
	}
}, T = 5e-4, E = .5, D = {
	top: 0,
	start: 0,
	center: .5,
	middle: .5,
	bottom: 1,
	end: 1
};
function O(e) {
	return e < 0 ? 0 : e > 1 ? 1 : e;
}
function k() {
	return typeof requestAnimationFrame == "function";
}
function A(e, t) {
	if (typeof e == "function") try {
		e(t);
	} catch (e) {
		console.error(e);
	}
}
function j(e, t) {
	let n = e.toLowerCase();
	if (n in D) return D[n];
	if (n.endsWith("%")) {
		let e = parseFloat(n);
		if (!Number.isNaN(e)) return e / 100;
	}
	throw Error(`ScrollDriver: unrecognised scroll point "${e}" in "${t}" — use top | center | bottom or a percentage like "25%".`);
}
function M(e) {
	if (typeof e == "function") return {
		kind: "fn",
		fn: e
	};
	if (typeof e == "number") return {
		kind: "px",
		value: e
	};
	if (typeof e != "string") throw Error(`ScrollDriver: invalid scroll point ${String(e)}.`);
	let t = e.trim().split(/\s+/);
	if (t.length === 1 && !t[0].endsWith("%") && !(t[0].toLowerCase() in D)) {
		let e = parseFloat(t[0]);
		if (!Number.isNaN(e)) return {
			kind: "px",
			value: e
		};
	}
	return {
		kind: "align",
		trigger: j(t[0], e),
		viewport: j(t[1] === void 0 ? "top" : t[1], e)
	};
}
var N = class {
	constructor(e, t = {}) {
		this._timeline = e, this._options = t, this._scroller = t.scroller ?? (typeof window < "u" ? window : null), this._trigger = F(t.trigger), this._start = M(t.start ?? "top bottom"), this._end = M(t.end ?? "bottom top"), this._smoothing = t.smoothing ?? 0, this._silent = t.silent ?? !1, this._startPx = 0, this._endPx = 0, this._progress = 0, this._zone = 0, this._current = 0, this._target = 0, this._unsubscribe = null, this._rafId = null, this._resizeRafId = null, this._destroyed = !1, this._onScroll = () => this._schedule(), this._onResize = () => this._scheduleRefresh(), this._onTick = (e) => this._smooth(e), this._recompute(), this._progress = this._computeProgress(), this._zone = P(this._progress), this._current = this._progress, this._target = this._progress, this._seek(this._progress, !0), this._attach();
	}
	get progress() {
		return this._progress;
	}
	refresh() {
		if (this._destroyed) return;
		let e = this._startPx, t = this._endPx;
		this._recompute();
		let n = Math.abs(this._startPx - e) > E || Math.abs(this._endPx - t) > E;
		this._apply(n);
	}
	destroy() {
		this._destroyed || (this._destroyed = !0, this._detach(), this._stopSmoothing(), typeof cancelAnimationFrame == "function" && (this._rafId !== null && cancelAnimationFrame(this._rafId), this._resizeRafId !== null && cancelAnimationFrame(this._resizeRafId)), this._rafId = null, this._resizeRafId = null);
	}
	_scrollPos() {
		let e = this._scroller;
		return e ? typeof e.scrollY == "number" ? e.scrollY : typeof e.pageYOffset == "number" ? e.pageYOffset : typeof e.scrollTop == "number" ? e.scrollTop : 0 : 0;
	}
	_viewportHeight() {
		let e = this._scroller;
		return e ? typeof window < "u" && e === window ? w.height() : typeof e.innerHeight == "number" ? e.innerHeight : typeof e.clientHeight == "number" ? e.clientHeight : 0 : 0;
	}
	get _isWindowScroller() {
		let e = this._scroller;
		return !!e && typeof e.innerHeight == "number";
	}
	_triggerBox() {
		let e = this._trigger;
		if (!e || typeof e.getBoundingClientRect != "function") return {
			top: 0,
			height: 0
		};
		let t = e.getBoundingClientRect(), n = typeof t.height == "number" ? t.height : t.bottom - t.top, r = this._scrollPos();
		if (this._isWindowScroller) return {
			top: t.top + r,
			height: n
		};
		let i = this._scroller, a = i && typeof i.getBoundingClientRect == "function" ? i.getBoundingClientRect().top : 0;
		return {
			top: t.top - a + r,
			height: n
		};
	}
	_resolvePoint(e) {
		if (e.kind === "px") return e.value;
		if (e.kind === "fn") {
			let t = Number(e.fn());
			return Number.isFinite(t) ? t : 0;
		}
		let t = this._triggerBox();
		return t.top + e.trigger * t.height - this._viewportHeight() * e.viewport;
	}
	_recompute() {
		this._startPx = this._resolvePoint(this._start), this._endPx = this._resolvePoint(this._end);
	}
	_computeProgress() {
		let e = this._endPx - this._startPx;
		return e === 0 ? +(this._scrollPos() >= this._startPx) : O((this._scrollPos() - this._startPx) / e);
	}
	_schedule() {
		if (this._destroyed) return;
		let e = this._computeProgress();
		if (!(e === this._progress && P(e) === this._zone && (e === 0 || e === 1))) {
			if (!k()) {
				this._apply(!1);
				return;
			}
			this._rafId === null && (this._rafId = requestAnimationFrame(() => {
				this._rafId = null, this._destroyed || this._apply(!1);
			}));
		}
	}
	_scheduleRefresh() {
		if (!this._destroyed) {
			if (!k()) {
				this.refresh();
				return;
			}
			this._resizeRafId === null && (this._resizeRafId = requestAnimationFrame(() => {
				this._resizeRafId = null, this._destroyed || this.refresh();
			}));
		}
	}
	_apply(e) {
		let t = this._computeProgress(), n = t !== this._progress;
		this._progress = t;
		let r = P(t);
		if (r !== this._zone) {
			let e = this._zone;
			this._zone = r, this._fireZone(e, r);
		}
		if (n && A(this._options.onProgress, t), this._smoothing > 0) {
			if (this._target = t, e) {
				this._current = t, this._stopSmoothing(), this._seek(t);
				return;
			}
			Math.abs(this._target - this._current) > T && this._startSmoothing();
			return;
		}
		(n || e) && (this._current = t, this._seek(t));
	}
	_fireZone(e, t) {
		let n = this._options;
		t > e ? (e === -1 && A(n.onEnter), t === 1 && A(n.onLeave)) : (e === 1 && A(n.onEnterBack), t === -1 && A(n.onLeaveBack));
	}
	_seek(e, t = !1) {
		let n = this._timeline;
		if (n) {
			if (typeof n.seek == "function") {
				let r = typeof n.duration == "number" ? n.duration : 0;
				n.seek(e * r, { silent: t || this._silent });
				return;
			}
			typeof n.progress == "function" && n.progress(e);
		}
	}
	_startSmoothing() {
		this._unsubscribe || this._destroyed || (this._unsubscribe = s.subscribe(this._onTick));
	}
	_stopSmoothing() {
		this._unsubscribe &&= (this._unsubscribe(), null);
	}
	_smooth(e) {
		try {
			let t = this._target - this._current;
			if (Math.abs(t) <= T) {
				this._current !== this._target && (this._current = this._target, this._seek(this._current)), this._stopSmoothing();
				return;
			}
			this._current += t * (1 - Math.exp(-e / this._smoothing)), this._seek(this._current);
		} catch (e) {
			console.error(e), this._stopSmoothing();
		}
	}
	_attach() {
		let e = this._scroller;
		e && typeof e.addEventListener == "function" && e.addEventListener("scroll", this._onScroll, { passive: !0 });
		let t = this._isWindowScroller ? e : typeof window < "u" ? window : null;
		this._resizeTarget = t, t && typeof t.addEventListener == "function" && t.addEventListener("resize", this._onResize);
	}
	_detach() {
		let e = this._scroller;
		e && typeof e.removeEventListener == "function" && e.removeEventListener("scroll", this._onScroll);
		let t = this._resizeTarget;
		t && typeof t.removeEventListener == "function" && t.removeEventListener("resize", this._onResize), this._resizeTarget = null;
	}
};
function P(e) {
	return e >= 1 ? 1 : e <= 0 ? -1 : 0;
}
function F(e) {
	return e == null ? null : typeof e == "string" ? typeof document < "u" && document.querySelector ? document.querySelector(e) : null : e;
}
//#endregion
//#region src/view-trigger.js
function I(e, t = {}) {
	let { enter: n, leave: r, once: i = !1, threshold: a = 0, rootMargin: o = "0px" } = t, s = globalThis.IntersectionObserver;
	if (typeof s != "function") throw Error("viewTrigger: IntersectionObserver is not available in this environment.");
	let c = l(e), u = /* @__PURE__ */ new Set(), d = /* @__PURE__ */ new Set(), f = c.length, p = !1, m = new s((e) => {
		for (let t of e) {
			if (p) return;
			let e = t.target;
			if (!d.has(e)) if (t.isIntersecting === void 0 ? t.intersectionRatio > 0 : t.isIntersecting) {
				if (u.has(e)) continue;
				u.add(e), typeof n == "function" && n(e), i && (d.add(e), m.unobserve(e), --f, f <= 0 && h());
			} else u.has(e) && (u.delete(e), typeof r == "function" && r(e));
		}
	}, {
		threshold: a,
		rootMargin: o
	});
	for (let e of c) m.observe(e);
	function h() {
		p || (p = !0, m.disconnect());
	}
	return { destroy: h };
}
//#endregion
//#region src/timeline-engine.js
function L(e) {
	return new x(e);
}
function R(e) {
	return x.fromJSON(e);
}
function z(e, t) {
	return new N(e, t);
}
//#endregion
export { N as ScrollDriver, x as Timeline, R as fromJSON, n as rand, r as registerPhysics, a as scene, z as scrollDriver, o as ticker, L as timeline, I as viewTrigger };
