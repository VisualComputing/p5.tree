/**
 * @file Interactive manipulator handle — p5 bridge controller.
 * @module p5.tree/handle
 * @license AGPL-3.0-only
 *
 * Wraps a renderer-agnostic tree Constraint (`@nakednous/tree/handle`) with the
 * p5-specific transport a draggable 3D control needs: pointer events, a
 * pixel→ray unprojection, and a host-driven
 * `update()` lifecycle. Constructed like a track (`createHandle` → stateful
 * controller); consumed like a gizmo.
 *
 * ── Layering ────────────────────────────────────────────────────────────────
 * The numeric core (`Constraint`) solves a ray→value mapping in ONE working
 * space and never learns world vs eye. This bridge converts the world pointer
 * ray into the working frame before `solve()`, and converts the value back out
 * through `mapDirection` / `mapLocation`. Nothing here re-implements geometry,
 * visibility, or matrix math — it only feeds numbers across the boundary.
 *
 * ── update() ordering contract ───────────────────────────────────────────────
 * `update()` is host-driven (NOT a predraw hook) because the orbit gate depends
 * on the grab resolving before `orbitControl()`:
 *
 *   function draw() {
 *     background(10)
 *     if (!h.update()) orbitControl()   // update() returns grabbed; grab wins
 *     // ... scene ...
 *     const v = h.value()               // pull the current value (fresh p5.Vector)
 *   }
 *
 * ── Pick ray ─────────────────────────────────────────────────────────────────
 * The pick ray is built in WORLD via two `mapLocation` unprojections at the
 * near (screen depth 0) and far (screen depth 1) planes — the normalized depth
 * carries the NDC-z convention through the core, so nothing is hardcoded.
 * `solve()` runs in WORLD; `value()` converts the result to the requested space.
 *
 * ── Pull-only value() ────────────────────────────────────────────────────────
 * `value()` mirrors `mapLocation`: `opts.out` is opt-in (zero-alloc when
 * supplied, fresh `p5.Vector` when omitted). The default `to` is WORLD, so
 * `h.value()` reads clean; pass `to: EYE` (etc.) to convert at read time.
 * `report` overrides POINT/DIRECTION per call.
 *
 * ── What's wired, and what's next ─────────────────────────────────────────────
 * Grab is real — a press color-ID picks a tagged proxy at the handle's screen
 * position via `mousePick`/`tag`; only a hit grabs, so a press that misses
 * falls through to `orbitControl()`. `onGrab` / `onRelease` fire around the
 * grab. Binding is wired too: `bind()` is polymorphic (a p5.Vector, a p5.Camera
 * lookat field, or an `{ get, set }` accessor floor) — `get()` seeds the
 * constraint so the handle starts at the target, each solve while held calls
 * `set(value)` and fires `onChange`, and `sync()` re-seeds after an external
 * change. Hooks fire user-first, then the lib-space `_on*` seam (mirroring
 * Track). Values cross in the handle's own frame (the `value()` default), and
 * unbound handles stay pull-only via `value()`.
 *
 * `draw()` renders in SCENE — HANDLE (the dot, constant screen size), AIM
 * (anchor→point line), LOCUS (SPHERE wire / PLANE quad / AXIS segment), RING
 * (SPHERE limb / PLANE border) — bit-selected, default HANDLE | AIM | LOCUS,
 * `marker: null` to suppress, composing gizmo primitives at the ambient p5
 * stroke (lines) and fill (the dot).
 *
 * VIEW is a bridge constraint: a core PLANE whose normal is re-aimed at the
 * camera each solve (a screen-parallel drag plane through the current point),
 * reported as a world position. The core never learns about the camera; the
 * `_view` flag carries the bridge behaviour (plane re-aim, direct-set seed,
 * screen-aligned square locus).
 *
 * Multitouch: the whole gesture keys to one pointerId (see update()), and the
 * pick + solve read that pointer's own coords — so on a shared surface each
 * handle tracks its own finger and ignores the rest. Independent, NON-
 * overlapping handles work today (one finger each). Arbitrating OVERLAPPING
 * handles (a clustered TRS gizmo) needs a single shared pick across all
 * proxies; that, plus snap, hover, and rotation, is the deferred work
 * (handle-design.md §8/§9, commit 7).
 */

'use strict';

import {
  createConstraint,
  SPHERE, PLANE, AXIS,
  POINT, DIRECTION,
  WORLD, SCREEN,
} from '@nakednous/tree';

// ═══════════════════════════════════════════════════════════════════════════
// Module-level scratch — synchronous, single-threaded, never returned
// ═══════════════════════════════════════════════════════════════════════════
//
// update()/value() run to completion within one draw() call with no reentrancy
// across handles, so a handle's solve never interleaves with another's. Shared
// scratch is therefore safe — same discipline as gizmos.js (_sl/_wl).

