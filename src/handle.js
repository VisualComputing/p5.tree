/**
 * @file Interactive manipulator handle — p5 bridge controller + pointer router.
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
 * ── Constraint kinds ─────────────────────────────────────────────────────────
 * Core SPHERE / PLANE / AXIS / DIAL pass straight through. DIAL is the
 * rotation handle: a 1-DOF accumulated angle on a circle; its pick proxy is a
 * TORUS along the ring (grab anywhere on the ring, like every DCC rotate
 * gizmo), and its `scalar()` is the multi-turn θ. VIEW is a bridge constraint:
 * a core PLANE whose normal is re-aimed at the camera each solve (a
 * screen-parallel drag plane through the current point), reported as a world
 * position. The core never learns about the camera; the `_view` flag carries
 * the bridge behaviour (plane re-aim, direct-set seed, screen-aligned square
 * locus).
 *
 * A CUSTOM kind passes a contract-conforming constraint object
 * (`kind`/`solve`/`value`/`seed`, optional `scalar`/`azEl` — handle-design.md
 * §9) as `constraint:`, plus a bridge-side `drawLocus(h, opts)` (and optionally
 * `pickProxy(h, pos, rad)`) — the controller drives lifecycle, ray, value
 * conversion, bind, hooks, and pick for it; without a `drawLocus` it draws only
 * dot + aim and warns once.
 *
 * ── Snap / hover / cancel ────────────────────────────────────────────────────
 * `snap` quantizes at the solve seam (bridge, post-solve, pre-`set()`): an
 * angular step for SPHERE (az/el) and DIAL (θ), a world grid for PLANE / AXIS /
 * VIEW (PLANE re-projects the snapped point, so off-plane grids land on the
 * nearest on-plane point). Settable live (`h.snap = …`) — gate it on a modifier
 * in the sketch for the Blender Ctrl convention. `hover` (lone-handle opt-in;
 * the ROUTER provides it shared) is a pick-on-move read out via `hovered()` —
 * styling stays in the sketch, at the ambient-state philosophy. Cancel reverts
 * the drag to the value captured at grab: Esc or `pointercancel` while held, or
 * `h.cancel()` programmatically; the binding is restored and `onCancel` fires
 * (release does NOT fire). Mirrors three's `reset()` / Blender's modal cancel.
 *
 * ── Deferred constraint frame (`from`) ──────────────────────────────────────
 * The basis opts (`axis` / `normal` / `zero`) are symbolic — "Y, but whose
 * Y?". `from` names the space they resolve FROM into WORLD: it is literally
 * `mapDirection`'s `from`, deferred. Resolution (one mapDirection per vector
 * + a core `aim()`) re-runs each idle frame — so the locus and pick proxy
 * track a turning frame live — and is implicitly frozen at grab: the basis
 * never changes mid-drag (snapshot-at-press, well-posed under camera motion).
 * Directions only; the anchor stays a world location (anchor() moves it when
 * the frame carries the origin too). WORLD / absent skips it all — identical
 * to a from-less handle. SPHERE has no basis and VIEW re-aims continuously by
 * design (a deliberately DIFFERENT semantics from PLANE + from: EYE, which
 * freezes the plane at press); both reject `from`. A custom kind participates
 * iff it exposes aim() (§9, optional member).
 *
 * ── Multitouch: per-pointer capture (A) and the router (B) ──────────────────
 * The whole gesture keys to one pointerId (see update()), and the pick + solve
 * read that pointer's own coords — so on a shared surface each handle tracks
 * its own finger and ignores the rest. Independent, non-overlapping handles
 * work with a plain loop (one finger each). OVERLAPPING handles (a clustered
 * TRS gizmo; a track's keyframe handles — TrackHandles, track.js) break
 * per-handle self-picking — two proxies under one finger each
 * see only themselves and double-grab — so they share a `createPointerRouter`:
 * ONE depth-resolved pick across all member proxies (one pass, distinct ids,
 * winner-by-id, nearest wins by z), an id→handle map, and a claimed-pointer
 * set; unclaimed pointers fall through to the camera gesture. Routed handles
 * skip their own pointerdown adoption (`_routed`) and are grabbed via an
 * injected `_adopt` — from the first move on, the per-pointer machinery runs
 * verbatim. The router also amortizes hover (one shared pick per moved frame)
 * and lifts A's same-frame limit: every queued press resolves, not just one.
 */

'use strict';

import {
  createConstraint, dirFromAzEl,
  SPHERE, PLANE, AXIS, DIAL,
  POINT, DIRECTION,
  WORLD, SCREEN,
} from '@nakednous/tree';

// ═══════════════════════════════════════════════════════════════════════════
// Module-level scratch — synchronous, single-threaded, never returned
// ═══════════════════════════════════════════════════════════════════════════
//
// update()/value() run to completion within one draw() call with no reentrancy
// across handles, so a handle's solve never interleaves with another's. Shared
// scratch is therefore safe — same discipline as gizmos.js (_sl/_wl). The pick
// PROXY position/radius are per-instance (`_proxyPos`/`_proxyRad`), NOT module
// scratch, because the router renders every member's proxy in one shared pass.

