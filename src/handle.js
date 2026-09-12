/**
 * @file Draggable 3D handles
 * @module p5.tree/handle
 * @license AGPL-3.0-only
 *
 * Handles you drag with the mouse or a finger in a `WEBGL` sketch. Each one
 * moves on a sphere, a plane, an axis or a dial ring, or freely in the view,
 * and reports a point or a direction you read back as a `p5.Vector`. Create
 * one with `createHandle`, call `Handle.update()` first in `draw()` (it returns
 * true while the handle is held, so a grab can win over `orbitControl()`),
 * read it with `Handle.value()`, drive a vector or a camera with
 * `Handle.bind()` and show it with `Handle.draw()`.
 *
 * Reach for `createPointerRouter` when several handles overlap on screen,
 * such as the three rails of a translate gizmo: the router grabs only the
 * nearest handle under a press and shares hover between its members.
 *
 * @details
 * A thin p5 layer over the host's controller (`@nakednous/host`): the host
 * handle owns the gesture (presses, moves and claims from the host's pointer
 * source), the analytic pick (the pointer's ray against the constraint's
 * `proxy`, the grab size converted through `pixelRatio` at the proxy's
 * depth), the solve in WORLD, snap, hover, cancel, the deferred `from` frame
 * and the hooks — all against the host's view bag, which index.js fills from
 * renderer state each predraw and `update()` refreshes before it reads.
 *
 * What p5.tree adds: `value()` allocates a `p5.Vector` when `out` is omitted
 * and accepts `to: MODEL` plus the mat4 overrides `mapLocation` takes;
 * `bind()` accepts a `p5.Vector` and a `p5.Camera` lookat field beside the
 * host's accessor and vec3 shapes; `draw()` renders the dot, aim, locus and
 * ring at the ambient p5 state; `createPointerRouter` returns the host's
 * router bound to the sketch canvas; `p5.Tree.VIEW` is the host's `VIEW`.
 *
 * ### update() ordering contract
 * `update()` is host-driven (NOT a predraw hook) because the orbit gate depends
 * on the grab resolving before `orbitControl()`:
 *
 * ```js
 * function draw() {
 *   background(10)
 *   if (!h.update()) orbitControl()   // update() returns grabbed; grab wins
 *   // ... scene ...
 *   const v = h.value()               // pull the current value (fresh p5.Vector)
 * }
 * ```
 *
 * ### Custom kinds
 * A contract-conforming constraint object (`kind` / `solve` / `value` /
 * `seed`, optional `scalar` / `azEl` / `aim` / `proxy`) passes as
 * `constraint:`; its grab shape is its `proxy(ray, radius) → t`, a sphere at
 * its point when absent. A bridge-side `drawLocus(h, opts)` draws its
 * surface; without one it draws dot + aim and warns once.
 *
 * ### Deferred constraint frame (`from`)
 * The basis opts (`axis` / `normal` / `zero`) are symbolic — "Y, but whose
 * Y?". `from` names the space they resolve FROM into WORLD each idle frame,
 * frozen at grab. `draw()` re-resolves after the orbit moved the camera, so
 * an EYE-framed locus renders against the live state. SPHERE has no basis
 * and VIEW re-aims continuously by design; both reject `from`.
 */

'use strict';

import { SPHERE, PLANE, AXIS, DIAL, POINT, DIRECTION, WORLD } from '@nakednous/tree';
import { Handle as HostHandle, PointerRouter as HostRouter, validConstraint } from '@nakednous/host';
import { ensureHost, syncHostView } from './matrix.js';

// ═══════════════════════════════════════════════════════════════════════════
// Draw scratch — synchronous, single-threaded, never returned
// ═══════════════════════════════════════════════════════════════════════════

const _v3 = new Float32Array(3);   // value() extraction scratch
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

// A host stand-in for a handle created before createCanvas(): no pointer, no
// view, so update() is a no-op and nothing else throws.
const _NO_HOST = { pointer: null, view: null, register(c) { return c; }, unregister() {} };

// ═══════════════════════════════════════════════════════════════════════════
// Handle registry — per p5 instance, disposed on the remove lifecycle
// ═══════════════════════════════════════════════════════════════════════════

const HANDLES = new WeakMap();

function _handleSet(pInst) {
  let s = HANDLES.get(pInst);
  if (!s) { s = new Set(); HANDLES.set(pInst, s); }
  return s;
}

function _register(pInst, h)   { if (pInst && h) _handleSet(pInst).add(h); }
function _unregister(pInst, h) { if (pInst && h) HANDLES.get(pInst)?.delete(h); }

