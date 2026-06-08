/**
 * @file Interactive manipulator handle — p5 bridge controller.
 * @module p5.tree/handle
 * @license AGPL-3.0-only
 *
 * Wraps a renderer-agnostic tree Constraint (`@nakednous/tree/handle`) with the
 * p5-specific transport a draggable 3D control needs: pointer events, a
 * pixel→ray unprojection, WORLD/EYE frame conversion, and a host-driven
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
 * ── Frame conversion ─────────────────────────────────────────────────────────
 * The pick ray is built in WORLD via two `mapLocation` unprojections at the
 * near (screen depth 0) and far (screen depth 1) planes — the normalized depth
 * carries the NDC-z convention through the core, so nothing is hardcoded.
 * For an EYE-frame handle (the headlight) the ray origin is mapped WORLD→EYE
 * (`mapLocation`) and the ray direction WORLD→EYE (`mapDirection`) before
 * `solve()`; `value()` then maps the result back out to the requested space.
 *
 * ── Pull-only value() ────────────────────────────────────────────────────────
 * `value()` mirrors `mapLocation`: `opts.out` is opt-in (zero-alloc when
 * supplied, fresh `p5.Vector` when omitted). The default `to` is the handle's
 * own frame, so `h.value()` reads clean — WORLD for a PLANE/AXIS handle,
 * eye-space for an EYE SPHERE. `report` overrides POINT/DIRECTION per call.
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
 * `marker: null` to suppress, composing gizmo primitives at the ambient (or
 * `opts.color`) stroke.
 *
 * `display` chooses the surface and the input path (the SPHERE-only HUD falls
 * back to SCENE elsewhere): SCENE is the 3D pixel→ray path above; HUD is a 2D
 * dial (`beginHUD`/`endHUD`) whose polar position maps to a heading — pointer
 * → (az, el) → `dirFromAzEl` → `seed` — with no ray, camera, or GPU pick. Both
 * surfaces write the same state, so `value()` / `bind()` / hooks are identical;
 * `hud: { at, size }` places the dial in px.
 *
 * VIEW is a bridge constraint: a core PLANE whose normal is re-aimed at the
 * camera each solve (a screen-parallel drag plane through the current point),
 * reported as a world position. The core never learns about the camera; the
 * `_view` flag carries the bridge behaviour (plane re-aim, direct-set seed,
 * screen-aligned square locus).
 *
 * Remaining (handle-design.md §8): snap, hover, multi-target, rotation, plus
 * example sketches + the README registry entry.
 */

'use strict';