const _sIn  = new Float32Array(3);   // screen-space pick input (mx, my, depth)
const _near = new Float32Array(3);   // unprojected near point (ray origin)
const _far  = new Float32Array(3);   // unprojected far point
const _v3   = new Float32Array(3);   // value() extraction scratch
const _proxy = new Float32Array(3);  // pick-proxy world position (grab test)

// Single pick id for the one sub-handle in this pass. Future multi-proxy kinds
// (3 axis caps + 3 plane caps) assign one id each; the returned id selects which.
const PROXY_ID = 1;

// ── Draw scratch + small vec3 helpers (bridge draw only) ────────────────────
const _pW = new Float32Array(3);   // handle point, WORLD
const _aW = new Float32Array(3);   // anchor, WORLD
const _b0 = new Float32Array(3);   // basis u (ring / plane quad)
const _b1 = new Float32Array(3);   // basis v
const _b2 = new Float32Array(3);   // basis w (view normal, sphere limb)

// PLANE has no intrinsic size, so its locus quad uses a fixed world half-extent.
const _PLANE_HALF = 100;

const _norm3 = (o) => {
  const l = Math.hypot(o[0], o[1], o[2]) || 1;
  o[0] /= l; o[1] /= l; o[2] /= l;
  return o;
};

// Orthonormal in-plane basis (u → ub, v → vb) for a unit normal n. Seeds from
// the world axis least aligned with n so the first cross can't degenerate.
const _basisFromNormal = (n, ub, vb) => {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  let rx = 0, ry = 0, rz = 0;
  if (ax <= ay && ax <= az) rx = 1; else if (ay <= az) ry = 1; else rz = 1;
  ub[0] = ry*n[2] - rz*n[1]; ub[1] = rz*n[0] - rx*n[2]; ub[2] = rx*n[1] - ry*n[0];
  _norm3(ub);
  vb[0] = n[1]*ub[2] - n[2]*ub[1]; vb[1] = n[2]*ub[0] - n[0]*ub[2]; vb[2] = n[0]*ub[1] - n[1]*ub[0];
};

// ═══════════════════════════════════════════════════════════════════════════
// Handle registry — per p5 instance, disposed on the remove lifecycle
// ═══════════════════════════════════════════════════════════════════════════
//
// Mirrors track.js's player registry: handles attach DOM listeners at
// construction, so the sketch teardown must release them. See index.js remove.

const HANDLES = new WeakMap();

function _handleSet(pInst) {
  let s = HANDLES.get(pInst);
  if (!s) { s = new Set(); HANDLES.set(pInst, s); }
  return s;
}

function _register(pInst, h)   { if (pInst && h) _handleSet(pInst).add(h); }
function _unregister(pInst, h) { if (pInst && h) HANDLES.get(pInst)?.delete(h); }

/**
 * Dispose every handle registered with a p5 instance. Called from
 * `lifecycles.remove`.
 * @param {p5} pInst
 */
export function disposeHandles(pInst) {
  const s = HANDLES.get(pInst);
  if (!s) return;
  for (const h of [...s]) h.dispose();
  s.clear();
}

// ═══════════════════════════════════════════════════════════════════════════
// Install
// ═══════════════════════════════════════════════════════════════════════════