// Dispose every handle and router registered with a p5 instance. Called from
// `lifecycles.remove`.
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

  // The host of a p5 instance, or the stand-in before createCanvas().
  const _hostOf = (p) => {
    const host = ensureHost(p);
    if (!host) console.error('[p5.tree] handle: no canvas found — pointer input disabled. Create the handle after createCanvas().');
    return host || _NO_HOST;
  };

  /**
   * Interactive manipulator handle controller: the host's handle plus the
   * p5 conveniences — `p5.Vector` values, camera-field binding, and an
   * ambient-state draw.
   */
  class Handle extends HostHandle {
    /**
     * @param {p5}     p     The p5 instance the handle is bound to.
     * @param {Object} opts  Validated by `createHandle` (kind already checked).
     */
    constructor(p, opts) {
      super(_hostOf(p), opts);
      this._p = p;
      // The reused value the binding and onChange receive: a p5.Vector.
      this._bindVal = new p5.Vector(0, 0, 0);
      // A custom kind's locus draw (its grab shape is the constraint's proxy).
      this._drawLocusFn = typeof opts.drawLocus === 'function' ? opts.drawLocus : null;
      this._warnedLocus = false;
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    /**
     * Turn a press on the handle into a grab and follow the pointer while it is held. Call it first in `p5.draw()` every frame; it returns true while the handle is grabbed, so the orbit gate example uses it to decide whether `p5.orbitControl()` runs. When the handle sits on a `PointerRouter`, the router's own `PointerRouter.update()` call covers it.
     *
     * @details
     * Refreshes the host's view bag from the renderer (the camera may have
     * moved since predraw), then runs the host controller's update: the
     * frame's presses hit-tested against the proxy, a hit claiming the
     * pointer; moves solved, snapped, pushed to the binding with `onChange`;
     * `onRelease` on release, `onCancel` on Esc / `pointercancel` / `cancel()`.
     * Returns the post-update grabbed state so the orbit gate can
     * short-circuit; a disabled handle returns `false`.
     *
     * @function update
     * @memberof Handle
     * @returns {boolean} grabbed
     * @example
     * <caption>The orbit gate: a press on the dot grabs, a miss orbits</caption>
     * let h
     *
     * function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   h = createHandle({ constraint: p5.Tree.PLANE, normal: [0, 0, 1] })
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   if (!h.update()) orbitControl()
     *   axes()
     *   stroke('white')
     *   fill('#ff4fd8')
     *   h.draw()
     * }
     */
    update() {
      syncHostView(this._p);
      return super.update();
    }

    /**
     * Abandon the drag in flight and put the handle back where it was when it was grabbed. Esc and a lost pointer trigger it automatically; call it yourself for rules of your own, such as the leash example. Chainable.
     *
     * @details
     * Revert the drag in flight to the value captured at grab: the constraint
     * state is restored (exact θ winding included), the binding is re-set, and
     * `onCancel` fires (`onRelease` does not). No-op when not grabbed.
     * Triggered by Esc and `pointercancel` automatically. Chainable.
     *
     * @function cancel
     * @memberof Handle
     * @returns {Handle} this
     * @example
     * <caption>A leash: the drag reverts once it strays 120 units from the origin (Esc cancels too)</caption>
     * let h
     *
     * function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   h = createHandle({ constraint: p5.Tree.PLANE, normal: [0, 0, 1] })
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   if (!h.update()) orbitControl()
     *   if (h.grabbed() && h.value().mag() > 120) h.cancel()
     *   axes()
     *   noFill()
     *   stroke('white')
     *   circle(0, 0, 240)
     *   fill('#ff4fd8')
     *   h.draw({ bits: p5.Tree.HANDLE | p5.Tree.AIM })
     * }
     */
    cancel() { return super.cancel(); }

    // ── Value (pull-only) ───────────────────────────────────────────────────

    /**
     * Read the handle's current value as a `p5.Vector`, a position or a direction depending on what the handle reports. Pass `to` to read it in another space such as `EYE` or `SCREEN` (see the to: SCREEN and to: EYE examples). Pass `out` to write into a vector you already have instead of getting a fresh one.
     *
     * @details
     * Read the current value into a `p5.Vector` (fresh when `out` is omitted,
     * zero-alloc when supplied). The host's out-first form `value(out, opts)`
     * is accepted too — the host controller calls it for the binding.
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
     * @function value
     * @memberof Handle
     * @param {{ to?: string | Float32Array | number[] | p5.Matrix,
     *           report?: number,
     *           out?: Float32Array | number[] | p5.Vector,
     *           mat4Eye?: *, mat4Proj?: *, mat4View?: *, mat4PV?: * }} [opts]
     * @returns {Float32Array | number[] | p5.Vector}
     * @example
     * <caption>to: SCREEN, a HUD label pinned to the handle; the default read is world</caption>
     * let h
     *
     * async function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   textFont(await loadFont('fonts/noto_sans.ttf'))
     *   textSize(14)
     *   h = createHandle({ constraint: p5.Tree.PLANE, normal: [0, 0, 1] })
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   if (!h.update()) orbitControl()
     *   axes()
     *   stroke('white')
     *   fill('#ff4fd8')
     *   h.draw()
     *   const w = h.value()
     *   const s = h.value({ to: p5.Tree.SCREEN })
     *   beginHUD()
     *   noStroke()
     *   fill('white')
     *   text('(' + [w.x, w.y, w.z].map(v => v.toFixed(0)).join(', ') + ')', s.x + 12, s.y + 4)
     *   endHUD()
     * }
     * @example
     * <caption>to: EYE, the same heading read in the camera's frame; out reuses a buffer</caption>
     * let h
     * const d = new Float32Array(3)
     *
     * async function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   textFont(await loadFont('fonts/noto_sans.ttf'))
     *   textSize(14)
     *   h = createHandle({ constraint: p5.Tree.SPHERE, radius: 80, report: p5.Tree.DIRECTION })
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   if (!h.update()) orbitControl()
     *   axes()
     *   stroke('white')
     *   fill('#ff4fd8')
     *   h.draw()
     *   h.value({ to: p5.Tree.EYE, out: d })
     *   beginHUD()
     *   noStroke()
     *   fill('white')
     *   text('eye-space heading ' + [d[0], d[1], d[2]].map(v => v.toFixed(2)).join('  '), 10, 20)
     *   endHUD()
     * }
     */
    value(a, b) {
      // Two forms: value(opts) with an optional opts.out, or the host's
      // value(out, opts) — told apart by an array-like or p5.Vector first argument.
      const outFirst = a != null && (a instanceof p5.Vector || typeof a.length === 'number');
      const opts = (outFirst ? b : a) || {};
      const out  = outFirst ? a : opts.out;
      const c = this._constraint;
      const report = (opts.report === POINT || opts.report === DIRECTION) ? opts.report : c.report;
      const from = WORLD;
      const to   = opts.to ?? from;

      c.value(_v3, report);

      if (to === from) {
        return this._emit(out, _v3[0], _v3[1], _v3[2]);
      }
      const mapOpts = {
        from, to, out,
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
     * Attach the handle to something it drives while dragged: a `p5.Vector` moved in place, a `p5.Camera`'s eye, center or up, or your own get and set pair. The handle jumps to the target's current value right away (see the p5.Vector and camera lookat examples). Chainable.
     *
     * @details
     * Bind the handle to a target it drives while dragging. Polymorphic, with
     * an accessor floor; dispatch is by shape, with no positional ambiguity:
     *
     *   bind(vec)                       p5.Vector — mutated in place (zero-alloc)
     *   bind(cam, 'eye'|'center'|'up')  p5.Camera lookat field — re-applies the camera
     *   bind([x, y, z])                 a vec3 array mutated in place — a camera state's eye or center
     *   bind({ get, set })              accessor floor — get() → value, set(value) writes
     *
     * `get()` seeds the constraint immediately, so the handle starts at the
     * target's current value. While grabbed, each solve calls `set(value)` with
     * a reused `p5.Vector` and fires `onChange` with the same. Values cross in
     * WORLD (the `value()` default). An unrecognised target logs and leaves the
     * handle pull-only. Chainable.
     *
     * @function bind
     * @memberof Handle
     * @param {p5.Vector | p5.Camera | number[] | { get: Function, set: Function }} target
     * @param {string} [field]  Camera lookat field: 'eye' | 'center' | 'up'.
     * @returns {Handle} this
     * @example
     * <caption>A p5.Vector mutated in place: the sphere sits at the handle's value</caption>
     * let h, pos
     *
     * function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   pos = createVector(60, -40, 0)
     *   h = createHandle({ constraint: p5.Tree.VIEW }).bind(pos)
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   if (!h.update()) orbitControl()
     *   axes()
     *   noStroke()
     *   fill('#ffd166')
     *   push()
     *   translate(pos)
     *   sphere(20)
     *   pop()
     *   stroke('white')
     *   fill('#ff4fd8')
     *   h.draw({ bits: p5.Tree.HANDLE })
     * }
     * @example
     * <caption>A camera lookat field: drag a second camera's eye, its frustum follows</caption>
     * let cam, h
     *
     * function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   camera(300, -200, 500, 0, 0, 0, 0, 1, 0)
     *   cam = createCamera()
     *   cam.camera(0, -80, 250, 0, 0, 0, 0, 1, 0)
     *   cam.perspective(PI / 4, width / height, 50, 350)
     *   h = createHandle({ constraint: p5.Tree.VIEW }).bind(cam, 'eye')
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   if (!h.update()) orbitControl()
     *   axes()
     *   stroke('white')
     *   noFill()
     *   box(60)
     *   stroke('#ffd166')
     *   viewFrustum({ camera: cam })
     *   fill('#ff4fd8')
     *   h.draw({ bits: p5.Tree.HANDLE })
     * }
     */
    bind(target, field) {
      if (target instanceof p5.Vector) {
        return super.bind({ get: () => target, set: (v) => target.set(v.x, v.y, v.z) });
      }
      if (target instanceof p5.Camera) {
        if (field !== 'eye' && field !== 'center' && field !== 'up') {
          console.error("[p5.tree] handle.bind: a p5.Camera needs a field — 'eye', 'center', or 'up'. Leaving unbound.");
          return this;
        }
        return super.bind({ get: () => _camFieldGet(target, field), set: (v) => _camFieldSet(target, field, v.x, v.y, v.z) });
      }
      if (target && typeof target === 'object' && typeof target.length === 'number' && target.length >= 3) {
        return super.bind({ get: () => target, set: (v) => { target[0] = v.x; target[1] = v.y; target[2] = v.z; } });
      }
      return super.bind(target);   // an accessor, or the host's diagnostic
    }

    /**
     * Move the handle back onto its bound target after your code changed the target between drags, for example when the camera moved or a keyframe was edited (see the sync example). Does nothing when the handle is unbound. Chainable.
     *
     * @details
     * Re-seed the constraint from the bound target after it changed externally
     * (the camera moved, a keyframe was edited, …). No-op when unbound.
     * Chainable.
     *
     * @function sync
     * @memberof Handle
     * @returns {Handle} this
     * @example
     * <caption>The bound vector moves under script control between grabs; sync() keeps the handle on it</caption>
     * let h, pos
     *
     * function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   pos = createVector(0, 0, 0)
     *   h = createHandle({ constraint: p5.Tree.PLANE, normal: [0, 0, 1] }).bind(pos)
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   if (!h.update()) orbitControl()
     *   if (!h.grabbed()) {
     *     pos.x = 100 * sin(frameCount * 0.02)
     *     h.sync()
     *   }
     *   axes()
     *   noStroke()
     *   fill('#ffd166')
     *   push()
     *   translate(pos)
     *   sphere(15)
     *   pop()
     *   stroke('white')
     *   fill('#ff4fd8')
     *   h.draw({ bits: p5.Tree.HANDLE | p5.Tree.AIM })
     * }
     */
    sync() { return super.sync(); }

    // ── Draw (SCENE) ──────────────────────────────────────────────────

    /**
     * Draw the handle in the scene: the dot, the aim line from the anchor, the surface it moves on and an optional ring, in the current stroke and fill colours. Pick the parts with the `HANDLE`, `AIM`, `LOCUS` and `RING` bits and set `size` for the dot radius in pixels (see the bits and colours example). Chainable; needs a `p5.WEBGL` canvas.
     *
     * @details
     * Render the handle's visuals in the scene. Composes existing gizmo
     * primitives (lines, a pane quad, sampled rings, the dot) at the
     * dark-bg / bright-stroke aesthetic — nothing here re-implements geometry.
     * The dot draws at a constant screen size via pixelRatio. Options last;
     * bit-flags select parts (parity with trackPath).
     *
     * Bits (default HANDLE | AIM | LOCUS):
     *   HANDLE — the draggable dot at the handle's point.
     *   AIM    — a line from the anchor to the handle's point (a DIAL's spoke).
     *   LOCUS  — the constraint surface: SPHERE wire | PLANE quad | AXIS
     *            segment | DIAL ring | VIEW square — or a custom kind's
     *            `drawLocus(h, opts)`.
     *   RING   — SPHERE view-facing limb | PLANE border.
     *
     * Draws at the ambient p5 state, like every gizmo: stroke() colours the
     * stroked parts (AIM / LOCUS / RING), fill() the dot (HANDLE) — set both
     * for a one-colour handle. Hover carries no styling of its own: read
     * `hovered()` and set the ambient state before draw(). `size` is the dot
     * radius in pixels (defaults to grabPx, so the dot fills the hit area).
     * `marker: null` suppresses the whole draw (parity with trackPath).
     * Chainable.
     *
     * @function draw
     * @memberof Handle
     * @param {{ bits?: number, size?: number, marker?: null }} [opts]
     * @returns {Handle} this
     * @example
     * <caption>Bits and colours: locus and ring from the ambient stroke, the dot from the fill</caption>
     * let h
     *
     * function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   h = createHandle({ constraint: p5.Tree.SPHERE, radius: 80 })
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   if (!h.update()) orbitControl()
     *   axes()
     *   const { HANDLE, AIM, LOCUS, RING } = p5.Tree
     *   stroke('white')
     *   h.draw({ bits: LOCUS })
     *   stroke('#ffd166')
     *   h.draw({ bits: RING | AIM })
     *   fill('#ff4fd8')
     *   h.draw({ bits: HANDLE, size: 8 })
     * }
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
      // Deferred frame: draw runs AFTER orbitControl moved the camera, so
      // refresh the view bag and re-resolve here — an EYE / moving-frame basis
      // renders against the live state, not update()'s pre-orbit snapshot.
      // Idle only; a grab freezes it.
      if (this._from && !this._grabbed && this._view) { syncHostView(p); this._resolveFrame(); }
      const bits = Number.isFinite(opts.bits)
        ? opts.bits
        : (p5.Tree.HANDLE | p5.Tree.AIM | p5.Tree.LOCUS);
      const sizePx = Number.isFinite(opts.size) ? opts.size : this._grabPx;

      // Handle point (WORLD) and anchor (WORLD; custom kinds may not have one).
      this.value(_pW, { report: POINT });
      const a = c.anchor || null;
      if (a) { _aW[0] = a[0]; _aW[1] = a[1]; _aW[2] = a[2]; }

      // Ambient p5 state, like every gizmo: the stroked parts (AIM / LOCUS /
      // RING) follow stroke(); the dot (HANDLE) follows fill().
      p.push();

      // LOCUS — the surface of allowed positions (dispatch; custom kinds
      // supply drawLocus).
      if ((bits & p5.Tree.LOCUS) !== 0) this._drawLocus(opts);

      // RING — SPHERE limb (circle ⊥ the view direction) | PLANE border.
      // (VIEW's screen-aligned square and DIAL's circle are their LOCUS; they
      // have no separate ring. Custom kinds: none.)
      if ((bits & p5.Tree.RING) !== 0 && a) {
        p.push();
        p.noFill();
        if (c.kind === SPHERE && !this._isView) {
          const cam = p.getCamera();
          if (cam) {
            _b2[0] = _aW[0] - cam.eyeX;
            _b2[1] = _aW[1] - cam.eyeY;
            _b2[2] = _aW[2] - cam.eyeZ;
            _norm3(_b2);
            _basisFromNormal(_b2, _b0, _b1);
            this._ring(_aW[0], _aW[1], _aW[2], c.radius, _b0, _b1);
          }
        } else if (c.kind === PLANE && !this._isView) {
          this._planeQuad(_aW, c.n, _PLANE_HALF);
        }
        p.pop();
      }

      // AIM — anchor → handle point (a DIAL's radial spoke).
      if ((bits & p5.Tree.AIM) !== 0 && a) {
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

    // LOCUS dispatch — the custom-kind extension seam. A custom `drawLocus(h, opts)`
    // wins; built-in kinds draw their own; an unknown kind without one draws
    // nothing here (dot + aim still render) and warns once.
    _drawLocus(opts) {
      const p = this._p;
      const c = this._constraint;
      if (this._drawLocusFn) { this._drawLocusFn(this, opts); return; }
      p.push();
      p.noFill();
      if (this._isView) {
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
      } else if (c.kind === DIAL) {
        // The ring itself: the circle of allowed positions in the dial plane.
        _basisFromNormal(c.u, _b0, _b1);
        this._ring(_aW[0], _aW[1], _aW[2], c.radius, _b0, _b1);
      } else if (!this._warnedLocus) {
        this._warnedLocus = true;
        console.error('[p5.tree] handle: custom kind ' + String(c.kind) +
          ' has no drawLocus — drawing dot + aim only. Pass drawLocus(h, opts) to createHandle.');
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

    // ── Readouts and edits ─────────────────────────────────────────────────

    /**
     * Read the handle's one-number value: the signed distance along an `AXIS` rail, or the angle in radians of a `DIAL`, which keeps counting past a full turn (see the DIAL example). NaN for the other constraints.
     *
     * @details
     * Current scalar parameter: AXIS — signed t; DIAL — accumulated θ in
     * radians (multi-turn). NaN otherwise.
     *
     * @function scalar
     * @memberof Handle
     * @returns {number}
     * @example
     * <caption>A DIAL's accumulated angle turns the box; keep dragging past a full turn</caption>
     * let h
     *
     * function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   camera(200, -150, 300, 0, 0, 0, 0, 1, 0)
     *   h = createHandle({ constraint: p5.Tree.DIAL, axis: [0, 1, 0], radius: 80 })
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   if (!h.update()) orbitControl()
     *   axes()
     *   stroke('white')
     *   fill('#ff4fd8')
     *   h.draw()
     *   push()
     *   rotateY(h.scalar())
     *   stroke('#ffd166')
     *   noFill()
     *   box(40)
     *   pop()
     * }
     */
    scalar() { return super.scalar(); }

    /**
     * Read a `SPHERE` handle's direction as azimuth and elevation angles in a two-element array (see the readout example). Pass `out2` to write into an array you already have instead of getting a fresh one.
     *
     * @details
     * Derive `[az, el]` from the current direction (SPHERE readout). Writes
     * into `out2` when supplied.
     *
     * @function azEl
     * @memberof Handle
     * @param {number[]} [out2]
     * @returns {number[]} [az, el]
     * @example
     * <caption>Azimuth and elevation of a SPHERE handle, read out</caption>
     * let h
     *
     * async function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   textFont(await loadFont('fonts/noto_sans.ttf'))
     *   textSize(14)
     *   h = createHandle({ constraint: p5.Tree.SPHERE, radius: 80 })
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   if (!h.update()) orbitControl()
     *   axes()
     *   stroke('white')
     *   fill('#ff4fd8')
     *   h.draw()
     *   const [az, el] = h.azEl()
     *   beginHUD()
     *   noStroke()
     *   fill('white')
     *   text('az ' + degrees(az).toFixed(0) + '   el ' + degrees(el).toFixed(0), 10, 20)
     *   endHUD()
     * }
     */
    azEl(out2) { return super.azEl(out2); }

    /**
     * True while the handle is held, from the press that grabs it to the release (see the magenta example).
     * @function grabbed
     * @memberof Handle
     * @returns {boolean}
     * @example
     * <caption>The dot turns magenta while held</caption>
     * let h
     *
     * function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   h = createHandle({ constraint: p5.Tree.PLANE, normal: [0, 0, 1] })
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   if (!h.update()) orbitControl()
     *   axes()
     *   stroke('white')
     *   fill(h.grabbed() ? '#ff4fd8' : 'white')
     *   h.draw()
     * }
     */
    grabbed() { return super.grabbed(); }

    /**
     * True while the pointer is over the handle, and while the handle is held. A lone handle needs `hover: true` to track this (see the hover example); a handle on a `PointerRouter` gets it for free.
     *
     * @details
     * True while the pointer rests on the proxy (and while grabbed). Lone
     * handles opt in with `hover: true` (one pick per moved frame); routed
     * handles get it from the router's shared pick for free.
     *
     * @function hovered
     * @memberof Handle
     * @returns {boolean}
     * @example
     * <caption>hover: true on a lone handle: the dot lights up under the pointer</caption>
     * let h
     *
     * function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   h = createHandle({ constraint: p5.Tree.PLANE, normal: [0, 0, 1], hover: true })
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   if (!h.update()) orbitControl()
     *   axes()
     *   stroke('white')
     *   fill(h.hovered() ? '#ff4fd8' : 'white')
     *   h.draw()
     * }
     */
    hovered() { return super.hovered(); }

    /**
     * Move the handle's reference point: the sphere centre, the plane point, the axis anchor, the dial centre, or the dragged point of a `VIEW` handle. The handle's own point follows, so the dot and its hit area stay together (see the orbiting object example). Chainable.
     *
     * @details
     * Move the constraint's reference point — sphere centre / plane point /
     * axis anchor / dial centre, or the dragged point for a VIEW handle. The
     * stored handle point rides along (AXIS keeps its scalar; PLANE re-projects
     * its point; DIAL recomputes from θ), so the dot and the pick proxy never
     * lag a moved anchor. In place; chainable.
     *
     * @function anchor
     * @memberof Handle
     * @param {p5.Vector|number[]} v
     * @returns {Handle} this
     * @example
     * <caption>The anchor follows an orbiting object; the ring rides along</caption>
     * let h
     *
     * function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   camera(200, -150, 300, 0, 0, 0, 0, 1, 0)
     *   h = createHandle({ constraint: p5.Tree.DIAL, axis: [0, 1, 0], radius: 60 })
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   if (!h.update()) orbitControl()
     *   const t = frameCount * 0.01
     *   h.anchor([120 * cos(t), 0, 120 * sin(t)])
     *   axes()
     *   stroke('white')
     *   fill('#ff4fd8')
     *   h.draw()
     *   push()
     *   translate(120 * cos(t), 0, 120 * sin(t))
     *   rotateY(h.scalar())
     *   stroke('#ffd166')
     *   noFill()
     *   box(30)
     *   pop()
     * }
     */
    anchor(v) { return super.anchor(v); }

    // ── Teardown ────────────────────────────────────────────────────────────

    /**
     * Detach the handle from the canvas: it lets go of any pointer it holds and stops reacting to the mouse or touch (see the any-key example).
     *
     * @details
     * Release the pointer claim, leave the host, and unregister from the
     * sketch's teardown list.
     *
     * @function dispose
     * @memberof Handle
     * @example
     * <caption>Any key disposes the handle: its listeners go and the orbit is unconditional</caption>
     * let h
     *
     * function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   h = createHandle({ constraint: p5.Tree.PLANE, normal: [0, 0, 1] })
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   const grabbed = h ? h.update() : false
     *   if (!grabbed) orbitControl()
     *   axes()
     *   if (h) {
     *     stroke('white')
     *     fill('#ff4fd8')
     *     h.draw()
     *   }
     * }
     *
     * function keyPressed() {
     *   if (h) {
     *     h.dispose()
     *     h = null
     *   }
     * }
     */
    dispose() {
      super.dispose();
      _unregister(this._p, this);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // PointerRouter — shared arbitration for OVERLAPPING handles
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * The host's router bound to the sketch canvas: one shared pick across all
   * member proxies per press (and per moved frame, for hover), the nearest
   * hit winning, presses and claims through the host's pointer source.
   */
  class PointerRouter extends HostRouter {
    /**
     * @param {p5}       p
     * @param {Handle[]} handles
     * @param {{ hover?: boolean }} [opts]  hover defaults to TRUE — one shared
     *        pick per frame with pointer motion sets at most one hovered member
     *        (the reason to colocate handles on a router); pass false to skip
     *        the per-move pick.
     */
    constructor(p, handles, opts = {}) {
      super(_hostOf(p), handles, opts);
      this._p = p;
    }

    /**
     * Put a handle under the router, so presses on it are decided by the router together with the other members instead of by the handle alone (see the Z rail example). Chainable.
     *
     * @details
     * Route a handle: its own pointerdown adoption is disabled and the router's
     * shared pick grabs it via `_adopt`. Move/solve/release stay the handle's
     * own. Chainable.
     *
     * @function add
     * @memberof PointerRouter
     * @param {Handle} h
     * @returns {PointerRouter} this
     * @example
     * <caption>Any key toggles the Z rail in and out of the router; out, it self-picks and updates on its own</caption>
     * let hx, hy, hz, r
     * let routed = true
     *
     * function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   camera(200, -150, 300, 0, 0, 0, 0, 1, 0)
     *   const { AXIS } = p5.Tree
     *   hx = createHandle({ constraint: AXIS, axis: [1, 0, 0], anchor: [60, -40, 0], extent: [-120, 120] })
     *   hy = createHandle({ constraint: AXIS, axis: [0, 1, 0], anchor: [60, -40, 0], extent: [-120, 120] })
     *   hz = createHandle({ constraint: AXIS, axis: [0, 0, 1], anchor: [60, -40, 0], extent: [-120, 120] })
     *   r = createPointerRouter(hx, hy, hz)
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   let grabbed = r.update()
     *   if (!routed) grabbed = hz.update() || grabbed
     *   if (!grabbed) orbitControl()
     *   axes()
     *   for (const h of [hx, hy, hz]) {
     *     stroke(h === hz && !routed ? '#ffd166' : 'white')
     *     fill(h.grabbed() ? '#ff4fd8' : 'white')
     *     h.draw()
     *   }
     * }
     *
     * function keyPressed() {
     *   routed ? r.remove(hz) : r.add(hz)
     *   routed = !routed
     * }
     */
    add(h) { return super.add(h); }

    /**
     * Take a handle out of the router, so it decides its own presses again (see the Z rail example). Chainable.
     *
     * @details
     * Un-route a handle (it self-picks again). Chainable.
     *
     * @function remove
     * @memberof PointerRouter
     * @param {Handle} h
     * @returns {PointerRouter} this
     * @example
     * <caption>Any key toggles the Z rail in and out of the router; out, it self-picks and updates on its own</caption>
     * let hx, hy, hz, r
     * let routed = true
     *
     * function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   camera(200, -150, 300, 0, 0, 0, 0, 1, 0)
     *   const { AXIS } = p5.Tree
     *   hx = createHandle({ constraint: AXIS, axis: [1, 0, 0], anchor: [60, -40, 0], extent: [-120, 120] })
     *   hy = createHandle({ constraint: AXIS, axis: [0, 1, 0], anchor: [60, -40, 0], extent: [-120, 120] })
     *   hz = createHandle({ constraint: AXIS, axis: [0, 0, 1], anchor: [60, -40, 0], extent: [-120, 120] })
     *   r = createPointerRouter(hx, hy, hz)
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   let grabbed = r.update()
     *   if (!routed) grabbed = hz.update() || grabbed
     *   if (!grabbed) orbitControl()
     *   axes()
     *   for (const h of [hx, hy, hz]) {
     *     stroke(h === hz && !routed ? '#ffd166' : 'white')
     *     fill(h.grabbed() ? '#ff4fd8' : 'white')
     *     h.draw()
     *   }
     * }
     *
     * function keyPressed() {
     *   routed ? r.remove(hz) : r.add(hz)
     *   routed = !routed
     * }
     */
    remove(h) { return super.remove(h); }

    /**
     * Resolve the pending presses across the routed handles, so that only the nearest one grabs where they overlap, refresh hover and update every member. Call it first in `p5.draw()` in place of the members' own updates; it returns true while any member is grabbed, so the cluster example uses it to decide whether `p5.orbitControl()` runs.
     *
     * @details
     * Refreshes the host's view bag from the renderer, then resolves the
     * frame's presses with ONE shared pick each (nearest t wins), refreshes
     * hover on pointer motion, and delegates to every member's `update()`.
     * Call FIRST in `draw()`, in place of the members' own updates:
     *
     * ```js
     * if (!router.update()) orbitControl()
     * ```
     *
     * @function update
     * @memberof PointerRouter
     * @returns {boolean} true if any member is grabbed.
     * @example
     * <caption>One gate for the cluster: three rails share an anchor, the nearest proxy wins the press</caption>
     * let hx, hy, hz, r
     *
     * function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   camera(200, -150, 300, 0, 0, 0, 0, 1, 0)
     *   const { AXIS } = p5.Tree
     *   hx = createHandle({ constraint: AXIS, axis: [1, 0, 0], anchor: [60, -40, 0], extent: [-120, 120] })
     *   hy = createHandle({ constraint: AXIS, axis: [0, 1, 0], anchor: [60, -40, 0], extent: [-120, 120] })
     *   hz = createHandle({ constraint: AXIS, axis: [0, 0, 1], anchor: [60, -40, 0], extent: [-120, 120] })
     *   r = createPointerRouter(hx, hy, hz)
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   if (!r.update()) orbitControl()
     *   axes()
     *   for (const h of [hx, hy, hz]) {
     *     stroke('white')
     *     fill(h.grabbed() ? '#ff4fd8' : 'white')
     *     h.draw()
     *   }
     * }
     */
    update() {
      syncHostView(this._p);
      return super.update();
    }

    /**
     * The routed handle under the pointer right now, or null when there is none (see the shared hover example).
     *
     * @details
     * The member currently under the pointer, or null. Grabbed members read
     * hovered via their own `hovered()`.
     *
     * @function hovered
     * @memberof PointerRouter
     * @returns {Handle|null}
     * @example
     * <caption>Shared hover: the member under the pointer draws in yellow</caption>
     * let hx, hy, hz, r
     *
     * function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   camera(200, -150, 300, 0, 0, 0, 0, 1, 0)
     *   const { AXIS } = p5.Tree
     *   hx = createHandle({ constraint: AXIS, axis: [1, 0, 0], anchor: [60, -40, 0], extent: [-120, 120] })
     *   hy = createHandle({ constraint: AXIS, axis: [0, 1, 0], anchor: [60, -40, 0], extent: [-120, 120] })
     *   hz = createHandle({ constraint: AXIS, axis: [0, 0, 1], anchor: [60, -40, 0], extent: [-120, 120] })
     *   r = createPointerRouter(hx, hy, hz)
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   if (!r.update()) orbitControl()
     *   axes()
     *   const hot = r.hovered()
     *   for (const h of [hx, hy, hz]) {
     *     stroke(h === hot ? '#ffd166' : 'white')
     *     fill(h.grabbed() ? '#ff4fd8' : 'white')
     *     h.draw()
     *   }
     * }
     */
    hovered() { return super.hovered(); }

    /**
     * Shut the router down: every member decides its own presses again, updated in a plain loop (see the any-key example).
     *
     * @details
     * Un-route every member, leave the host, and unregister from the sketch's
     * teardown list.
     *
     * @function dispose
     * @memberof PointerRouter
     * @example
     * <caption>Any key disposes the router: the members self-pick again, updated in a plain loop</caption>
     * let hs, r
     *
     * function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   camera(200, -150, 300, 0, 0, 0, 0, 1, 0)
     *   const { AXIS } = p5.Tree
     *   hs = [
     *     createHandle({ constraint: AXIS, axis: [1, 0, 0], anchor: [60, -40, 0], extent: [-120, 120] }),
     *     createHandle({ constraint: AXIS, axis: [0, 1, 0], anchor: [60, -40, 0], extent: [-120, 120] }),
     *     createHandle({ constraint: AXIS, axis: [0, 0, 1], anchor: [60, -40, 0], extent: [-120, 120] })
     *   ]
     *   r = createPointerRouter(...hs)
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   let grabbed = false
     *   if (r) grabbed = r.update()
     *   else for (const h of hs) grabbed = h.update() || grabbed   // un-routed: one finger each
     *   if (!grabbed) orbitControl()
     *   axes()
     *   for (const h of hs) {
     *     stroke(r ? 'white' : '#ffd166')
     *     fill(h.grabbed() ? '#ff4fd8' : 'white')
     *     h.draw()
     *   }
     * }
     *
     * function keyPressed() {
     *   if (r) {
     *     r.dispose()
     *     r = null
     *   }
     * }
     */
    dispose() {
      super.dispose();
      _unregister(this._p, this);
    }
  }

  // ── Factories ───────────────────────────────────────────────────────────

  /**
   * Drag a point on a sphere, a plane, an axis or a dial ring, or freely in the view, with the mouse or a finger. Choose the `constraint` and whether it reports a `POINT` or a `DIRECTION`, place it with `anchor`, `radius`, `axis` or `normal`, and add `snap`, `hover`, a bound target or the `onGrab`, `onChange` and `onRelease` callbacks as needed (see the SPHERE, from: EYE and snap examples). Drive it from `p5.draw()` with `Handle.update()` and read it with `value()`; needs a `p5.WEBGL` canvas.
   *
   * @details
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
   * @function createHandle
   * @memberof p5
   * @param {{
   *   constraint: number | Object,
   *   report?:    number,
   *   anchor?:    p5.Vector | number[],
   *   radius?:    number,
   *   axis?:      p5.Vector | number[],
   *   normal?:    p5.Vector | number[],
   *   zero?:      p5.Vector | number[],
   *   from?:      *,
   *   extent?:    number[],
   *   grabPx?:    number,
   *   snap?:      number | number[],
   *   hover?:     boolean,
   *   enabled?:   boolean,
   *   bind?:      p5.Vector | number[] | { get: Function, set: Function },
   *   drawLocus?: Function,
   *   onGrab?:    Function,
   *   onChange?:  Function,
   *   onRelease?: Function,
   *   onCancel?:  Function,
   * }} opts
   * @returns {Handle|null} The `Handle`, or null on an invalid constraint.
   * @example
   * <caption>A SPHERE handle reporting a DIRECTION: drag it to aim the light</caption>
   * let h
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   h = createHandle({ constraint: p5.Tree.SPHERE, radius: 80, report: p5.Tree.DIRECTION })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   if (!h.update()) orbitControl()   // a grab wins over orbit
   *   axes()
   *   const d = h.value()               // unit direction, world
   *   ambientLight(60)
   *   directionalLight(255, 255, 255, -d.x, -d.y, -d.z)   // the light comes from the handle
   *   noStroke()
   *   fill('#ffd166')
   *   sphere(40)
   *   noLights()
   *   stroke('white')
   *   fill('#ff4fd8')
   *   h.draw()
   * }
   * @example
   * <caption>from: EYE, a screen-horizontal rail whatever the orbit</caption>
   * let h
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   h = createHandle({ constraint: p5.Tree.AXIS, axis: [1, 0, 0], extent: [-120, 120], from: p5.Tree.EYE })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   if (!h.update()) orbitControl()
   *   axes()
   *   stroke('white')
   *   fill('#ff4fd8')
   *   h.draw()
   * }
   * @example
   * <caption>snap, hover and the hooks: a 25-unit grid, a lit hover, a fill that tracks the gesture</caption>
   * let h
   * let tone = 'white'
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   h = createHandle({
   *     constraint: p5.Tree.PLANE, normal: [0, 0, 1],
   *     snap: 25, hover: true,
   *     onGrab: () => { tone = '#ff4fd8' },
   *     onRelease: () => { tone = '#ffd166' },
   *     onCancel: () => { tone = 'white' }   // Esc while held
   *   })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   if (!h.update()) orbitControl()
   *   axes()
   *   stroke(h.hovered() ? '#ffd166' : 'white')
   *   fill(tone)
   *   h.draw()
   * }
   */
  fn.createHandle = function (opts = {}) {
    if (!validConstraint(opts.constraint)) {
      console.error('[p5.tree] createHandle: `constraint` must be SPHERE, PLANE, AXIS, DIAL, VIEW, or a contract-conforming constraint object; got ' + String(opts.constraint) + '.');
      return null;
    }
    const h = new Handle(this, opts);
    _register(this, h);
    return h;
  };

  /**
   * Group handles that may overlap on screen, so a press grabs only the nearest one and hover is shared between them. Pass the handles, then an optional options object with `hover` (on by default), and drive the router from `p5.draw()` with `PointerRouter.update()` (see the translate cluster example).
   *
   * @details
   * Create a pointer router over a set of (potentially overlapping) handles —
   * one shared nearest-hit pick, a claimed-pointer set through the host's
   * pointer source, and shared hover. Options last:
   *
   * ```js
   * const r = createPointerRouter(hx, hy, hz, dial)            // hover on
   * const r = createPointerRouter(hx, hy, hz, { hover: false })
   * // draw(): if (!r.update()) orbitControl(); hs.forEach(h => h.draw())
   * ```
   *
   * @function createPointerRouter
   * @memberof p5
   * @param {...(Handle | { hover?: boolean })} args  Handles, then an optional
   *        options object last.
   * @returns {PointerRouter}
   * @example
   * <caption>A translate cluster: three rails on one anchor, routed so exactly one grabs</caption>
   * let hx, hy, hz, r
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   camera(200, -150, 300, 0, 0, 0, 0, 1, 0)
   *   const { AXIS } = p5.Tree
   *   hx = createHandle({ constraint: AXIS, axis: [1, 0, 0], anchor: [60, -40, 0], extent: [-120, 120] })
   *   hy = createHandle({ constraint: AXIS, axis: [0, 1, 0], anchor: [60, -40, 0], extent: [-120, 120] })
   *   hz = createHandle({ constraint: AXIS, axis: [0, 0, 1], anchor: [60, -40, 0], extent: [-120, 120] })
   *   r = createPointerRouter(hx, hy, hz)   // hover shared, on by default
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   if (!r.update()) orbitControl()   // in place of the members' own updates
   *   axes()
   *   for (const h of [hx, hy, hz]) {
   *     stroke(h.hovered() ? '#ffd166' : 'white')
   *     fill(h.grabbed() ? '#ff4fd8' : 'white')
   *     h.draw()
   *   }
   * }
   */
  fn.createPointerRouter = function (...args) {
    let opts = {};
    if (args.length && args[args.length - 1] && !(args[args.length - 1] instanceof HostHandle)) {
      opts = args.pop();
    }
    const r = new PointerRouter(this, args, opts);
    _register(this, r);
    return r;
  };
}