import {
  createConstraint, dirFromAzEl,
  SPHERE, PLANE, AXIS,
  POINT, DIRECTION,
  WORLD, EYE, SCREEN,
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
const _dir  = new Float32Array(3);   // ray-direction scratch (frame conversion)
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
const _azel = new Float32Array(2); // [az, el] readout (HUD draw)
const _hDir = new Float32Array(3); // heading direction from the dial (HUD input)

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

      // Frame — EYE is meaningful for SPHERE only (the headlight). Anything
      // else is silently a WORLD handle (§5 diagnostic).
      let frame = opts.frame ?? WORLD;
      if (frame === EYE && kind !== SPHERE) {
        console.error('[p5.tree] handle: EYE frame is only meaningful for SPHERE; falling back to WORLD.');
        frame = WORLD;
      }
      this._frame = (frame === EYE) ? EYE : WORLD;

      // Display surface — SCENE (3D) or HUD (a 2D dial). HUD maps a pointer to
      // a heading, so it's SPHERE-only; requested elsewhere it falls back to
      // SCENE (§5).
      let display = opts.display ?? p5.Tree.SCENE;
      if (display === p5.Tree.HUD && kind !== SPHERE) {
        console.error('[p5.tree] handle: HUD display is SPHERE-only; falling back to SCENE.');
        display = p5.Tree.SCENE;
      }
      this._display = (display === p5.Tree.HUD) ? p5.Tree.HUD : p5.Tree.SCENE;

      // HUD dial placement in px — centre `at` + radius `size`. Defaults to a
      // small dial near the top-left; override via opts.hud.
      const hud = opts.hud || {};
      this._hud = {
        at:   Array.isArray(hud.at) ? [hud.at[0], hud.at[1]] : [80, 80],
        size: Number.isFinite(hud.size) ? hud.size : 64,
      };

      // Runtime gate — false suspends grab/solve without disposing listeners.
      this._enabled = opts.enabled !== false;

      // Pick-proxy radius in screen pixels — the grab hit-test size, drawn at
      // constant screen size regardless of depth (see _pick).
      this._grabPx = Number.isFinite(opts.grabPx) ? opts.grabPx : 12;

      // Transport state. The pointer listeners only set the *_pending flags;
      // update() consumes them so all grab/solve happens inside draw().
      this._grabbed      = false;
      this._downPending  = false;
      this._movedPending = false;
      this._upPending    = false;

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
      // Listeners set flags only (cheap, ordering-independent). Pointer capture
      // keeps move/up flowing to the canvas while dragging off-canvas.
      this._onDown = (e) => {
        this._downPending = true;
        if (canvas.setPointerCapture) {
          try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* best effort */ }
        }
      };
      this._onMove = () => { this._movedPending = true; };
      this._onUp   = () => { this._upPending = true; };
      canvas.addEventListener('pointerdown', this._onDown);
      canvas.addEventListener('pointermove', this._onMove);
      canvas.addEventListener('pointerup',   this._onUp);
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
        return false;
      }
      const p = this._p;
      const hud = this._display === p5.Tree.HUD;

      // Fresh press → hit-test (GPU proxy in SCENE, dial bounds in HUD); grab
      // only on a hit. A HUD grab jumps to the press so a click sets the heading.
      if (this._downPending) {
        this._downPending = false;
        if (hud ? this._pickHud() : this._pick()) {
          this._grabbed = true;
          this.onGrab  && this.onGrab(this);
          this._onGrab && this._onGrab(this);
          if (hud) { this._solveFromDial(p.mouseX, p.mouseY); this._afterSolve(); }
        }
      }

      // Drag → re-solve (ray in SCENE, dial polar in HUD), then push to the
      // binding and fire onChange.
      if (this._grabbed && this._movedPending) {
        this._movedPending = false;
        if (hud) this._solveFromDial(p.mouseX, p.mouseY);
        else     this._solveFromPointer(p.mouseX, p.mouseY);
        this._afterSolve();
      }

      // Release — fire onRelease only if a grab was actually in progress.
      if (this._upPending) {
        this._upPending = false;
        if (this._grabbed) {
          this._grabbed = false;
          this.onRelease  && this.onRelease(this);
          this._onRelease && this._onRelease(this);
        }
      }

      return this._grabbed;
    }

    // ── Grab (color-ID pick) ────────────────────────────────────────────────

    /**
     * Color-ID hit-test the handle under the pointer. Renders one tagged proxy
     * sphere at the handle's current world position — sized to a constant
     * `grabPx` screen radius — into mousePick's 1×1 pick buffer, and returns
     * whether the decoded id is this handle's proxy.
     *
     * The proxy point is `value({ to: WORLD, report: POINT })`: the core folds
     * the anchor in (SPHERE → anchor + dir·radius, PLANE/AXIS → the constrained
     * point) and an EYE-frame handle maps back to WORLD, so this is exactly
     * where the dot will draw, in both frames.
     *
     * pixelRatio is read BEFORE mousePick: the pick pass installs a narrowed
     * 1×1 projection, so world-units-per-pixel must be sampled against the live
     * (main) projection first.
     *
     * @returns {boolean} true if the proxy was hit.
     */
    _pick() {
      const p = this._p;
      // Handle position in WORLD (see doc) — valid for WORLD and EYE frames.
      this.value({ to: WORLD, report: POINT, out: _proxy });
      // Constant screen size: worldRadius = grabPx · (world-units per pixel).
      const rad = this._grabPx * p.pixelRatio(_proxy);
      const id = p.mousePick(() => {
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

      // Convert the world ray into the constraint's working frame. EYE is the
      // headlight: the core sees only eye-space numbers and stays oblivious to
      // the camera. (Origin is a point, direction is a direction.)
      if (this._frame === EYE) {
        p.mapLocation(_near, { from: WORLD, to: EYE, out: _near });
        _dir[0] = dx; _dir[1] = dy; _dir[2] = dz;
        p.mapDirection(_dir, { from: WORLD, to: EYE, out: _dir });
        ox = _near[0]; oy = _near[1]; oz = _near[2];
        dx = _dir[0];  dy = _dir[1];  dz = _dir[2];
      }

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

    // ── HUD dial input (polar → heading) ──────────────────────────────────

    /** Pointer-in-dial test for the HUD grab. @returns {boolean} */
    _pickHud() {
      const p = this._p;
      const dx = p.mouseX - this._hud.at[0];
      const dy = p.mouseY - this._hud.at[1];
      const R  = this._hud.size;
      return (dx*dx + dy*dy) <= R*R;
    }

    /**
     * Map a dial pointer position to a heading and seed the SPHERE. Azimuthal
     * (polar) projection: angle → azimuth, radius → colatitude, so the dial
     * centre is +Y and the rim is −Y (the whole sphere is reachable).
     * dirFromAzEl + seed reuse the commit-1 core; the heading lives in the
     * handle's frame (eye-relative for an EYE SPHERE — the compass).
     */
    _solveFromDial(mx, my) {
      const c = this._constraint;
      let nx = (mx - this._hud.at[0]) / this._hud.size;
      let ny = (my - this._hud.at[1]) / this._hud.size;
      let rho = Math.hypot(nx, ny);
      if (rho > 1) { nx /= rho; ny /= rho; rho = 1; }   // clamp inside the dial
      const az = Math.atan2(ny, nx);
      const el = Math.PI / 2 - rho * Math.PI;           // colatitude → elevation
      dirFromAzEl(_hDir, az, el);
      const a = c.anchor;
      c.seed(a[0] + _hDir[0], a[1] + _hDir[1], a[2] + _hDir[2]);
    }

    // ── Value (pull-only) ───────────────────────────────────────────────────

    /**
     * Read the current value into a `p5.Vector` (fresh when `out` is omitted,
     * zero-alloc when supplied).
     *
     * DIRECTION routes through `mapDirection`, POINT through `mapLocation`. The
     * default `to` is the handle's own frame, so no conversion happens unless a
     * different space is requested.
     *
     * @param {{ to?: string, report?: number,
     *           out?: Float32Array | number[] | p5.Vector }} [opts]
     * @returns {Float32Array | number[] | p5.Vector}
     */
    value(opts = {}) {
      const c = this._constraint;
      const report = (opts.report === POINT || opts.report === DIRECTION) ? opts.report : c.report;
      const from = this._frame;
      const to   = opts.to ?? from;

      c.value(_v3, report);

      if (to === from) {
        return this._emit(opts.out, _v3[0], _v3[1], _v3[2]);
      }
      const mapOpts = { from, to, out: opts.out };
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
     * fires `onChange`. Values cross in the handle's own frame (the `value()`
     * default) — WORLD for a PLANE / AXIS / WORLD-SPHERE handle. An unrecognised
     * target logs and leaves the handle pull-only (§5). Chainable.
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

    // Seed the constraint from the bound target's current value. Read in the
    // handle's frame (see bind), which equals the working frame for WORLD
    // handles, so it feeds seed() directly. Accepts p5.Vector / array / {x,y,z}.
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
     * `color` overrides the ambient stroke / fill; `size` is the dot radius
     * in pixels (defaults to grabPx, so the dot fills the hit area). `marker:
     * null` suppresses the whole draw (parity with trackPath). Chainable.
     *
     * @param {{ bits?: number, color?: *, size?: number, marker?: null }} [opts]
     * @returns {Handle} this
     */
    draw(opts = {}) {
      if ('marker' in opts && opts.marker === null) return this;
      if (this._display === p5.Tree.HUD) this._drawHud(opts);
      else this._drawScene(opts);
      return this;
    }

    // Scene draw — the visual counterpart of the pixel→ray input path. Reads the
    // handle point + anchor in WORLD (so EYE-frame handles map back), then emits
    // the bit-selected parts. EYE-frame handles are best shown via the HUD dial;
    // in SCENE they render around the camera.
    _drawScene(opts) {
      const p = this._p;
      const c = this._constraint;
      const bits = Number.isFinite(opts.bits)
        ? opts.bits
        : (p5.Tree.HANDLE | p5.Tree.AIM | p5.Tree.LOCUS);
      const color  = opts.color;
      const sizePx = Number.isFinite(opts.size) ? opts.size : this._grabPx;

      // Handle point (WORLD) and anchor (WORLD) — both frames handled.
      this.value({ to: WORLD, report: POINT, out: _pW });
      const a = c.anchor;
      if (this._frame === EYE) p.mapLocation(a, { from: EYE, to: WORLD, out: _aW });
      else { _aW[0] = a[0]; _aW[1] = a[1]; _aW[2] = a[2]; }

      p.push();
      if (color != null) { p.stroke(color); p.fill(color); }

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

    // ── Draw (HUD) ───────────────────────────────────────────────

    /**
     * Render the 2D dial in screen space (beginHUD/endHUD). The current heading
     * is placed by the inverse of the input projection (colatitude → radius,
     * azimuth → angle); a line + dot mark it inside the dial boundary. Ambient
     * (or opts.color) stroke / fill. SPHERE-only, so non-SPHERE handles never
     * reach here (display is forced to SCENE).
     */
    _drawHud(opts) {
      const p = this._p;
      const r = p._renderer;
      const c = this._constraint;
      const color = opts.color;
      const cx = this._hud.at[0], cy = this._hud.at[1], R = this._hud.size;

      // Current heading → dial position (inverse of _solveFromDial's mapping).
      c.azEl(_azel);
      const rho = (Math.PI / 2 - _azel[1]) / Math.PI;
      const hx = cx + rho * R * Math.cos(_azel[0]);
      const hy = cy + rho * R * Math.sin(_azel[0]);

      p.beginHUD();
      if (color != null) { p.stroke(color); p.fill(color); }
      // Dial boundary + centre cross.
      p.noFill();
      r._circle({ x: cx, y: cy, radius: R });
      const ch = R * 0.12;
      p.line(cx - ch, cy, cx + ch, cy);
      p.line(cx, cy - ch, cx, cy + ch);
      // Heading: a line from the centre + a filled dot.
      p.line(cx, cy, hx, hy);
      p.noStroke();
      if (color != null) p.fill(color); else p.fill(255);
      r._circle({ filled: true, x: hx, y: hy, radius: Math.max(3, R * 0.1) });
      p.endHUD();
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
      if (!this._enabled) this._grabbed = false;
    }

    /** Working frame — WORLD, or EYE for a SPHERE handle (the headlight). */
    get frame() { return this._frame; }
    set frame(f) {
      if (f === EYE && this._constraint.kind !== SPHERE) {
        console.error('[p5.tree] handle: EYE frame is only meaningful for SPHERE; keeping WORLD.');
        return;
      }
      this._frame = (f === EYE) ? EYE : WORLD;
    }

    /** Display surface — SCENE (3D in-scene) or HUD (a 2D dial; SPHERE-only). */
    get display() { return this._display; }
    set display(d) {
      if (d === p5.Tree.HUD && this._constraint.kind !== SPHERE) {
        console.error('[p5.tree] handle: HUD display is SPHERE-only; keeping SCENE.');
        return;
      }
      this._display = (d === p5.Tree.HUD) ? p5.Tree.HUD : p5.Tree.SCENE;
    }

    // ── Teardown ────────────────────────────────────────────────────────────

    /** Remove pointer listeners and unregister. */
    dispose() {
      const c = this._canvas;
      if (c) {
        c.removeEventListener('pointerdown', this._onDown);
        c.removeEventListener('pointermove', this._onMove);
        c.removeEventListener('pointerup',   this._onUp);
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
   *   h = createHandle({ constraint: SPHERE, report: DIRECTION, frame: EYE })
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
   *   frame?:     string,
   *   anchor?:    p5.Vector | number[],
   *   radius?:    number,
   *   axis?:      p5.Vector | number[],
   *   normal?:    p5.Vector | number[],
   *   extent?:    number[],
   *   grabPx?:    number,
   *   enabled?:   boolean,
   *   display?:   number,
   *   hud?:       { at?: number[], size?: number },
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