export function installHandle(p5, fn) {

  // The canvas DOM element backing the sketch (panel.js uses the same idiom).
  const _canvasOf = (p) => {
    const r = p._renderer;
    return (r && (r.canvas || (r.drawingContext && r.drawingContext.canvas))) || null;
  };

  // Read [x|0, y|1, z|2] off a p5.Vector / array / typed array, falling back
  // to the supplied defaults (used by anchor()).
  const _vx = (v, i, d) => {
    if (v == null) return d;
    const c = i === 0 ? v.x : i === 1 ? v.y : v.z;
    return c ?? v[i] ?? d;
  };

  // Camera-field bind helpers — read / write a p5.Camera's eye | center | up via
  // its lookat scalars, re-applying the lookat on write (a bare eyeX write does
  // not rebuild the view matrix). up falls back to +Y, matching capturePose.
  const _camFieldGet = (cam, field) => {
    if (field === 'center') return [cam.centerX, cam.centerY, cam.centerZ];
    if (field === 'up')     return [cam.upX ?? 0, cam.upY ?? 1, cam.upZ ?? 0];
    return [cam.eyeX, cam.eyeY, cam.eyeZ];
  };
  const _camFieldSet = (cam, field, x, y, z) => {
    const ex = cam.eyeX,    ey = cam.eyeY,    ez = cam.eyeZ;
    const cx = cam.centerX, cy = cam.centerY, cz = cam.centerZ;
    const ux = cam.upX ?? 0, uy = cam.upY ?? 1, uz = cam.upZ ?? 0;
    if (field === 'center')  cam.camera(ex, ey, ez, x,  y,  z,  ux, uy, uz);
    else if (field === 'up') cam.camera(ex, ey, ez, cx, cy, cz, x,  y,  z );
    else                     cam.camera(x,  y,  z,  cx, cy, cz, ux, uy, uz);
  };

  /**
   * Interactive manipulator handle controller.
   *
   * Holds a tree `Constraint` plus the p5 transport around it. Stateful and
   * long-lived (like a `CameraTrack`); not a draw call. Drive it from `draw()`
   * via `update()`, then read with `value()`.
   */
  class Handle {
    /**
     * @param {p5}     p     The p5 instance the handle is bound to.
     * @param {Object} opts  Validated by `createHandle` (kind already checked).
     */
    constructor(p, opts) {
      this._p = p;

      const kind = opts.constraint;

      // VIEW is a bridge constraint: a core PLANE whose normal is re-aimed at
      // the camera each solve (a screen-parallel drag plane). The core stays
      // camera-oblivious; _view marks the bridge behaviour.
      this._view = (kind === p5.Tree.VIEW);
      const coreKind = this._view ? PLANE : kind;

      // Core constraint owns the canonical state + value mapping. Vector opts
      // (anchor / normal / axis) pass straight through — the core duck-types
      // p5.Vector / array / typed array.
      this._constraint = createConstraint(coreKind, {
        radius: opts.radius,
        report: opts.report,
        anchor: opts.anchor,
        normal: opts.normal,
        axis:   opts.axis,
        extent: opts.extent,
      });

      // Runtime gate — false suspends grab/solve without disposing listeners.
      this._enabled = opts.enabled !== false;

      // Pick-proxy radius in screen pixels — the grab hit-test size, drawn at
      // constant screen size regardless of depth (see _pick).
      this._grabPx = Number.isFinite(opts.grabPx) ? opts.grabPx : 12;

      // Transport state. The pointer listeners record the active pointer + its
      // latest coords and set the *_pending flags; update() consumes them, so
      // all grab/solve happens inside draw().
      //
      // _pid keys the gesture to ONE pointer — a candidate while a press is
      // hit-tested, the captured pointer while grabbed, null when idle. Every
      // listener filters on it, so on a multitouch surface a handle tracks its
      // own finger and ignores the others (and the mouse). _ptr is that
      // pointer's position in logical canvas px, fed to the pick and the solve
      // in place of the global mouseX/mouseY (one global can't say which finger
      // moved).
      this._grabbed      = false;
      this._downPending  = false;
      this._movedPending = false;
      this._upPending    = false;
      this._pid          = null;
      this._ptr          = new Float32Array(2);

      // Interaction hooks (user-facing) + lib-space seams (_on*, for the
      // bridge / UI). Fired user-first, mirroring Track's onPlay/onEnd/onStop.
      this.onGrab     = typeof opts.onGrab    === 'function' ? opts.onGrab    : null;
      this.onRelease  = typeof opts.onRelease === 'function' ? opts.onRelease : null;
      this.onChange   = typeof opts.onChange  === 'function' ? opts.onChange  : null;
      this._onGrab    = null;
      this._onRelease = null;
      this._onChange  = null;

      // Binding — a normalised { get, set } accessor (null when pull-only).
      // _bindVal is the reused value vector handed to set() / onChange, lazily
      // allocated on first solve so pull-only handles allocate nothing.
      this._binder  = null;
      this._bindVal = null;

      this._attachPointer();

      // Opt-in bind (single-arg shapes only; camera binding needs the field,
      // so use the chained h.bind(cam, 'eye') form).
      if (opts.bind != null) this.bind(opts.bind);
    }

    // ── Pointer wiring ──────────────────────────────────────────────────────

    _attachPointer() {
      const canvas = _canvasOf(this._p);
      this._canvas = canvas;
      if (!canvas) {
        console.error('[p5.tree] handle: no canvas found — pointer input disabled. Create the handle after createCanvas().');
        return;
      }
      // Listeners record the pointer + its coords and set flags only (cheap,
      // ordering-independent); update() does the work. Each filters on _pid so a
      // handle only ever tracks one finger — the one whose press it adopted —
      // and ignores every other pointer on the surface.
      //
      // A press is a grab candidate only while the handle is idle (_pid null);
      // once it adopts a pointer it ignores further downs until that pointer
      // misses (update frees it) or releases. Pointer capture keeps move / up /
      // cancel flowing to the canvas while the finger drags off the dot or
      // off-canvas; the capture is on the (shared) canvas, so co-existing
      // handles each capture their own pointerId without conflict.
      this._onDown = (e) => {
        if (this._pid !== null) return;          // already tracking a finger
        this._pid = e.pointerId;
        this._eventXY(e, this._ptr);
        this._downPending = true;
        if (canvas.setPointerCapture) {
          try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* best effort */ }
        }
      };
      this._onMove = (e) => {
        if (e.pointerId !== this._pid) return;   // not our finger
        this._eventXY(e, this._ptr);
        this._movedPending = true;
      };
      this._onUp = (e) => {                       // also bound to pointercancel
        if (e.pointerId !== this._pid) return;   // not our finger
        this._eventXY(e, this._ptr);
        this._upPending = true;
      };
      canvas.addEventListener('pointerdown',   this._onDown);
      canvas.addEventListener('pointermove',   this._onMove);
      canvas.addEventListener('pointerup',     this._onUp);
      canvas.addEventListener('pointercancel', this._onUp);
    }

    // Pointer event → logical canvas coords (the [0,width]×[0,height] space
    // colorPick and mapLocation(SCREEN) expect — see picking.js's pick viewport
    // [0, height, width, −height]). Goes through the element rect so a
    // CSS-scaled canvas maps correctly, sidestepping the mouseX/mouseY scaling
    // skew (processing/p5.js#8669). Falls back to mouseX/mouseY without a rect.
    _eventXY(e, out) {
      const c = this._canvas;
      const r = (c && c.getBoundingClientRect) ? c.getBoundingClientRect() : null;
      if (r && r.width > 0 && r.height > 0) {
        out[0] = (e.clientX - r.left) * (this._p.width  / r.width);
        out[1] = (e.clientY - r.top)  * (this._p.height / r.height);
      } else {
        out[0] = this._p.mouseX; out[1] = this._p.mouseY;
      }
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    /**
     * Resolve the grab and re-solve from the pointer. Call FIRST in `draw()`.
     *
     * Returns the post-update grabbed state so the orbit gate can short-circuit
     * (`if (!h.update()) orbitControl()`). A disabled handle is an immediate
     * no-op returning `false`.
     *
     * A fresh press color-ID picks the tagged proxy (`_pick`); only a hit
     * grabs, so a miss leaves `grabbed` false and the press falls through to
     * `orbitControl()`. `onGrab` fires on a successful grab, `onRelease` on the
     * matching release.
     *
     * @returns {boolean} grabbed
     */
    update() {
      if (!this._enabled) {
        this._grabbed = this._downPending = this._movedPending = this._upPending = false;
        this._pid = null;
        return false;
      }
      // Fresh press → color-ID hit-test at OUR pointer's pixel; grab only on a
      // hit. A miss frees _pid, so the next press — or, on a multitouch surface,
      // another finger — can be adopted.
      if (this._downPending) {
        this._downPending = false;
        if (this._pick()) {
          this._grabbed = true;
          this.onGrab  && this.onGrab(this);
          this._onGrab && this._onGrab(this);
        } else {
          this._pid = null;
        }
      }

      // Drag → re-solve from our pointer's ray, then push to the binding and
      // fire onChange.
      if (this._grabbed && this._movedPending) {
        this._movedPending = false;
        this._solveFromPointer(this._ptr[0], this._ptr[1]);
        this._afterSolve();
      }

      // Release (pointerup / pointercancel) — fire onRelease only if a grab was
      // in progress, then go idle so the handle is free for the next press.
      if (this._upPending) {
        this._upPending = this._movedPending = false;
        if (this._grabbed) {
          this._grabbed = false;
          this.onRelease  && this.onRelease(this);
          this._onRelease && this._onRelease(this);
        }
        this._pid = null;
      }

      return this._grabbed;
    }

    // ── Grab (color-ID pick) ────────────────────────────────────────────────

    /**
     * Color-ID hit-test the handle under the pointer. Renders one tagged proxy
     * sphere at the handle's current world position — sized to a constant
     * `grabPx` screen radius — into colorPick's 1×1 pick buffer at the tracked
     * pointer's pixel, and returns whether the decoded id is this handle's proxy.
     *
     * The proxy point is `value({ to: WORLD, report: POINT })`: the core folds
     * the anchor in (SPHERE → anchor + dir·radius, PLANE/AXIS → the constrained
     * point), so this is exactly where the dot will draw.
     *
     * pixelRatio is read BEFORE colorPick: the pick pass installs a narrowed
     * 1×1 projection, so world-units-per-pixel must be sampled against the live
     * (main) projection first.
     *
     * @returns {boolean} true if the proxy was hit.
     */
    _pick() {
      const p = this._p;
      // Handle position in WORLD (see doc).
      this.value({ to: WORLD, report: POINT, out: _proxy });
      // Constant screen size: worldRadius = grabPx · (world-units per pixel).
      const rad = this._grabPx * p.pixelRatio(_proxy);
      // Pick at OUR pointer's pixel (not mouseX/mouseY) so the right finger
      // tests against this handle's proxy on a multitouch surface.
      const id = p.colorPick(this._ptr[0], this._ptr[1], () => {
        p.push();
        p.translate(_proxy[0], _proxy[1], _proxy[2]);
        p.fill(p.tag(PROXY_ID));
        p.sphere(rad);
        p.pop();
      });
      return id === PROXY_ID;
    }

    // ── Pixel → ray → working frame → solve ─────────────────────────────────

    _solveFromPointer(mx, my) {
      const p = this._p;

      // WORLD pick ray. Two unprojections at the near (depth 0) and far
      // (depth 1) planes — the normalized screen depth carries the NDC-z
      // convention through mapLocation, so no near-z constant is hardcoded.
      _sIn[0] = mx; _sIn[1] = my; _sIn[2] = 0;
      p.mapLocation(_sIn, { from: SCREEN, to: WORLD, out: _near });
      _sIn[2] = 1;
      p.mapLocation(_sIn, { from: SCREEN, to: WORLD, out: _far });

      let ox = _near[0], oy = _near[1], oz = _near[2];
      let dx = _far[0] - ox, dy = _far[1] - oy, dz = _far[2] - oz;

      // VIEW: re-aim the PLANE at the camera (through the current point) so the
      // drag tracks a screen-parallel plane at the point's depth.
      if (this._view) this._viewUpdatePlane();

      // solve() assumes a unit direction.
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      this._constraint.solve(ox, oy, oz, dx / len, dy / len, dz / len);
    }

    // VIEW: re-aim the core PLANE at the camera through the current point. The
    // plane normal becomes the look direction (screen-parallel), and its anchor
    // rides the point so the drag stays at the point's view-depth. The core
    // PLANE solves it; only the bridge knows a camera was ever involved.
    _viewUpdatePlane() {
      const cam = this._p.getCamera();
      if (!cam) return;
      const c = this._constraint;
      c.n[0] = cam.centerX - cam.eyeX;
      c.n[1] = cam.centerY - cam.eyeY;
      c.n[2] = cam.centerZ - cam.eyeZ;
      _norm3(c.n);
      c.anchor[0] = c.pt[0]; c.anchor[1] = c.pt[1]; c.anchor[2] = c.pt[2];
    }

    // ── Value (pull-only) ───────────────────────────────────────────────────

    /**
     * Read the current value into a `p5.Vector` (fresh when `out` is omitted,
     * zero-alloc when supplied).
     *
     * DIRECTION routes through `mapDirection`, POINT through `mapLocation`, so
     * `to` accepts the same spaces those do — `p5.Tree.WORLD` / `EYE` /
     * `SCREEN` / `NDC` / `MODEL` (string constants), or a raw mat4 frame.
     * `MODEL` uses the live model matrix; passing a model matrix directly as
     * `to` reports in that local frame (the idiom cross() / bullsEye() use —
     * mapLocation takes the model frame as `to`, not as a keyword, so there's
     * no separate `mat4Model`). The optional
     * `mat4Eye / mat4Proj / mat4View / mat4PV` resolve the value against a
     * supplied camera instead of live state (parity with mapLocation). The
     * default `to` is WORLD, so nothing converts unless asked.
     *
     * @param {{ to?: string | Float32Array | number[] | p5.Matrix,
     *           report?: number,
     *           out?: Float32Array | number[] | p5.Vector,
     *           mat4Eye?: *, mat4Proj?: *, mat4View?: *, mat4PV?: * }} [opts]
     * @returns {Float32Array | number[] | p5.Vector}
     */
    value(opts = {}) {
      const c = this._constraint;
      const report = (opts.report === POINT || opts.report === DIRECTION) ? opts.report : c.report;
      const from = WORLD;
      const to   = opts.to ?? from;

      c.value(_v3, report);

      if (to === from) {
        return this._emit(opts.out, _v3[0], _v3[1], _v3[2]);
      }
      const mapOpts = {
        from, to, out: opts.out,
        mat4Eye:  opts.mat4Eye,
        mat4Proj: opts.mat4Proj,
        mat4View: opts.mat4View,
        mat4PV:   opts.mat4PV,
      };
      return (report === DIRECTION)
        ? this._p.mapDirection(_v3, mapOpts)
        : this._p.mapLocation(_v3, mapOpts);
    }

    /** Write (x,y,z) into `out`, allocating a fresh p5.Vector when absent. */
    _emit(out, x, y, z) {
      if (out == null) return new p5.Vector(x, y, z);
      if (out instanceof p5.Vector) { out.set(x, y, z); return out; }
      out[0] = x; out[1] = y; out[2] = z;
      return out;
    }

    // ── Binding (push value to a target; pull stays available via value) ─────

    /**
     * Bind the handle to a target it drives while dragging. Polymorphic, with
     * an accessor floor; dispatch is by shape, with no positional ambiguity:
     *
     *   bind(vec)                       p5.Vector — mutated in place (zero-alloc)
     *   bind(cam, 'eye'|'center'|'up')  p5.Camera lookat field — re-applies the camera
     *   bind({ get, set })              accessor floor — get() → value, set(value) writes
     *
     * `get()` seeds the constraint immediately, so the handle starts at the
     * target's current value. While grabbed, each solve calls `set(value)` and
     * fires `onChange`. Values cross in WORLD (the `value()` default). An
     * unrecognised target logs and leaves the handle pull-only (§5). Chainable.
     *
     * @param {p5.Vector | p5.Camera | { get: Function, set: Function }} target
     * @param {string} [field]  Camera lookat field: 'eye' | 'center' | 'up'.
     * @returns {Handle} this
     */
    bind(target, field) {
      let binder = null;
      if (target instanceof p5.Vector) {
        binder = {
          get: () => target,
          set: (v) => target.set(v.x, v.y, v.z),
        };
      } else if (target instanceof p5.Camera) {
        if (field !== 'eye' && field !== 'center' && field !== 'up') {
          console.error("[p5.tree] handle.bind: a p5.Camera needs a field — 'eye', 'center', or 'up'. Leaving unbound.");
          return this;
        }
        binder = {
          get: () => _camFieldGet(target, field),
          set: (v) => _camFieldSet(target, field, v.x, v.y, v.z),
        };
      } else if (target && typeof target.get === 'function' && typeof target.set === 'function') {
        binder = target;   // keep the object so get()/set() retain their `this`
      } else {
        console.error('[p5.tree] handle.bind: unrecognised target — pass a p5.Vector, a p5.Camera + field, or an { get, set } accessor. Leaving unbound.');
        return this;
      }
      this._binder = binder;
      this._seedFromBinding();
      return this;
    }

    /**
     * Re-seed the constraint from the bound target after it changed externally
     * (the camera moved, a keyframe was edited, …). No-op when unbound.
     * Chainable.
     * @returns {Handle} this
     */
    sync() {
      if (this._binder) this._seedFromBinding();
      return this;
    }

    // Seed the constraint from the bound target's current value, read in WORLD
    // (the working frame), so it feeds seed() directly. Accepts p5.Vector /
    // array / {x,y,z}.
    _seedFromBinding() {
      const g = this._binder.get();
      if (g == null) return;
      const x = g.x ?? g[0] ?? 0;
      const y = g.y ?? g[1] ?? 0;
      const z = g.z ?? g[2] ?? 0;
      if (this._view) {
        // VIEW: the point IS the value — set it directly. The plane is
        // ephemeral (re-derived each solve), so there's nothing to project onto.
        const pt = this._constraint.pt;
        pt[0] = x; pt[1] = y; pt[2] = z;
      } else {
        this._constraint.seed(x, y, z);
      }
    }

    // Push the freshly solved value to the binding and fire onChange — once per
    // solve while grabbed. Reuses _bindVal (lazily allocated) so a bound or
    // observed drag allocates nothing per frame. set() before onChange, per §4.4.
    _afterSolve() {
      const bound  = this._binder !== null;
      const notify = !!(this.onChange || this._onChange);
      if (!bound && !notify) return;
      this._bindVal ||= new p5.Vector(0, 0, 0);
      const v = this.value({ out: this._bindVal });
      if (bound) this._binder.set(v);
      if (notify) {
        this.onChange  && this.onChange(v, this);
        this._onChange && this._onChange(v, this);
      }
    }

    // ── Draw (SCENE) ──────────────────────────────────────────────────

    /**
     * Render the handle's visuals in the scene. Composes existing gizmo
     * primitives (lines, a pane quad, sampled rings, the dot) at the
     * dark-bg / bright-stroke aesthetic — nothing here re-implements geometry.
     * The dot draws at a constant screen size via pixelRatio. Options last;
     * bit-flags select parts (parity with trackPath).
     *
     * Bits (default HANDLE | AIM | LOCUS):
     *   HANDLE — the draggable dot at the handle's point.
     *   AIM    — a line from the anchor to the handle's point.
     *   LOCUS  — the constraint surface: SPHERE wire | PLANE quad | AXIS segment.
     *   RING   — SPHERE view-facing limb | PLANE border.
     *
     * Draws at the ambient p5 state, like every gizmo: stroke() colours the
     * stroked parts (AIM / LOCUS / RING), fill() the dot (HANDLE) — set both
     * for a one-colour handle. `size` is the dot radius in pixels (defaults to
     * grabPx, so the dot fills the hit area). `marker: null` suppresses the
     * whole draw (parity with trackPath). Chainable.
     *
     * @param {{ bits?: number, size?: number, marker?: null }} [opts]
     * @returns {Handle} this
     */
    draw(opts = {}) {
      if ('marker' in opts && opts.marker === null) return this;
      this._drawScene(opts);
      return this;
    }

    // Scene draw — the visual counterpart of the pixel→ray input path. Reads the
    // handle point + anchor in WORLD, then emits the bit-selected parts.
    _drawScene(opts) {
      const p = this._p;
      const c = this._constraint;
      const bits = Number.isFinite(opts.bits)
        ? opts.bits
        : (p5.Tree.HANDLE | p5.Tree.AIM | p5.Tree.LOCUS);
      const sizePx = Number.isFinite(opts.size) ? opts.size : this._grabPx;

      // Handle point (WORLD) and anchor (WORLD).
      this.value({ to: WORLD, report: POINT, out: _pW });
      const a = c.anchor;
      _aW[0] = a[0]; _aW[1] = a[1]; _aW[2] = a[2];

      // Ambient p5 state, like every gizmo: the stroked parts (AIM / LOCUS /
      // RING) follow stroke(); the dot (HANDLE) follows fill().
      p.push();

      // LOCUS — the surface of allowed positions.
      if ((bits & p5.Tree.LOCUS) !== 0) {
        p.push();
        p.noFill();
        if (this._view) {
          this._viewSquare(_pW);
        } else if (c.kind === SPHERE) {
          p.push();
          p.translate(_aW[0], _aW[1], _aW[2]);
          p.sphere(c.radius);
          p.pop();
        } else if (c.kind === PLANE) {
          this._planeQuad(_aW, c.n, _PLANE_HALF);
        } else if (c.kind === AXIS) {
          const u = c.u;
          p.line(_aW[0] + c.min*u[0], _aW[1] + c.min*u[1], _aW[2] + c.min*u[2],
                 _aW[0] + c.max*u[0], _aW[1] + c.max*u[1], _aW[2] + c.max*u[2]);
        }
        p.pop();
      }

      // RING — SPHERE limb (circle ⊥ the view direction) | PLANE border.
      // (VIEW's screen-aligned square is the LOCUS; it has no separate ring.)
      if ((bits & p5.Tree.RING) !== 0) {
        p.push();
        p.noFill();
        if (c.kind === SPHERE) {
          const cam = p.getCamera();
          if (cam) {
            _b2[0] = _aW[0] - cam.eyeX;
            _b2[1] = _aW[1] - cam.eyeY;
            _b2[2] = _aW[2] - cam.eyeZ;
            _norm3(_b2);
            _basisFromNormal(_b2, _b0, _b1);
            this._ring(_aW[0], _aW[1], _aW[2], c.radius, _b0, _b1);
          }
        } else if (c.kind === PLANE && !this._view) {
          this._planeQuad(_aW, c.n, _PLANE_HALF);
        }
        p.pop();
      }

      // AIM — anchor → handle point.
      if ((bits & p5.Tree.AIM) !== 0) {
        p.line(_aW[0], _aW[1], _aW[2], _pW[0], _pW[1], _pW[2]);
      }

      // HANDLE — the dot, constant screen size (worldRadius = size · world/px).
      if ((bits & p5.Tree.HANDLE) !== 0) {
        const rad = sizePx * p.pixelRatio(_pW);
        p.push();
        p.noStroke();
        p.translate(_pW[0], _pW[1], _pW[2]);
        p.sphere(rad);
        p.pop();
      }

      p.pop();
    }

    // A flat square at `cen` spanned by orthonormal in-plane vectors u, v,
    // half-extent `half`, via the pane() primitive. Outline when fill is off
    // (LOCUS / RING), filled if the caller has fill() on.
    _squareAt(cen, u, v, half) {
      const p = this._p;
      const ux = u[0]*half, uy = u[1]*half, uz = u[2]*half;
      const vx = v[0]*half, vy = v[1]*half, vz = v[2]*half;
      p.pane(
        [cen[0]-ux-vx, cen[1]-uy-vy, cen[2]-uz-vz],
        [cen[0]+ux-vx, cen[1]+uy-vy, cen[2]+uz-vz],
        [cen[0]+ux+vx, cen[1]+uy+vy, cen[2]+uz+vz],
        [cen[0]-ux+vx, cen[1]-uy+vy, cen[2]-uz+vz],
      );
    }

    // PLANE locus: derive an in-plane basis from the normal, then a square.
    _planeQuad(cen, n, half) {
      _basisFromNormal(n, _b0, _b1);
      this._squareAt(cen, _b0, _b1, half);
    }

    // VIEW locus: a screen-aligned square at the point, in the camera-facing
    // plane (right / up taken from the camera; normal = look direction).
    _viewSquare(center) {
      const cam = this._p.getCamera();
      if (!cam) return;
      _b2[0] = cam.centerX - cam.eyeX; _b2[1] = cam.centerY - cam.eyeY; _b2[2] = cam.centerZ - cam.eyeZ;
      _norm3(_b2);                                            // forward (look)
      const ux = cam.upX ?? 0, uy = cam.upY ?? 1, uz = cam.upZ ?? 0;
      _b0[0] = _b2[1]*uz - _b2[2]*uy; _b0[1] = _b2[2]*ux - _b2[0]*uz; _b0[2] = _b2[0]*uy - _b2[1]*ux;
      _norm3(_b0);                                            // right = forward × up
      _b1[0] = _b0[1]*_b2[2] - _b0[2]*_b2[1]; _b1[1] = _b0[2]*_b2[0] - _b0[0]*_b2[2]; _b1[2] = _b0[0]*_b2[1] - _b0[1]*_b2[0];
      this._squareAt(center, _b0, _b1, _PLANE_HALF);          // up = right × forward
    }

    // A sampled circle of radius r at (cx,cy,cz) spanned by orthonormal u, v.
    _ring(cx, cy, cz, r, u, v) {
      const p = this._p;
      const N = 48;
      let px, py, pz;
      for (let i = 0; i <= N; i++) {
        const t = (i / N) * (Math.PI * 2);
        const ct = Math.cos(t) * r, st = Math.sin(t) * r;
        const x = cx + ct*u[0] + st*v[0];
        const y = cy + ct*u[1] + st*v[1];
        const z = cz + ct*u[2] + st*v[2];
        if (i > 0) p.line(px, py, pz, x, y, z);
        px = x; py = y; pz = z;
      }
    }

    /**
     * Current scalar parameter (AXIS only; NaN otherwise).
     * @returns {number}
     */
    scalar() { return this._constraint.scalar(); }

    /**
     * Derive `[az, el]` from the current direction (SPHERE readout). Writes
     * into `out2` when supplied.
     * @param {number[]} [out2]
     * @returns {number[]} [az, el]
     */
    azEl(out2) { return this._constraint.azEl(out2 || [0, 0]); }

    /**
     * True between grab and release.
     * @returns {boolean}
     */
    grabbed() { return this._grabbed; }

    /**
     * Move the constraint's reference point — sphere centre / plane point /
     * axis anchor, or the dragged point for a VIEW handle. In place; chainable.
     * @param {p5.Vector|number[]} v
     * @returns {Handle} this
     */
    anchor(v) {
      const t = this._view ? this._constraint.pt : this._constraint.anchor;
      t[0] = _vx(v, 0, t[0]);
      t[1] = _vx(v, 1, t[1]);
      t[2] = _vx(v, 2, t[2]);
      return this;
    }

    // ── Runtime gates ───────────────────────────────────────────────────────

    /** Runtime gate — `false` suspends grab/solve without disposing. */
    get enabled() { return this._enabled; }
    set enabled(v) {
      this._enabled = !!v;
      if (!this._enabled) { this._grabbed = false; this._pid = null; }
    }

    // ── Teardown ────────────────────────────────────────────────────────────

    /** Remove pointer listeners and unregister. */
    dispose() {
      const c = this._canvas;
      if (c) {
        c.removeEventListener('pointerdown',   this._onDown);
        c.removeEventListener('pointermove',   this._onMove);
        c.removeEventListener('pointerup',     this._onUp);
        c.removeEventListener('pointercancel', this._onUp);
      }
      this._canvas = null;
      _unregister(this._p, this);
    }
  }

  // ── Factory ─────────────────────────────────────────────────────────────

  /**
   * Create an interactive manipulator handle bound to the sketch canvas.
   *
   * Returns a stateful controller (like `createCameraTrack`), not a draw call.
   * Drive it from `draw()`:
   *
   * ```js
   * let h
   * function setup() {
   *   createCanvas(720, 480, WEBGL)
   *   h = createHandle({ constraint: SPHERE, report: DIRECTION })
   * }
   * function draw() {
   *   background(10)
   *   if (!h.update()) orbitControl()
   *   const dir = h.value({ to: EYE })   // fresh p5.Vector, eye space
   *   console.log(dir.x, dir.y, dir.z)
   * }
   * ```
   *
   * @method createHandle
   * @for p5
   * @param {{
   *   constraint: number,
   *   report?:    number,
   *   anchor?:    p5.Vector | number[],
   *   radius?:    number,
   *   axis?:      p5.Vector | number[],
   *   normal?:    p5.Vector | number[],
   *   extent?:    number[],
   *   grabPx?:    number,
   *   enabled?:   boolean,
   *   bind?:      p5.Vector | { get: Function, set: Function },
   *   onGrab?:    Function,
   *   onChange?:  Function,
   *   onRelease?: Function,
   * }} opts
   * @returns {Handle|null} The controller, or null on an invalid constraint.
   */
  fn.createHandle = function (opts = {}) {
    const kind = opts.constraint;
    if (kind !== SPHERE && kind !== PLANE && kind !== AXIS && kind !== p5.Tree.VIEW) {
      console.error('[p5.tree] createHandle: `constraint` must be SPHERE, PLANE, AXIS, or VIEW; got ' + String(kind) + '.');
      return null;
    }
    const h = new Handle(this, opts);
    _register(this, h);
    return h;
  };
}
