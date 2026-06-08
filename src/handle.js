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
 * ── Not yet wired (later passes) ─────────────────────────────────────────────
 * The grab here is provisional: ANY press on the canvas grabs. The
 * `mousePick`/`tag` proxy test that restricts the grab to the handle itself
 * lands next, together with the `onGrab`/`onChange`/`onRelease` hooks, the
 * polymorphic `bind()` + `sync()`, `draw()` and its bit-flags, the HUD display
 * surface, and the VIEW constraint. The controller seams those need — the grab
 * flag, the working-frame solve, the pull value — are already in place, so they
 * slot in without reshaping this file. See handle-design.md §8.
 */

'use strict';

import {
  createConstraint,
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

      // Core constraint owns the canonical state + value mapping. Vector opts
      // (anchor / normal / axis) pass straight through — the core duck-types
      // p5.Vector / array / typed array.
      this._constraint = createConstraint(kind, {
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

      // Runtime gate — false suspends grab/solve without disposing listeners.
      this._enabled = opts.enabled !== false;

      // Transport state. The pointer listeners only set the *_pending flags;
      // update() consumes them so all grab/solve happens inside draw().
      this._grabbed      = false;
      this._downPending  = false;
      this._movedPending = false;
      this._upPending    = false;

      this._attachPointer();
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
     * NOTE: until the pick lands, ANY press grabs (see header). The
     * `mousePick`/`tag` proxy test slots into the `_downPending` branch.
     *
     * @returns {boolean} grabbed
     */
    update() {
      if (!this._enabled) {
        this._grabbed = this._downPending = this._movedPending = this._upPending = false;
        return false;
      }
      const p = this._p;

      // Fresh press → grab. (Provisional: commit-3 mousePick gates this.)
      if (this._downPending) {
        this._downPending = false;
        this._grabbed = true;
      }

      // Drag → re-solve from the latest pointer position.
      if (this._grabbed && this._movedPending) {
        this._movedPending = false;
        this._solveFromPointer(p.mouseX, p.mouseY);
      }

      // Release.
      if (this._upPending) {
        this._upPending = false;
        this._grabbed = false;
      }

      return this._grabbed;
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
     * Move the constraint origin (sphere centre / plane point / axis anchor).
     * Mutates in place; chainable.
     * @param {p5.Vector|number[]} v
     * @returns {Handle} this
     */
    anchor(v) {
      const a = this._constraint.anchor;
      a[0] = _vx(v, 0, a[0]);
      a[1] = _vx(v, 1, a[1]);
      a[2] = _vx(v, 2, a[2]);
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
   *   enabled?:   boolean,
   * }} opts
   * @returns {Handle|null} The controller, or null on an invalid constraint.
   */
  fn.createHandle = function (opts = {}) {
    const kind = opts.constraint;
    if (kind !== SPHERE && kind !== PLANE && kind !== AXIS) {
      console.error('[p5.tree] createHandle: `constraint` must be SPHERE, PLANE, or AXIS; got ' + String(kind) + '. (VIEW and others land in a later pass.)');
      return null;
    }
    const h = new Handle(this, opts);
    _register(this, h);
    return h;
  };
}