const _sIn  = new Float32Array(3);   // screen-space pick input (mx, my, depth)
const _near = new Float32Array(3);   // unprojected near point (ray origin)
const _far  = new Float32Array(3);   // unprojected far point
const _v3   = new Float32Array(3);   // value() extraction scratch
const _q2   = [0, 0];                // az/el snap scratch

// Single pick id for a lone handle's self-pick pass. The router assigns each
// member its own id (index + 1) in the shared pass.
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

// Pointer event → logical canvas coords (the [0,width]×[0,height] space
// colorPick and mapLocation(SCREEN) expect). Goes through the element rect so a
// CSS-scaled canvas maps correctly, sidestepping the mouseX/mouseY scaling skew
// (processing/p5.js#8669). Falls back to mouseX/mouseY without a rect. Shared
// by Handle and PointerRouter.
const _eventXY = (p, canvas, e, out) => {
  const r = (canvas && canvas.getBoundingClientRect) ? canvas.getBoundingClientRect() : null;
  if (r && r.width > 0 && r.height > 0) {
    out[0] = (e.clientX - r.left) * (p.width  / r.width);
    out[1] = (e.clientY - r.top)  * (p.height / r.height);
  } else {
    out[0] = p.mouseX; out[1] = p.mouseY;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Handle registry — per p5 instance, disposed on the remove lifecycle
// ═══════════════════════════════════════════════════════════════════════════
//
// Mirrors track.js's player registry: handles (and routers) attach DOM
// listeners at construction, so the sketch teardown must release them. See
// index.js remove.

const HANDLES = new WeakMap();

function _handleSet(pInst) {
  let s = HANDLES.get(pInst);
  if (!s) { s = new Set(); HANDLES.set(pInst, s); }
  return s;
}

function _register(pInst, h)   { if (pInst && h) _handleSet(pInst).add(h); }
function _unregister(pInst, h) { if (pInst && h) HANDLES.get(pInst)?.delete(h); }

/**
 * Dispose every handle and router registered with a p5 instance. Called from
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

  // Contract check for a custom constraint object (handle-design.md §9).
  const _isConstraint = (c) =>
    c && typeof c === 'object' &&
    typeof c.solve === 'function' &&
    typeof c.value === 'function' &&
    typeof c.seed  === 'function';

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
      // camera-oblivious; _view marks the bridge behaviour. A custom constraint
      // object passes straight through (§9 contract; checked in the factory).
      this._view = (kind === p5.Tree.VIEW);

      if (_isConstraint(kind)) {
        this._constraint = kind;
      } else {
        const coreKind = this._view ? PLANE : kind;
        // Core constraint owns the canonical state + value mapping. Vector opts
        // (anchor / normal / axis / zero) pass straight through — the core
        // duck-types p5.Vector / array / typed array.
        this._constraint = createConstraint(coreKind, {
          radius: opts.radius,
          report: opts.report,
          anchor: opts.anchor,
          normal: opts.normal,
          axis:   opts.axis,
          zero:   opts.zero,
          extent: opts.extent,
        });
      }

      // Bridge-side seams for a custom kind: locus draw + pick-proxy draw.
      // Built-in kinds ignore them. drawLocus(h, opts) draws the constraint
      // surface; pickProxy(h, pos, rad) draws the tagged grab geometry (fill is
      // already the tag colour; pos/rad are the prepped constant-px values —
      // pixelRatio is NOT valid inside the pick pass, see _proxyPrep).
      this._drawLocusFn = typeof opts.drawLocus === 'function' ? opts.drawLocus : null;
      this._proxyFn     = typeof opts.pickProxy === 'function' ? opts.pickProxy : null;
      this._warnedLocus = false;

      // Deferred constraint frame (see header / handle-design.md §4.13).
      // Symbolic basis copies live here; _resolveFrame() maps them into WORLD
      // and re-aims the core constraint.
      this._from     = null;
      this._fromDir  = null;
      this._fromZero = null;
      if (opts.from != null && opts.from !== WORLD) {
        const custom = _isConstraint(kind);
        const dirOpt = (kind === PLANE) ? opts.normal : (opts.axis ?? opts.normal);
        const ok = !this._view &&
                   (kind === PLANE || kind === AXIS || kind === DIAL ||
                    (custom && typeof this._constraint.aim === 'function'));
        if (!ok) {
          console.error('[p5.tree] createHandle: `from` needs an aimable constraint — PLANE, AXIS, DIAL, or a custom kind exposing aim(); ignoring.');
        } else if (custom && dirOpt == null) {
          console.error('[p5.tree] createHandle: `from` on a custom kind needs a symbolic `axis` (or `normal`) to resolve; ignoring.');
        } else {
          this._from = opts.from;
          this._fromDir = [
            _vx(dirOpt, 0, kind === AXIS ? 1 : 0),
            _vx(dirOpt, 1, kind === AXIS ? 0 : 1),
            _vx(dirOpt, 2, 0),
          ];
          if (opts.zero != null) {
            this._fromZero = [_vx(opts.zero, 0, 1), _vx(opts.zero, 1, 0), _vx(opts.zero, 2, 0)];
          } else if (kind === DIAL) {
            // Derive the θ=0 reference ONCE, in the FROM space, so axis and
            // zero co-rotate under the frame — re-deriving per resolve from
            // the resolved axis alone can flip across the least-aligned-axis
            // branch (a visible θ jump while the frame turns).
            _b2[0] = this._fromDir[0]; _b2[1] = this._fromDir[1]; _b2[2] = this._fromDir[2];
            _norm3(_b2);
            const r0 = [0, 0, 0], r1 = [0, 0, 0];
            _basisFromNormal(_b2, r0, r1);
            this._fromZero = r0;
          }
        }
      }

      // Runtime gate — false suspends grab/solve without disposing listeners.
      this._enabled = opts.enabled !== false;

      // Pick-proxy radius in screen pixels — the grab hit-test size, drawn at
      // constant screen size regardless of depth (see _proxyPrep).
      this._grabPx = Number.isFinite(opts.grabPx) ? opts.grabPx : 12;

      // Snap step — quantizes at the solve seam (null = off). Angular step
      // (radians) for SPHERE az/el and DIAL θ; world grid (number | [x,y,z])
      // for PLANE / AXIS / VIEW. Settable live.
      this._snap = opts.snap ?? null;

      // Hover (lone-handle opt-in; the router provides it shared): pick-on-move
      // while idle, read out via hovered(). Costs one 1×1 readback per frame
      // with pointer motion — prefer the router when handles cluster.
      this._hover        = opts.hover === true;
      this._hovered      = false;
      this._hoverPending = false;
      this._hxy          = new Float32Array(2);

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
      // moved). _routed hands the *down* step to a PointerRouter (shared pick,
      // injected _adopt); everything from the first move on is identical.
      this._grabbed       = false;
      this._downPending   = false;
      this._movedPending  = false;
      this._upPending     = false;
      this._cancelPending = false;
      this._pid           = null;
      this._ptr           = new Float32Array(2);
      this._routed        = false;

      // Pick-proxy prep (constant-px sizing sampled against the LIVE projection,
      // before colorPick installs the pick one) — per instance, because the
      // router preps every member before its one shared pass.
      this._proxyPos = new Float32Array(3);
      this._proxyRad = 0;

      // Cancel state — the value (and scalar, for winding) captured at grab;
      // cancel() reverts to it and restores the binding.
      this._saved  = new Float32Array(3);
      this._savedS = 0;

      // Interaction hooks (user-facing) + lib-space seams (_on*, for the
      // bridge / UI / router). Fired user-first, mirroring Track's onPlay/onEnd.
      this.onGrab     = typeof opts.onGrab    === 'function' ? opts.onGrab    : null;
      this.onRelease  = typeof opts.onRelease === 'function' ? opts.onRelease : null;
      this.onChange   = typeof opts.onChange  === 'function' ? opts.onChange  : null;
      this.onCancel   = typeof opts.onCancel  === 'function' ? opts.onCancel  : null;
      this._onGrab    = null;
      this._onRelease = null;
      this._onChange  = null;
      this._onCancel  = null;

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
      // misses (update frees it), releases, or cancels. Pointer capture keeps
      // move / up / cancel flowing to the canvas while the finger drags off the
      // dot or off-canvas; the capture is on the (shared) canvas, so co-existing
      // handles each capture their own pointerId without conflict. A ROUTED
      // handle never self-adopts — the router's shared pick decides and calls
      // _adopt.
      this._onDown = (e) => {
        if (this._routed) return;                // the router owns the down step
        if (this._pid !== null) return;          // already tracking a finger
        this._pid = e.pointerId;
        _eventXY(this._p, canvas, e, this._ptr);
        this._downPending = true;
        if (canvas.setPointerCapture) {
          try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* best effort */ }
        }
      };
      this._onMove = (e) => {
        if (e.pointerId !== this._pid) {
          // Idle + hover opted-in: remember the pointer for the hover pick.
          if (this._pid === null && this._hover && !this._routed) {
            _eventXY(this._p, canvas, e, this._hxy);
            this._hoverPending = true;
          }
          return;                                // not our finger
        }
        _eventXY(this._p, canvas, e, this._ptr);
        this._movedPending = true;
      };
      this._onUp = (e) => {
        if (e.pointerId !== this._pid) return;   // not our finger
        _eventXY(this._p, canvas, e, this._ptr);
        this._upPending = true;
      };
      this._onPCancel = (e) => {                  // pointercancel → revert, not commit
        if (e.pointerId !== this._pid) return;
        this._cancelPending = true;
      };
      // Esc reverts the drag in flight (Blender's modal cancel / three's reset).
      this._onKey = (e) => {
        if (e.key === 'Escape' && this._grabbed) this._cancelPending = true;
      };
      canvas.addEventListener('pointerdown',   this._onDown);
      canvas.addEventListener('pointermove',   this._onMove);
      canvas.addEventListener('pointerup',     this._onUp);
      canvas.addEventListener('pointercancel', this._onPCancel);
      window.addEventListener('keydown',       this._onKey);
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    /**
     * Resolve the grab and re-solve from the pointer. Call FIRST in `draw()`
     * (or call the router's `update()` when routed — it delegates here).
     *
     * Returns the post-update grabbed state so the orbit gate can short-circuit
     * (`if (!h.update()) orbitControl()`). A disabled handle is an immediate
     * no-op returning `false`.
     *
     * A fresh press color-ID picks the tagged proxy (`_pickAt`); only a hit
     * grabs, so a miss leaves `grabbed` false and the press falls through to
     * `orbitControl()`. `onGrab` fires on a successful grab, `onChange` on each
     * solve while held (after `snap`), `onRelease` on the matching release, and
     * `onCancel` instead of `onRelease` when the drag is reverted (Esc /
     * `pointercancel` / `cancel()`).
     *
     * @returns {boolean} grabbed
     */
    update() {
      if (!this._enabled) {
        this._grabbed = this._downPending = this._movedPending = false;
        this._upPending = this._cancelPending = this._hoverPending = false;
        this._hovered = false;
        this._pid = null;
        return false;
      }
      // Deferred frame: refresh the basis while idle so the locus / proxy /
      // pick track the FROM space live; a grab freezes it for the gesture
      // (snapshot-at-press — the drag solves a stationary constraint).
      if (this._from && !this._grabbed) this._resolveFrame();
      // Fresh press → color-ID hit-test at OUR pointer's pixel; grab only on a
      // hit. A miss frees _pid, so the next press — or, on a multitouch surface,
      // another finger — can be adopted. (Routed handles never get here; the
      // router's shared pick calls _adopt instead.)
      if (this._downPending) {
        this._downPending = false;
        if (this._pickAt(this._ptr[0], this._ptr[1])) {
          this._beginGrab();
        } else {
          this._pid = null;
        }
      }

      // Drag → re-solve from our pointer's ray, snap, then push to the binding
      // and fire onChange.
      if (this._grabbed && this._movedPending) {
        this._movedPending = false;
        this._solveFromPointer(this._ptr[0], this._ptr[1]);
        this._applySnap();
        this._afterSolve();
      }

      // Cancel (Esc / pointercancel / cancel()) — revert to the grab-time value
      // and go idle. Wins over a same-frame release.
      if (this._cancelPending) {
        this._cancelPending = this._upPending = this._movedPending = false;
        if (this._grabbed) this._cancelNow();
        else this._pid = null;
      }

      // Release (pointerup) — fire onRelease only if a grab was in progress,
      // then go idle so the handle is free for the next press.
      if (this._upPending) {
        this._upPending = this._movedPending = false;
        if (this._grabbed) {
          this._grabbed = false;
          this.onRelease  && this.onRelease(this);
          this._onRelease && this._onRelease(this);
        }
        this._pid = null;
      }

      // Hover (lone-handle opt-in; routed handles get it from the router's
      // shared pick): one readback per frame with pointer motion while idle.
      if (this._grabbed) {
        this._hovered = true;
      } else if (this._hover && !this._routed && this._hoverPending) {
        this._hoverPending = false;
        this._hovered = this._pickAt(this._hxy[0], this._hxy[1]);
      }

      return this._grabbed;
    }

    // Begin a grab: capture the cancel state, mark grabbed, fire onGrab. Used
    // by both the self-pick path and the router's _adopt.
    _beginGrab() {
      const c = this._constraint;
      c.value(this._saved, POINT);
      this._savedS = typeof c.scalar === 'function' ? c.scalar() : 0;
      this._grabbed = true;
      this.onGrab  && this.onGrab(this);
      this._onGrab && this._onGrab(this);
    }

    /**
     * Router seam: adopt a pointer decided by a shared pick. Sets the gesture
     * pointer + coords and begins the grab; from the first move on, the
     * per-pointer machinery (`update()`) runs unchanged.
     * @param {number} pointerId
     * @param {number} x,y  Press position in logical canvas px.
     */
    _adopt(pointerId, x, y) {
      this._pid = pointerId;
      this._ptr[0] = x; this._ptr[1] = y;
      this._downPending = false;
      if (this._canvas && this._canvas.setPointerCapture) {
        try { this._canvas.setPointerCapture(pointerId); } catch (_) { /* best effort */ }
      }
      this._beginGrab();
    }

    /**
     * Revert the drag in flight to the value captured at grab: the constraint
     * state is restored (exact θ winding included), the binding is re-set, and
     * `onCancel` fires (`onRelease` does not). No-op when not grabbed.
     * Triggered by Esc and `pointercancel` automatically. Chainable.
     * @returns {Handle} this
     */
    cancel() {
      if (this._grabbed) this._cancelNow();
      return this;
    }

    _cancelNow() {
      const c = this._constraint;
      if (this._view) {
        // VIEW: the point IS the value; the plane is ephemeral.
        c.pt[0] = this._saved[0]; c.pt[1] = this._saved[1]; c.pt[2] = this._saved[2];
      } else if (c.kind === DIAL) {
        // Restore the exact accumulated θ (seed would pick the nearest winding,
        // which can be the wrong turn after a multi-turn drag).
        c.s = this._savedS;
        c._dialPoint();
      } else {
        c.seed(this._saved[0], this._saved[1], this._saved[2]);
      }
      if (this._binder) {
        this._bindVal ||= new p5.Vector(0, 0, 0);
        this._binder.set(this.value({ out: this._bindVal }));
      }
      this._grabbed = false;
      if (this._pid !== null && this._canvas && this._canvas.releasePointerCapture) {
        try { this._canvas.releasePointerCapture(this._pid); } catch (_) { /* best effort */ }
      }
      this._pid = null;
      this.onCancel  && this.onCancel(this);
      this._onCancel && this._onCancel(this);
    }

    // ── Grab (color-ID pick) ────────────────────────────────────────────────

    // Resolve the symbolic FROM-space basis into WORLD and re-aim the core
    // constraint — one mapDirection per vector. Refreshed at every idle
    // CONSUMPTION site — update() (the self-pick), _proxyPrep (the routed
    // pick), and _drawScene (the visuals, post-orbit) — and never mid-drag.
    // The grab needs no extra call: both pick paths resolve before _beginGrab.
    _resolveFrame() {
      const p = this._p;
      p.mapDirection(this._fromDir, { from: this._from, to: WORLD, out: _b2 });
      if (this._fromZero) {
        p.mapDirection(this._fromZero, { from: this._from, to: WORLD, out: _b0 });
        this._constraint.aim(_b2[0], _b2[1], _b2[2], _b0[0], _b0[1], _b0[2]);
      } else {
        this._constraint.aim(_b2[0], _b2[1], _b2[2]);
      }
    }

    // Prep the pick proxy against the LIVE projection: world position + the
    // world radius of a constant `grabPx` screen size. Must run BEFORE
    // colorPick, which installs a narrowed 1×1 pick projection (pixelRatio
    // sampled inside the pick pass would be wrong). Per-instance outputs so the
    // router can prep every member, then render them all in one pass.
    _proxyPrep() {
      const p = this._p;
      const c = this._constraint;
      // Routed members are prepped before their update() runs — refresh the
      // deferred frame here too so the shared pick sees a live basis.
      if (this._from && !this._grabbed) this._resolveFrame();
      if (c.kind === DIAL && !this._view) {
        // DIAL grabs anywhere on the ring: the proxy is a torus at the anchor;
        // the prepped radius is the constant-px TUBE radius.
        const a = c.anchor;
        this._proxyPos[0] = a[0]; this._proxyPos[1] = a[1]; this._proxyPos[2] = a[2];
      } else {
        this.value({ to: WORLD, report: POINT, out: this._proxyPos });
      }
      this._proxyRad = this._grabPx * p.pixelRatio(this._proxyPos);
    }

    // Render the tagged proxy geometry (fill = tag colour for `id`). Runs
    // inside a colorPick pass — the pick projection is installed, so all
    // constant-px sizing comes from _proxyPrep. The router calls this for every
    // member with its own id; depth testing makes the nearest proxy win.
    _renderProxy(id) {
      const p = this._p;
      const c = this._constraint;
      p.push();
      p.noStroke();
      p.fill(p.tag(id));
      if (this._proxyFn) {
        this._proxyFn(this, this._proxyPos, this._proxyRad);
      } else if (c.kind === DIAL && !this._view) {
        // Torus along the ring, +Z aligned to the dial axis.
        p.translate(this._proxyPos[0], this._proxyPos[1], this._proxyPos[2]);
        const u = c.u, dot = u[2];
        if (dot < -0.999999) p.rotate(Math.PI, [1, 0, 0]);
        else if (dot < 0.999999) p.rotate(Math.acos(dot), [-u[1], u[0], 0]);
        p.torus(c.radius, Math.max(this._proxyRad, 1e-6), 32, 8);
      } else {
        p.translate(this._proxyPos[0], this._proxyPos[1], this._proxyPos[2]);
        p.sphere(this._proxyRad);
      }
      p.pop();
    }

    /**
     * Color-ID hit-test this handle's proxy at a canvas pixel. Preps the proxy
     * against the live projection, renders it tagged into colorPick's 1×1 pick
     * buffer, and returns whether the decoded id matches.
     * @returns {boolean} true if the proxy was hit.
     */
    _pickAt(x, y) {
      this._proxyPrep();
      const id = this._p.colorPick(x, y, () => this._renderProxy(PROXY_ID));
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

    // ── Snap (the solve seam: post-solve, pre-set) ──────────────────────────

    /** Snap step — angular (rad) for SPHERE/DIAL, world grid for PLANE/AXIS/VIEW.
     *  `null` disables. Settable live (gate on a modifier for the Ctrl idiom). */
    get snap()  { return this._snap; }
    set snap(v) { this._snap = v ?? null; }

    // Quantize the freshly solved constraint state. Angular kinds quantize the
    // canonical parameter directly (no winding loss); positional kinds quantize
    // the value point and re-seed (PLANE re-projects, so an off-plane grid
    // lands on the nearest on-plane point).
    _applySnap() {
      const sn = this._snap;
      if (sn == null) return;
      const c = this._constraint;
      if (this._view || c.kind === PLANE) {
        const gx = Array.isArray(sn) ? sn[0] : sn;
        const gy = Array.isArray(sn) ? sn[1] : sn;
        const gz = Array.isArray(sn) ? sn[2] : sn;
        _v3[0] = gx > 0 ? Math.round(c.pt[0] / gx) * gx : c.pt[0];
        _v3[1] = gy > 0 ? Math.round(c.pt[1] / gy) * gy : c.pt[1];
        _v3[2] = gz > 0 ? Math.round(c.pt[2] / gz) * gz : c.pt[2];
        if (this._view) { c.pt[0] = _v3[0]; c.pt[1] = _v3[1]; c.pt[2] = _v3[2]; }
        else c.seed(_v3[0], _v3[1], _v3[2]);
      } else if (c.kind === AXIS || c.kind === DIAL) {
        const step = Array.isArray(sn) ? sn[0] : sn;
        if (!(step > 0)) return;
        const q = Math.round(c.s / step) * step;
        c.s = q < c.min ? c.min : (q > c.max ? c.max : q);
        if (c.kind === DIAL) c._dialPoint();
        else {
          c.pt[0] = c.anchor[0] + c.s * c.u[0];
          c.pt[1] = c.anchor[1] + c.s * c.u[1];
          c.pt[2] = c.anchor[2] + c.s * c.u[2];
        }
      } else if (c.kind === SPHERE) {
        const step = Array.isArray(sn) ? sn[0] : sn;
        if (!(step > 0)) return;
        c.azEl(_q2);
        dirFromAzEl(c.dir,
                    Math.round(_q2[0] / step) * step,
                    Math.round(_q2[1] / step) * step);
      }
      // Custom kinds: no generic snap — quantize in the constraint's solve or
      // in onChange.
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
      // Resolve a deferred frame before seeding, so the seed projects onto
      // the live basis (bind can run before the first update()).
      if (this._from && !this._grabbed) this._resolveFrame();
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
      // Deferred frame: draw runs AFTER orbitControl moved the camera, so
      // re-resolve here — an EYE / moving-frame basis renders against the live
      // state, not update()'s pre-orbit snapshot. Idle only; a grab freezes it.
      if (this._from && !this._grabbed) this._resolveFrame();
      const bits = Number.isFinite(opts.bits)
        ? opts.bits
        : (p5.Tree.HANDLE | p5.Tree.AIM | p5.Tree.LOCUS);
      const sizePx = Number.isFinite(opts.size) ? opts.size : this._grabPx;

      // Handle point (WORLD) and anchor (WORLD; custom kinds may not have one).
      this.value({ to: WORLD, report: POINT, out: _pW });
      const a = c.anchor || null;
      if (a) { _aW[0] = a[0]; _aW[1] = a[1]; _aW[2] = a[2]; }

      // Ambient p5 state, like every gizmo: the stroked parts (AIM / LOCUS /
      // RING) follow stroke(); the dot (HANDLE) follows fill().
      p.push();

      // LOCUS — the surface of allowed positions (dispatch; custom kinds
      // supply drawLocus, see §9).
      if ((bits & p5.Tree.LOCUS) !== 0) this._drawLocus(opts);

      // RING — SPHERE limb (circle ⊥ the view direction) | PLANE border.
      // (VIEW's screen-aligned square and DIAL's circle are their LOCUS; they
      // have no separate ring. Custom kinds: none.)
      if ((bits & p5.Tree.RING) !== 0 && a) {
        p.push();
        p.noFill();
        if (c.kind === SPHERE && !this._view) {
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

    // LOCUS dispatch — the §9 extension seam. A custom `drawLocus(h, opts)`
    // wins; built-in kinds draw their own; an unknown kind without one draws
    // nothing here (dot + aim still render) and warns once.
    _drawLocus(opts) {
      const p = this._p;
      const c = this._constraint;
      if (this._drawLocusFn) { this._drawLocusFn(this, opts); return; }
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

    /**
     * Current scalar parameter: AXIS — signed t; DIAL — accumulated θ in
     * radians (multi-turn). NaN otherwise.
     * @returns {number}
     */
    scalar() { return typeof this._constraint.scalar === 'function' ? this._constraint.scalar() : NaN; }

    /**
     * Derive `[az, el]` from the current direction (SPHERE readout). Writes
     * into `out2` when supplied.
     * @param {number[]} [out2]
     * @returns {number[]} [az, el]
     */
    azEl(out2) {
      return typeof this._constraint.azEl === 'function'
        ? this._constraint.azEl(out2 || [0, 0])
        : (out2 || [0, 0]);
    }

    /**
     * True between grab and release.
     * @returns {boolean}
     */
    grabbed() { return this._grabbed; }

    /**
     * True while the pointer rests on the proxy (and while grabbed). Lone
     * handles opt in with `hover: true` (one pick per moved frame); routed
     * handles get it from the router's shared pick for free.
     * @returns {boolean}
     */
    hovered() { return this._hovered; }

    /**
     * Move the constraint's reference point — sphere centre / plane point /
     * axis anchor / dial centre, or the dragged point for a VIEW handle. The
     * stored handle point rides along (AXIS keeps its scalar; PLANE re-projects
     * its point; DIAL recomputes from θ), so the dot and the pick proxy never
     * lag a moved anchor. In place; chainable.
     * @param {p5.Vector|number[]} v
     * @returns {Handle} this
     */
    anchor(v) {
      const c = this._constraint;
      const t = this._view ? c.pt : c.anchor;
      if (!t) return this;
      t[0] = _vx(v, 0, t[0]);
      t[1] = _vx(v, 1, t[1]);
      t[2] = _vx(v, 2, t[2]);
      // The stored point must ride the moved reference — pt is canonical state
      // for AXIS / PLANE / DIAL (SPHERE derives its POINT live from
      // anchor + dir). Without this, an idle handle's dot AND its pick proxy
      // stay at the OLD anchor's point until the next solve — visibly detached
      // when another handle drives the anchor (a PLANE + AXIS "place" pair).
      // Mirrors aim()'s per-kind maintenance: AXIS keeps its scalar, PLANE
      // re-projects its point onto the translated plane, DIAL recomputes from θ.
      if (!this._view) {
        if (c.kind === DIAL) {
          c._dialPoint();
        } else if (c.kind === AXIS) {
          c.pt[0] = c.anchor[0] + c.s * c.u[0];
          c.pt[1] = c.anchor[1] + c.s * c.u[1];
          c.pt[2] = c.anchor[2] + c.s * c.u[2];
        } else if (c.kind === PLANE) {
          c.seed(c.pt[0], c.pt[1], c.pt[2]);
        }
      }
      return this;
    }

    // ── Runtime gates ───────────────────────────────────────────────────────

    /** Runtime gate — `false` suspends grab/solve without disposing. */
    get enabled() { return this._enabled; }
    set enabled(v) {
      this._enabled = !!v;
      if (!this._enabled) { this._grabbed = false; this._hovered = false; this._pid = null; }
    }

    // ── Teardown ────────────────────────────────────────────────────────────

    /** Remove pointer + key listeners and unregister. */
    dispose() {
      const c = this._canvas;
      if (c) {
        c.removeEventListener('pointerdown',   this._onDown);
        c.removeEventListener('pointermove',   this._onMove);
        c.removeEventListener('pointerup',     this._onUp);
        c.removeEventListener('pointercancel', this._onPCancel);
      }
      window.removeEventListener('keydown', this._onKey);
      this._canvas = null;
      _unregister(this._p, this);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // PointerRouter — shared arbitration for OVERLAPPING handles (§4.11 B)
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Coordinates a set of (potentially overlapping) handles: one depth-resolved
   * color-ID pick across all member proxies per press (and per moved frame,
   * for hover), an id→handle map, and a claimed-pointer set. Per-handle
   * self-picking double-grabs on overlap — two proxies under one finger each
   * render only themselves and both hit; the shared pass renders every proxy
   * with a distinct id and lets the depth buffer pick the winner.
   *
   * Members keep their own move/up/cancel machinery (per-pointer multitouch,
   * §4.11 A, verbatim); the router replaces only the DOWN step. Presses are
   * queued and resolved in `update()` (all listener work stays flag-setting),
   * so several same-frame presses on different members all land — lifting A's
   * single-candidate limit. Unclaimed pointers fall through to the camera
   * gesture untouched.
   */
  class PointerRouter {
    /**
     * @param {p5}       p
     * @param {Handle[]} handles
     * @param {{ hover?: boolean }} [opts]  hover defaults to TRUE — one shared
     *        pick per frame with pointer motion sets at most one hovered member
     *        (the reason to colocate handles on a router); pass false to skip
     *        the per-move readback.
     */
    constructor(p, handles, opts = {}) {
      this._p = p;
      this._handles = [];
      this._claimed = new Map();          // pointerId → handle
      this._downs   = [];                 // queued presses: { pid, x, y }
      this._hover      = opts.hover !== false;
      this._hoverMoved = false;
      this._hxy        = new Float32Array(2);
      this._hoveredH   = null;
      this._xy         = new Float32Array(2);

      const canvas = _canvasOf(p);
      this._canvas = canvas;
      if (!canvas) {
        console.error('[p5.tree] createPointerRouter: no canvas found — pointer input disabled. Create the router after createCanvas().');
      } else {
        this._onDown = (e) => {
          if (this._claimed.has(e.pointerId)) return;
          _eventXY(this._p, canvas, e, this._xy);
          this._downs.push({ pid: e.pointerId, x: this._xy[0], y: this._xy[1] });
          if (canvas.setPointerCapture) {
            try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* best effort */ }
          }
        };
        this._onMove = (e) => {
          if (this._claimed.has(e.pointerId)) return;   // a drag is not a hover
          if (!this._hover) return;
          _eventXY(this._p, canvas, e, this._hxy);
          this._hoverMoved = true;
        };
        this._onUp = (e) => {                            // also pointercancel
          this._claimed.delete(e.pointerId);             // belt and braces; the
        };                                               // member seam unclaims too
        canvas.addEventListener('pointerdown',   this._onDown);
        canvas.addEventListener('pointermove',   this._onMove);
        canvas.addEventListener('pointerup',     this._onUp);
        canvas.addEventListener('pointercancel', this._onUp);
      }

      for (const h of handles) this.add(h);
    }

    /**
     * Route a handle: its own pointerdown adoption is disabled and the router's
     * shared pick grabs it via `_adopt`. Move/solve/release stay the handle's
     * own. Chainable.
     * @param {Handle} h
     * @returns {PointerRouter} this
     */
    add(h) {
      if (!h || typeof h._renderProxy !== 'function') {
        console.error('[p5.tree] router.add: not a handle — ignoring.');
        return this;
      }
      if (this._handles.includes(h)) return this;
      h._routed = true;
      // Lib-space seams: unclaim the pointer when the member releases or
      // cancels. (The router owns these seams for its members — documented.)
      h._onRelease = h._onCancel = () => this._unclaim(h);
      this._handles.push(h);
      return this;
    }

    /**
     * Un-route a handle (it self-picks again). Chainable.
     * @param {Handle} h
     * @returns {PointerRouter} this
     */
    remove(h) {
      const i = this._handles.indexOf(h);
      if (i < 0) return this;
      this._handles.splice(i, 1);
      this._unclaim(h);
      h._routed = false;
      h._onRelease = h._onCancel = null;
      if (this._hoveredH === h) { this._hoveredH = null; h._hovered = false; }
      return this;
    }

    /**
     * Resolve queued presses with ONE shared pick each, refresh hover with one
     * more when the pointer moved, then delegate to every member's `update()`.
     * Call FIRST in `draw()`, in place of the members' own updates:
     *
     *   if (!router.update()) orbitControl()
     *
     * @returns {boolean} true if any member is grabbed.
     */
    update() {
      const hs = this._handles;

      // Presses — every queued down resolves (several same-frame presses on
      // different members all land).
      while (this._downs.length) {
        const d = this._downs.shift();
        if (this._claimed.has(d.pid)) continue;
        const win = this._sharedPick(d.x, d.y);
        if (win && win._pid === null && win.enabled) {
          this._claimed.set(d.pid, win);
          win._adopt(d.pid, d.x, d.y);
        }
      }

      // Hover — one shared pick per frame with (unclaimed) pointer motion.
      if (this._hover && this._hoverMoved) {
        this._hoverMoved = false;
        const win = this._sharedPick(this._hxy[0], this._hxy[1]);
        this._hoveredH = win;
        for (const h of hs) h._hovered = (h === win) || h._grabbed;
      }

      let g = false;
      for (const h of hs) g = h.update() || g;
      return g;
    }

    // One pass: prep every enabled member against the live projection, render
    // all proxies tagged id = index + 1 into the pick buffer (depth resolves
    // overlap — the nearest proxy wins), decode the winner.
    _sharedPick(x, y) {
      const hs = this._handles;
      if (!hs.length) return null;
      for (const h of hs) { if (h.enabled) h._proxyPrep(); }
      const id = this._p.colorPick(x, y, () => {
        for (let i = 0; i < hs.length; i++) {
          if (hs[i].enabled) hs[i]._renderProxy(i + 1);
        }
      });
      return (id >= 1 && id <= hs.length) ? hs[id - 1] : null;
    }

    _unclaim(h) {
      for (const [pid, hh] of this._claimed) {
        if (hh === h) this._claimed.delete(pid);
      }
    }

    /**
     * The member currently under the pointer, or null. Grabbed members read
     * hovered via their own `hovered()`.
     * @returns {Handle|null}
     */
    hovered() { return this._hoveredH; }

    /** Remove listeners, un-route every member, and unregister. */
    dispose() {
      const c = this._canvas;
      if (c) {
        c.removeEventListener('pointerdown',   this._onDown);
        c.removeEventListener('pointermove',   this._onMove);
        c.removeEventListener('pointerup',     this._onUp);
        c.removeEventListener('pointercancel', this._onUp);
      }
      this._canvas = null;
      for (const h of [...this._handles]) this.remove(h);
      this._claimed.clear();
      _unregister(this._p, this);
    }
  }

  // ── Factories ───────────────────────────────────────────────────────────

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
   *   bind?:      p5.Vector | { get: Function, set: Function },
   *   drawLocus?: Function,
   *   pickProxy?: Function,
   *   onGrab?:    Function,
   *   onChange?:  Function,
   *   onRelease?: Function,
   *   onCancel?:  Function,
   * }} opts
   * @returns {Handle|null} The controller, or null on an invalid constraint.
   */
  fn.createHandle = function (opts = {}) {
    const kind = opts.constraint;
    const ok = kind === SPHERE || kind === PLANE || kind === AXIS ||
               kind === DIAL  || kind === p5.Tree.VIEW || _isConstraint(kind);
    if (!ok) {
      console.error('[p5.tree] createHandle: `constraint` must be SPHERE, PLANE, AXIS, DIAL, VIEW, or a contract-conforming constraint object; got ' + String(kind) + '.');
      return null;
    }
    const h = new Handle(this, opts);
    _register(this, h);
    return h;
  };

  /**
   * Create a pointer router over a set of (potentially overlapping) handles —
   * one shared depth-resolved pick, an id→handle map, a claimed-pointer set,
   * and shared hover. Options last:
   *
   * ```js
   * const r = createPointerRouter(hx, hy, hz, dial)            // hover on
   * const r = createPointerRouter(hx, hy, hz, { hover: false })
   * // draw(): if (!r.update()) orbitControl(); hs.forEach(h => h.draw())
   * ```
   *
   * @method createPointerRouter
   * @for p5
   * @param {...(Handle | { hover?: boolean })} args  Handles, then an optional
   *        options object last.
   * @returns {PointerRouter}
   */
  fn.createPointerRouter = function (...args) {
    let opts = {};
    if (args.length && args[args.length - 1] &&
        typeof args[args.length - 1] === 'object' &&
        typeof args[args.length - 1]._renderProxy !== 'function') {
      opts = args.pop();
    }
    const r = new PointerRouter(this, args, opts);
    _register(this, r);
    return r;
  };
}
