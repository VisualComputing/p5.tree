/**
 * @file PoseTrack / CameraTrack bridge: player registry, camera pose helpers.
 * @module p5.tree/track
 * @license AGPL-3.0-only
 *
 * ### What lives here
 *
 *  ```
 *  Players — the host's registry (host.players), reached through
 *    registerPlayer / unregisterPlayer / tickPlayers / clearPlayers
 *
 *  fn.getCamera          Return the current p5 camera (curCamera).
 *  fn.createPoseTrack([opts])          PoseTrack wired to the draw loop.
 *  fn.createCameraTrack([cam][, opts]) CameraTrack wired + auto-apply; defaults to current camera.
 *
 *  TrackHandles          Per-keyframe manipulators — the factories' `handles`
 *                        opt, stored at track.handles.
 *
 *  p5.Renderer3D.rotateQuat   rotate by [x,y,z,w] quaternion
 *  p5.Renderer3D.applyPose    apply TRS { pos, rot, scl } to the transform stack
 *  fn.rotateQuat / fn.applyPose   forwarders to the renderer
 *
 *  p5.Camera.capturePose  the core's cameraFromMat4 over the camera's eye and projection
 *                         matrices → { eye, center, up, fov, halfHeight, near, far }
 *  p5.Camera.applyPose    write { eye, center, up, fov, halfHeight, near, far } → cam.camera() + projection;
 *                         a TRS { pos, rot } lands through the core's cameraFromPose
 *  ```
 *
 * ### { camera } spec support
 *  CameraTrack.add() returned by createCameraTrack() accepts a { camera } spec:
 *
 *    ```
 *    track.add({ camera: cam })        — capture live pose from a p5.Camera
 *    track.add({ camera: getCamera() })
 *    ```
 *
 *  Interception is in the bridge (here), not in deps/tree — eyeX/centerX/upX
 *  are p5-specific property names; the numeric core stays renderer-agnostic.
 */

'use strict';

import {
  PoseTrack, CameraTrack, qFromAxisAngle,
  createCamera, cameraFromMat4, cameraFromPose,
} from '@nakednous/tree';
import { getNdcZ, ensureHost, hostOf } from './matrix.js';

// Camera-state scratch for the p5.Camera seams: applyPose's TRS branch
// decomposes into _cam, capturePose reads the eye matrix through _E. Both
// are seeded from the camera's own lookat first, so the core's decomposers
// keep its gaze distance.
const _cam = createCamera();
const _E   = new Float32Array(16);

// ═══════════════════════════════════════════════════════════════════════════════
// Players — the host's registry
// ═══════════════════════════════════════════════════════════════════════════════

// Frame dt in seconds, clamped to 50 ms so a stalled tab cannot teleport a
// player on the catch-up frame.
const _dtOf = (pInst) => Math.min((pInst.deltaTime || 16) / 1000, 0.05);

// Register a player with the p5 instance's host: `player.tick(dt)` runs each
// predraw and the player is removed when it returns false.
export function registerPlayer(pInst, player) {
  const h = pInst && player ? ensureHost(pInst) : null;
  if (h) h.players.add(player);
}

// Unregister a player.
export function unregisterPlayer(pInst, player) {
  const h = hostOf(pInst);
  if (h && player) h.players.remove(player);
}

// Tick the host's players with the frame's dt. Called from the predraw lifecycle.
export function tickPlayers(pInst) {
  const h = hostOf(pInst);
  if (h) h.tick(_dtOf(pInst));
}

// Remove all players. Called from the remove lifecycle.
export function clearPlayers(pInst) {
  const h = hostOf(pInst);
  if (h) h.players.clear();
}

// ── Shared player wiring for PoseTrack ───────────────────────────────────────

function _wirePoseTrack(track, pInst) {
  let player = null;
  track._onActivate   = () => {
    player = player || { tick() { track.tick(); return track.playing; } };
    registerPlayer(pInst, player);
  };
  track._onDeactivate = () => unregisterPlayer(pInst, player);
}

// ── { camera } spec → { eye, center, up } conversion (bridge-side only) ──────
//
// Duck-types on p5.Camera lookat properties: eyeX/Y/Z, centerX/Y/Z, upX/Y/Z.
// Returns null when the object doesn't look like a lookat camera.

function _cameraToSpec(cam) {
  if (!cam || typeof cam !== 'object') return null;
  if (cam.eyeX === undefined || cam.centerX === undefined) return null;
  const ux = cam.upX !== undefined ? cam.upX : 0;
  const uy = cam.upY !== undefined ? cam.upY : 1;
  const uz = cam.upZ !== undefined ? cam.upZ : 0;
  return {
    eye:    [cam.eyeX,    cam.eyeY,    cam.eyeZ],
    center: [cam.centerX, cam.centerY, cam.centerZ],
    up:     [ux, uy, uz],
  };
}

/**
 * Wrap CameraTrack.add() to intercept { camera } specs and the no-arg form.
 *
 * Accepts all forms the core supports, plus:
 *   (no args)    — capture the track's bound camera (track.camera); no-op if unset
 *   { camera }   — duck-typed lookat object (p5.Camera or compatible);
 *                  reads eyeX/Y/Z, centerX/Y/Z, upX/Y/Z
 *
 * Arrays are processed element-by-element so { camera } entries inside
 * bulk adds are also resolved.
 *
 * Equivalent forms for a track returned by createCameraTrack(cam):
 *   track.add()
 *   track.add({ camera: cam })
 *   track.add({ camera: getCamera() })
 *   track.add(cam.capturePose())   // zero-alloc, prefer in hot paths
 *
 * @param {CameraTrack} track
 */
function _patchCameraTrackAdd(track) {
  const _coreAdd = track.add.bind(track);
  track.add = function (spec, opts) {
    // No-arg shortcut — capture the bound camera if available.
    if (spec == null) {
      if (!track.camera) return;
      spec = { camera: track.camera };
    }
    // Bulk array — recurse so { camera } entries are resolved per-element.
    if (Array.isArray(spec)) {
      for (const s of spec) track.add(s, opts);
      return;
    }
    // { camera } — prefer capturePose() so fov/halfHeight/near/far are included;
    // fall back to _cameraToSpec for non-p5 duck-typed cameras.
    if (spec.camera != null) {
      const converted = typeof spec.camera.capturePose === 'function'
        ? spec.camera.capturePose()
        : _cameraToSpec(spec.camera);
      if (converted) { _coreAdd(converted, opts); return; }
    }
    _coreAdd(spec, opts);
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TrackHandles — per-keyframe manipulators (the factories' `handles` opt)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Bridge-only decoration stored at `track.handles`. The numeric core is
// untouched: its samplers read `keyframes` live with zero caching, so an
// in-place keyframe write reflows the path, the auto-CR tangents, eval(),
// and viewFrustum on the very next call — no invalidation machinery.
//
// Composition — one VIEW handle per draggable keyframe field (screen-
// parallel drag plane through the point; the object follows the pointer at
// its own depth), bound in place via the accessor-floor bind:
//
//   PoseTrack    kf.pos                        always
//                kf.rot   (one DIAL, opt-in)   opts.rot = axis
//   CameraTrack  kf.eye                        always
//                kf.center                     opts.center (default true)
//
// A camera keyframe's orientation IS its center (lookat), so the center dot
// is the camera orientation editor — no rotation widget. The PoseTrack rot
// DIAL edits the twist about the declared axis: θ → qFromAxisAngle → kf.rot,
// REPLACING the quaternion (a general rotation is twist-projected on sync
// and overwritten on drag — the common authoring case is rotations about one
// axis, which round-trips exactly).
//
// All members share one PointerRouter (depth-resolved pick, shared hover,
// per-finger multitouch). Members are internal: their user hooks are owned
// by the controller, which re-exposes them with keyframe coordinates —
// onGrab(index, field, h) / onChange(value, index, field, h) / onRelease /
// onCancel, field ∈ 'pos' | 'eye' | 'center' | 'rot'.
//
// update() ordering contract (inherited from Handle): host-driven, never a
// predraw hook — pick and solve must run against the OBSERVER camera, after
// setCamera(viewCam) and before orbitControl(); in a two-camera sketch only
// the host knows that moment.
//
//   setCamera(viewCam)
//   if (!track.handles.update()) orbitControl()
//   ...
//   trackPath(track, { bits: p5.Tree.HANDLES })   // the drawing seam
//
// Lifecycle: update() rebuilds the member set when keyframes.length changes
// (the transport panel's `+` and core remove() just work) and idle-syncs
// every ungrabbed member from its keyframe each frame (VIEW's seed is a
// direct set), so external edits never desync a dot. A dragged pos forwards
// its keyframe's position into that keyframe's rot DIAL anchor immediately
// (onChange), so the ring never trails the dot mid-drag.

/**
 * Local factory — construction happens only through the track factories'
 * `handles` opt; never installed on p5.
 *
 * @param {p5constructor} p5     The p5 constructor (for p5.Tree constants).
 * @param {p5}      pInst        The sketch instance (createHandle / router).
 * @param {Object}  track        PoseTrack | CameraTrack (core instance).
 * @param {true|Object} opts     `true` for all defaults, or
 *   { center?, rot?, rotRadius?, rotSnap?, grabPx?, snap?, hover? }.
 * @param {boolean} isCamera     CameraTrack (eye/center) vs PoseTrack (pos/rot).
 * @returns {TrackHandles}
 */
function createTrackHandles(p5, pInst, track, opts, isCamera) {
  return new TrackHandles(p5, pInst, track, opts === true ? {} : (opts || {}), isCamera);
}

class TrackHandles {
  constructor(p5, pInst, track, opts, isCamera) {
    this._p5       = p5;
    this._p        = pInst;
    this._track    = track;
    this._isCamera = !!isCamera;

    // Members: { h, index, field } — rebuilt whenever keyframes.length moves.
    this._members    = [];
    this._rotByIndex = new Map();
    this._n          = -1;          // force build on first update()
    this._enabled    = true;

    /** Last-grabbed keyframe index (null until a grab). @type {number|null} */
    this.selected = null;

    // ── Options ──────────────────────────────────────────────────────
    this._grabPx  = Number.isFinite(opts.grabPx) ? opts.grabPx : 12;
    this._snap    = opts.snap    ?? null;   // world grid — position handles
    this._rotSnap = opts.rotSnap ?? null;   // angular step (rad) — rot DIAL

    // center — CameraTrack only (default ON: it is the orientation editor).
    this._center = this._isCamera ? (opts.center !== false) : false;
    if (!this._isCamera && opts.center !== undefined) {
      console.error('[p5.tree] track handles: `center` is CameraTrack-only — ignoring.');
    }

    // rot — PoseTrack only: one DIAL per keyframe about a world axis.
    this._rotAxis   = null;
    this._rotRadius = Number.isFinite(opts.rotRadius) ? opts.rotRadius : 40;
    if (opts.rot != null) {
      if (this._isCamera) {
        console.error('[p5.tree] track handles: `rot` is PoseTrack-only — a camera keyframe\'s orientation is its center; drag that instead. Ignoring.');
      } else {
        const a  = opts.rot;
        const ax = a.x ?? a[0] ?? 0, ay = a.y ?? a[1] ?? 1, az = a.z ?? a[2] ?? 0;
        const l  = Math.hypot(ax, ay, az) || 1;
        this._rotAxis = [ax / l, ay / l, az / l];
      }
    }

    // User hooks — keyframe-coordinate re-exposure of the member hooks.
    this.onGrab    = null;   // (index, field, h)
    this.onChange  = null;   // (value, index, field, h)
    this.onRelease = null;   // (index, field, h)
    this.onCancel  = null;   // (index, field, h)

    // One router for all members: shared depth-resolved pick + hover.
    this._router = pInst.createPointerRouter({ hover: opts.hover !== false });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Rebuild-if-needed, idle-sync, then route. Call FIRST in draw(), after
   * setCamera of the observer camera and before orbitControl():
   *
   * ```js
   * if (!track.handles.update()) orbitControl()
   * ```
   *
   * @function update
   * @memberof TrackHandles
   * @returns {boolean} true while any keyframe handle is grabbed.
   * @example
   * <caption>The orbit gate: a press on a dot grabs it, one that misses orbits</caption>
   * let track
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   track = createPoseTrack({ handles: true })
   *   track.add({ pos: [-120, 60, 0] })
   *   track.add({ pos: [0, -60, 80] })
   *   track.add({ pos: [120, 60, 0] })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   if (!track.handles.update()) orbitControl()
   *   axes()
   *   stroke('white')
   *   trackPath(track, { marker: null })
   *   fill('#ff4fd8')
   *   trackPath(track, { bits: p5.Tree.HANDLES, marker: null })
   * }
   */
  update() {
    if (this._track.keyframes.length !== this._n) this._rebuild();
    if (this._enabled) this._syncIdle();
    return this._router.update();
  }

  /** Runtime gate — false suspends grab/solve/draw and empties the pick. */
  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    for (const m of this._members) m.h.enabled = this._enabled;
  }

  /**
   * @function grabbed
   * @memberof TrackHandles
   * @returns {boolean} true while any member is grabbed.
   * @example
   * <caption>The path turns magenta while any keyframe is held</caption>
   * let track
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   track = createPoseTrack({ handles: true })
   *   track.add({ pos: [-120, 60, 0] })
   *   track.add({ pos: [0, -60, 80] })
   *   track.add({ pos: [120, 60, 0] })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   if (!track.handles.update()) orbitControl()
   *   axes()
   *   stroke(track.handles.grabbed() ? '#ff4fd8' : 'white')
   *   trackPath(track, { marker: null })
   *   fill('white')
   *   trackPath(track, { bits: p5.Tree.HANDLES, marker: null })
   * }
   */
  grabbed() {
    for (const m of this._members) if (m.h.grabbed()) return true;
    return false;
  }

  /**
   * @function hovered
   * @memberof TrackHandles
   * @returns {number|null} keyframe index under the pointer (or grabbed).
   * @example
   * <caption>A bulls-eye on the keyframe under the pointer</caption>
   * let track
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   track = createPoseTrack({ handles: true })
   *   track.add({ pos: [-120, 60, 0] })
   *   track.add({ pos: [0, -60, 80] })
   *   track.add({ pos: [120, 60, 0] })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   if (!track.handles.update()) orbitControl()
   *   axes()
   *   stroke('white')
   *   trackPath(track, { marker: null })
   *   fill('#ff4fd8')
   *   trackPath(track, { bits: p5.Tree.HANDLES, marker: null })
   *   const i = track.handles.hovered()
   *   if (i != null) {
   *     const p = track.keyframes[i].pos
   *     push()
   *     translate(p[0], p[1], p[2])
   *     stroke('#ffd166')
   *     bullsEye({ size: 40 })
   *     pop()
   *   }
   * }
   */
  hovered() {
    for (const m of this._members) if (m.h.hovered()) return m.index;
    return null;
  }

  /**
   * Re-seed every idle member from its keyframe. update() already does this
   * each frame; call directly only between update() and a same-frame read.
   * Chainable.
   * @function sync
   * @memberof TrackHandles
   * @returns {TrackHandles} this
   * @example
   * <caption>An edit after update() in the same frame: sync() re-seeds the dot before it draws</caption>
   * let track
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   track = createPoseTrack({ handles: true })
   *   track.add({ pos: [-120, 60, 0] })
   *   track.add({ pos: [0, -60, 80] })
   *   track.add({ pos: [120, 60, 0] })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   if (!track.handles.update()) orbitControl()
   *   // keyframe 1 bobs under script control
   *   track.keyframes[1].pos[1] = -60 + 30 * sin(frameCount * 0.05)
   *   track.handles.sync()
   *   axes()
   *   stroke('white')
   *   trackPath(track, { marker: null })
   *   fill('#ff4fd8')
   *   trackPath(track, { bits: p5.Tree.HANDLES, marker: null })
   * }
   */
  sync() { this._syncIdle(); return this; }

  /**
   * Dispose members + router and detach from the track.
   * @function dispose
   * @memberof TrackHandles
   * @example
   * <caption>Any key disposes the handles: the dots go and the orbit is unconditional</caption>
   * let track
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   track = createPoseTrack({ handles: true })
   *   track.add({ pos: [-120, 60, 0] })
   *   track.add({ pos: [0, -60, 80] })
   *   track.add({ pos: [120, 60, 0] })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   const grabbed = track.handles ? track.handles.update() : false
   *   if (!grabbed) orbitControl()
   *   axes()
   *   stroke('white')
   *   trackPath(track, { marker: null })
   *   fill('#ff4fd8')
   *   trackPath(track, { bits: p5.Tree.HANDLES, marker: null })   // a no-op once disposed
   * }
   *
   * function keyPressed() {
   *   if (track.handles) track.handles.dispose()
   * }
   */
  dispose() {
    this._teardownMembers();
    this._router.dispose();
    if (this._track.handles === this) this._track.handles = null;
  }

  // ── Draw (the trackPath HANDLES bit lands here) ─────────────────────

  /**
   * Render every member at the ambient p5 state: fill() colours the dots,
   * stroke() the rot ring/spoke. Hover/grab emphasis is geometric — the dot
   * grows by `emphasis` — so colour stays the sketch's, per the ambient
   * philosophy. Normally invoked by trackPath's HANDLES bit; callable
   * standalone. No-op while disabled. Chainable.
   *
   * @function draw
   * @memberof TrackHandles
   * @param {{ size?: number, emphasis?: number }} [opts]
   * @param {number} [opts.size=grabPx]  Base dot radius in px.
   * @param {number} [opts.emphasis=1.4]  Hover / grab scale factor.
   * @returns {TrackHandles} this
   * @example
   * <caption>Standalone draw with a larger dot and stronger hover emphasis</caption>
   * let track
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   track = createPoseTrack({ handles: true })
   *   track.add({ pos: [-120, 60, 0] })
   *   track.add({ pos: [0, -60, 80] })
   *   track.add({ pos: [120, 60, 0] })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   if (!track.handles.update()) orbitControl()
   *   axes()
   *   stroke('white')
   *   trackPath(track, { marker: null })
   *   fill('#ff4fd8')
   *   track.handles.draw({ size: 8, emphasis: 2 })
   * }
   */
  draw(opts = {}) {
    if (!this._enabled) return this;
    const T    = this._p5.Tree;
    const base = Number.isFinite(opts.size)     ? opts.size     : this._grabPx;
    const emph = Number.isFinite(opts.emphasis) ? opts.emphasis : 1.4;
    for (const m of this._members) {
      const hot  = m.h.hovered() || m.h.grabbed();
      const bits = m.field === 'rot' ? (T.HANDLE | T.AIM | T.LOCUS) : T.HANDLE;
      m.h.draw({ bits, size: base * (hot ? emph : 1) });
    }
    return this;
  }

  // ── Members ────────────────────────────────────────────────────────────────

  _rebuild() {
    this._teardownMembers();
    const n = this._track.keyframes.length;
    this._n = n;
    for (let i = 0; i < n; i++) {
      this._addViewMember(i, this._isCamera ? 'eye' : 'pos');
      if (this._center)  this._addViewMember(i, 'center');
      if (this._rotAxis) this._addRotMember(i);
    }
    if (this.selected != null && this.selected >= n) this.selected = null;
  }

  _teardownMembers() {
    for (const m of this._members) {
      this._router.remove(m.h);
      m.h.dispose();
    }
    this._members.length = 0;
    this._rotByIndex.clear();
  }

  // A VIEW member: screen-parallel drag of kf[field], bound in place. The
  // binder resolves the keyframe BY INDEX at call time, so track.set(i, spec)
  // replacing the object never leaves a stale reference behind.
  _addViewMember(index, field) {
    const track = this._track;
    const h = this._p.createHandle({
      constraint: this._p5.Tree.VIEW,
      grabPx:     this._grabPx,
      snap:       this._snap,
      bind: {
        get: () => track.keyframes[index] ? track.keyframes[index][field] : null,
        set: (v) => {
          const k = track.keyframes[index];
          if (!k) return;
          const a = k[field];
          a[0] = v.x; a[1] = v.y; a[2] = v.z;
        },
      },
    });
    if (!h) return;
    this._wire(h, index, field);
    this._members.push({ h, index, field });
    this._router.add(h);
  }

  // A rot member: one DIAL about the declared world axis, anchored at the
  // keyframe's position. Unbound (DIAL reports θ, not a vec3) — the quat
  // write happens in the onChange wiring below.
  _addRotMember(index) {
    const kf = this._track.keyframes[index];
    const h  = this._p.createHandle({
      constraint: this._p5.Tree.DIAL,
      anchor:     [kf.pos[0], kf.pos[1], kf.pos[2]],
      axis:       this._rotAxis,
      radius:     this._rotRadius,
      grabPx:     this._grabPx,
      snap:       this._rotSnap,
    });
    if (!h) return;
    this._wire(h, index, 'rot');
    const m = { h, index, field: 'rot' };
    this._members.push(m);
    this._rotByIndex.set(index, m);
    this._router.add(h);
    this._syncRot(m);   // seed θ from the keyframe's current twist
  }

  _wire(h, index, field) {
    // Member user hooks are owned here (members are internal); the router
    // owns their lib-space _onRelease/_onCancel seams.
    h.onGrab = () => {
      this.selected = index;
      if (this.onGrab) this.onGrab(index, field, h);
    };
    h.onChange = (v) => {
      if (field === 'rot') {
        const k = this._track.keyframes[index];
        if (k) {
          const u = this._rotAxis;
          qFromAxisAngle(k.rot, u[0], u[1], u[2], h.scalar());
        }
      } else if (field === 'pos') {
        // Forward the dragged position into this keyframe's rot ring NOW —
        // idle sync would trail the dot by a frame.
        const rm = this._rotByIndex.get(index);
        if (rm) {
          const k = this._track.keyframes[index];
          if (k) rm.h.anchor(k.pos);
        }
      }
      if (this.onChange) this.onChange(v, index, field, h);
    };
    h.onRelease = () => { if (this.onRelease) this.onRelease(index, field, h); };
    h.onCancel = () => {
      // A VIEW cancel restores the keyframe through its binding; a DIAL is
      // unbound, so re-derive the quat from the reverted θ here.
      if (field === 'rot') {
        const k = this._track.keyframes[index];
        if (k) {
          const u = this._rotAxis;
          qFromAxisAngle(k.rot, u[0], u[1], u[2], h.scalar());
        }
      }
      if (this.onCancel) this.onCancel(index, field, h);
    };
  }

  // ── Sync ───────────────────────────────────────────────────────────────────

  _syncIdle() {
    for (const m of this._members) {
      if (m.h.grabbed()) continue;
      if (m.field === 'rot') this._syncRot(m);
      else m.h.sync();                 // VIEW: binder get → direct pt set
    }
  }

  // Anchor the ring at the live keyframe position and set θ to the twist of
  // kf.rot about the declared axis: θ = 2·atan2(q.xyz · u, q.w) — exact for
  // rotations about u, the swing-twist projection otherwise.
  _syncRot(m) {
    const k = this._track.keyframes[m.index];
    if (!k) return;
    m.h.anchor(k.pos);
    const u  = this._rotAxis;
    const th = 2 * Math.atan2(
      k.rot[0] * u[0] + k.rot[1] * u[1] + k.rot[2] * u[2],
      k.rot[3]);
    const c = m.h._constraint;         // lib-space: same package as handle.js
    if (c.s !== th) { c.s = th; c._dialPoint(); }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Install
// ═══════════════════════════════════════════════════════════════════════════════

export function installTrack(p5, fn) {

  p5.Tree.PoseTrack   = PoseTrack;
  p5.Tree.CameraTrack = CameraTrack;

  // ── fn.getCamera ───────────────────────────────────────────────────────────

  /**
   * Return the current p5 camera (curCamera).
   *
   * Returns null if called before createCanvas().
   *
   * @function getCamera
   * @memberof p5
   * @returns {p5.Camera|null}
   * @example
   * <caption>The current camera read back: its eye, live, as you orbit</caption>
   * async function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   textFont(await loadFont('fonts/noto_sans.ttf'))
   *   textSize(14)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   const cam = getCamera()
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   text('eye ' + [cam.eyeX, cam.eyeY, cam.eyeZ].map(v => v.toFixed(0)).join('  '), 10, 20)
   *   endHUD()
   * }
   */
  fn.getCamera = function () {
    return this._renderer?.states?.curCamera ?? null;
  };

  // ── fn.createPoseTrack ─────────────────────────────────────────────────────

  /**
   * Create a PoseTrack wired to the p5 draw loop.
   *
   * ```js
   * const track = createPoseTrack()
   * const out   = { pos:[0,0,0], rot:[0,0,0,1], scl:[1,1,1] }
   *
   * track.add({ pos:[0,0,0],   rot:[0,0,0,1], scl:[1,1,1] })
   * track.add({ pos:[200,0,0], rot:[0,0,0,1], scl:[1,1,1] })
   * track.play({ loop: true })
   *
   * // in draw():
   * if (track.playing) {
   *   push()
   *   applyPose(track.eval(out))
   *   box(60)
   *   pop()
   * }
   * ```
   *
   * Keyframe handles (opt-in): `{ handles: true }` (or an options object —
   * `{ rot?, rotRadius?, rotSnap?, grabPx?, snap?, hover? }`) decorates the
   * track with a `track.handles` controller — one screen-parallel drag dot
   * per keyframe position, plus an optional per-keyframe rotation DIAL about
   * a declared axis (`rot: [0,1,0]`). Drive it host-side and gate the orbit:
   *
   * ```js
   * const track = createPoseTrack({ handles: { rot: [0, 1, 0] } })
   * // draw():
   * if (!track.handles.update()) orbitControl()
   * trackPath(track, { bits: p5.Tree.HANDLES })
   * ```
   *
   * @function createPoseTrack
   * @memberof p5
   * @param {{ handles?: boolean|Object }} [opts]
   * @returns {PoseTrack}
   * @example
   * <caption>Position, rotation and scale keyframes; Hermite, slerp and linear by default</caption>
   * let track
   * const pose = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scl: [1, 1, 1] }
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   track = createPoseTrack()
   *   track.add({ pos: [-120, 60, 0], rot: { axis: [0, 1, 0], angle: 0 }, scl: [1, 1, 1] })
   *   track.add({ pos: [0, -60, 80], rot: { axis: [0, 1, 0], angle: PI / 2 }, scl: [1.5, 1.5, 1.5] })
   *   track.add({ pos: [120, 60, 0], rot: { axis: [0, 1, 0], angle: PI }, scl: [1, 1, 1] })
   *   track.play({ loop: true, bounce: true, duration: 60 })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   trackPath(track, { marker: null })
   *   push()
   *   applyPose(track.eval(pose))
   *   axes({ size: 40 })
   *   stroke('#ff4fd8')
   *   noFill()
   *   box(30)
   *   pop()
   * }
   * @example
   * <caption>Interpolation modes: linear position, stepped rotation</caption>
   * let track
   * const pose = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scl: [1, 1, 1] }
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   track = createPoseTrack()
   *   track.add({ pos: [-120, 60, 0], rot: { axis: [0, 1, 0], angle: 0 } })
   *   track.add({ pos: [0, -60, 80], rot: { axis: [0, 1, 0], angle: PI / 2 } })
   *   track.add({ pos: [120, 60, 0], rot: { axis: [0, 1, 0], angle: PI } })
   *   track.posInterp = 'linear'
   *   track.rotInterp = 'step'
   *   track.play({ loop: true, bounce: true, duration: 60 })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   trackPath(track)
   *   push()
   *   applyPose(track.eval(pose))
   *   stroke('#ff4fd8')
   *   noFill()
   *   box(30)
   *   pop()
   * }
   * @example
   * <caption>Keyframe handles: drag the dots, turn the rings about Y</caption>
   * let track
   * const pose = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scl: [1, 1, 1] }
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   track = createPoseTrack({ handles: { rot: [0, 1, 0] } })
   *   track.add({ pos: [-120, 60, 0] })
   *   track.add({ pos: [0, -60, 80] })
   *   track.add({ pos: [120, 60, 0] })
   *   track.play({ loop: true, bounce: true, duration: 60 })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   if (!track.handles.update()) orbitControl()   // a grab wins over orbit
   *   axes()
   *   stroke('white')
   *   trackPath(track, { marker: null })
   *   fill('#ff4fd8')
   *   trackPath(track, { bits: p5.Tree.HANDLES, marker: null })
   *   push()
   *   applyPose(track.eval(pose))
   *   stroke('#ffd166')
   *   noFill()
   *   box(30)
   *   pop()
   * }
   */
  fn.createPoseTrack = function (opts = {}) {
    const track = new PoseTrack();
    _wirePoseTrack(track, this);
    if (opts.handles) {
      track.handles = createTrackHandles(p5, this, track, opts.handles, false);
    }
    return track;
  };

  // ── fn.createCameraTrack ───────────────────────────────────────────────────

  /**
   * Create a CameraTrack bound to a p5.Camera.
   * Playback applies the interpolated lookat + projection automatically each frame.
   *
   * ```js
   * // implicit — binds to the default camera
   * const track = createCameraTrack()
   *
   * // explicit — same result
   * const track = createCameraTrack(getCamera())
   *
   * // dedicated camera
   * const cam   = createCamera()
   * const track = createCameraTrack(cam)
   * ```
   *
   * ```js
   * track.add({ eye:[0,0,500], center:[0,0,0] })
   * track.add({ eye:[300,-150,0], center:[0,0,0] })
   * track.add()                          // capture bound camera (track.camera)
   * track.add({ camera: cam })           // capture any p5.Camera
   * track.play({ loop: true })
   *
   * // in draw(): no guard needed — applyPose fires automatically in predraw
   * orbitControl()   // works freely when track is stopped
   * ```
   *
   * Interpolation modes:
   * ```js
   * track.eyeInterp    = 'hermite'   // 'hermite' | 'linear' | 'step'
   * track.centerInterp = 'linear'    // 'hermite' | 'linear' | 'step'
   * ```
   *
   * Keyframe handles (opt-in): `{ handles: true }` (or an options object —
   * `{ center?, grabPx?, snap?, hover? }`) decorates the track with a
   * `track.handles` controller — a screen-parallel drag dot per keyframe eye
   * AND per keyframe center (`center: false` opts out). The center dot IS
   * the orientation editor: a lookat keyframe's orientation is derived from
   * eye→center+up, so dragging the center re-aims the gaze and the marker.
   * Coincident centers (the common every-keyframe-targets-the-origin
   * authoring style) leave the first grab ambiguous until dragged apart.
   * Drive it host-side against the OBSERVER camera and gate the orbit:
   *
   * ```js
   * const track = createCameraTrack(animCam, { handles: true })
   * // draw():
   * setCamera(viewCam)
   * if (!track.handles.update()) orbitControl()
   * trackPath(track, { bits: p5.Tree.HANDLES })
   * ```
   *
   * @function createCameraTrack
   * @memberof p5
   * @param {p5.Camera} [cam]  Camera to drive. Defaults to the current camera.
   *                           Use createCamera() for a dedicated camera.
   * @param {{ handles?: boolean|Object }} [opts]
   * @returns {CameraTrack}
   * @example
   * <caption>Fly the default camera; any key stops and restarts, and the orbit is free while stopped</caption>
   * let track
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   track = createCameraTrack()
   *   track.add({ eye: [0, 0, 400], center: [0, 0, 0] })
   *   track.add({ eye: [300, -150, 0], center: [0, 0, 0] })
   *   track.add({ eye: [-200, 100, -300], center: [0, 0, 0] })
   *   track.add({ eye: [0, 0, 400], center: [0, 0, 0] })
   *   track.play({ loop: true, duration: 90 })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   push()
   *   rotateX(HALF_PI)
   *   grid({ size: 200, subdivisions: 10 })
   *   pop()
   *   noStroke()
   *   fill('#ff4fd8')
   *   box(60)
   *   fill('#ffd166')
   *   push()
   *   translate(120, -40, -80)
   *   sphere(30)
   *   pop()
   * }
   *
   * function keyPressed() {
   *   track.playing ? track.stop() : track.play({ loop: true, duration: 90 })
   * }
   * @example
   * <caption>A dedicated camera: the observer stays free and watches the flight</caption>
   * let cam, track
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   camera(300, -200, 500, 0, 0, 0, 0, 1, 0)
   *   cam = createCamera()
   *   track = createCameraTrack(cam)
   *   track.add({ eye: [250, -80, 0], center: [0, 0, 0], fov: PI / 4, near: 40, far: 300 })
   *   track.add({ eye: [0, -150, 250], center: [0, 0, 0], fov: PI / 4, near: 40, far: 300 })
   *   track.add({ eye: [-250, -80, 0], center: [0, 0, 0], fov: PI / 4, near: 40, far: 300 })
   *   track.play({ loop: true, bounce: true, duration: 90 })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   trackPath(track)
   *   stroke('#ffd166')
   *   viewFrustum({ camera: track })
   * }
   * @example
   * <caption>Author by capture: a adds the current camera as a keyframe, p plays, s stops</caption>
   * let track
   *
   * async function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   textFont(await loadFont('fonts/noto_sans.ttf'))
   *   textSize(14)
   *   track = createCameraTrack()
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   text('a add   p play   s stop   ' + track.keyframes.length + ' keyframe(s)', 10, 20)
   *   endHUD()
   * }
   *
   * function keyPressed() {
   *   if (key === 'a') track.add()   // captures the bound camera: eye, center, up, fov, near, far
   *   if (key === 'p') track.play({ loop: true, bounce: true, duration: 60 })
   *   if (key === 's') track.stop()
   * }
   * @example
   * <caption>Keyframe handles on a dedicated camera: drag eyes and centers, the frustum reflows</caption>
   * let cam, track
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   camera(300, -200, 500, 0, 0, 0, 0, 1, 0)
   *   cam = createCamera()
   *   track = createCameraTrack(cam, { handles: true })
   *   track.add({ eye: [250, -80, 0], center: [0, 0, -40], fov: PI / 4, near: 40, far: 300 })
   *   track.add({ eye: [0, -150, 250], center: [0, 0, 0], fov: PI / 4, near: 40, far: 300 })
   *   track.add({ eye: [-250, -80, 0], center: [0, 0, 40], fov: PI / 4, near: 40, far: 300 })
   *   track.play({ loop: true, bounce: true, duration: 90 })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   if (!track.handles.update()) orbitControl()   // picks against the observer camera
   *   axes()
   *   noFill()
   *   stroke('white')
   *   trackPath(track, { marker: null })
   *   stroke('#ff4fd8')
   *   trackPath(track, { bits: p5.Tree.CENTER, marker: null })
   *   fill('#ff4fd8')
   *   trackPath(track, { bits: p5.Tree.HANDLES, marker: null })
   *   stroke('#ffd166')
   *   viewFrustum({ camera: track })
   * }
   */
  fn.createCameraTrack = function (cam, opts = {}) {
    const pInst = this;
    // Options-only call — createCameraTrack({ handles: true }): a plain
    // object with no lookat surface is an opts bag, not a camera.
    if (cam && typeof cam === 'object' && !(cam instanceof p5.Camera) &&
        cam.eyeX === undefined) {
      opts = cam; cam = undefined;
    }
    cam = cam ?? this.getCamera() ?? null;
    const track  = new CameraTrack();
    const out    = {
      eye:[0,0,0], center:[0,0,0], up:[0,1,0],
      fov:null, halfHeight:null,
      near:0.1, far:1000,
    };

    track.camera = cam;
    _patchCameraTrackAdd(track);

    const applyPlayer = {
      tick() {
        if (!track.playing) return false;
        track.tick();
        if (cam) cam.applyPose(track.eval(out));
        return track.playing;
      }
    };

    track._onActivate   = () => registerPlayer(pInst, applyPlayer);
    track._onDeactivate = () => {
      unregisterPlayer(pInst, applyPlayer);
      if (cam && track.keyframes.length > 0) cam.applyPose(track.eval(out));
    };

    if (opts.handles) {
      track.handles = createTrackHandles(p5, pInst, track, opts.handles, true);
    }

    return track;
  };

  // ── p5.Renderer3D — TRS helpers ────────────────────────────────────────────

  /**
   * Rotate the current transform by a unit quaternion [x,y,z,w].
   * @function rotateQuat
   * @memberof p5
   * @param {Float32Array|ArrayLike} q  Unit quaternion [x,y,z,w].
   * @param {{ eps?:number }} [opts]
   * @param {number} [opts.eps=1e-8]  Below this sine of the half-angle the rotation is skipped.
   * @returns {p5} this
   * @example
   * <caption>Accumulate a quaternion each frame and apply it</caption>
   * const { qFromAxisAngle, qMul } = p5.Tree
   * const q = [0, 0, 0, 1], dq = [0, 0, 0, 1]
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   qFromAxisAngle(dq, 1, 1, 0, 0.02)
   *   qMul(q, dq, q)   // alias-safe, zero-alloc
   *   push()
   *   rotateQuat(q)
   *   axes({ size: 50 })
   *   stroke('#ff4fd8')
   *   noFill()
   *   box(40)
   *   pop()
   * }
   */
  p5.Renderer3D.prototype.rotateQuat = function (q, opts) {
    const p = this._pInst, eps = opts?.eps ?? 1e-8;
    const x=q[0], y=q[1], z=q[2];
    const sinHalf = Math.sqrt(x*x + y*y + z*z);
    if (sinHalf < eps) return this;
    const angle = 2 * Math.atan2(sinHalf, q[3]);
    p.rotate(angle, [x/sinHalf, y/sinHalf, z/sinHalf]);
    return this;
  };

  /**
   * Apply a TRS pose { pos, rot, scl } to the current transform stack.
   * @function applyPose
   * @memberof p5
   * @param {{ pos?:ArrayLike, rot?:ArrayLike, scl?:ArrayLike }} pose
   * @returns {p5} this
   * @example
   * <caption>A { pos, rot, scl } pose animated by hand and applied to the stack</caption>
   * const pose = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scl: [1, 1, 1] }
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   const t = frameCount * 0.02
   *   pose.pos[0] = 100 * sin(t)
   *   p5.Tree.qFromAxisAngle(pose.rot, 0, 1, 0, t)
   *   pose.scl[1] = 1 + 0.5 * sin(2 * t)
   *   push()
   *   applyPose(pose)
   *   axes({ size: 40 })
   *   stroke('#ff4fd8')
   *   noFill()
   *   box(40)
   *   pop()
   * }
   */
  p5.Renderer3D.prototype.applyPose = function (pose) {
    if (!pose) return this;
    const p = this._pInst;
    if (pose.pos) p.translate(pose.pos[0], pose.pos[1], pose.pos[2]);
    if (pose.rot) this.rotateQuat(pose.rot);
    if (pose.scl) p.scale(pose.scl[0], pose.scl[1], pose.scl[2]);
    return this;
  };

  // Sketch-level forwarders.
  fn.rotateQuat = function (q, opts) { this._renderer.rotateQuat(q, opts); return this; };
  fn.applyPose  = function (pose)    { this._renderer.applyPose(pose);     return this; };

  // ── p5.Camera — capturePose / applyPose ────────────────────────────────────

  /**
   * Read the camera into a { eye, center, up, fov, halfHeight, near, far }
   * state — the core's `cameraFromMat4` over the camera's own eye matrix
   * (the inverse of its `cameraMatrix`) and its `projMatrix`, populated by
   * `cam.perspective()`, `cam.ortho()`, or `cam.frustum()`. Nothing is read
   * from the renderer, so `otherCam.capturePose()` reports otherCam whether
   * or not it is live.
   *
   * - `eye`    ← the eye matrix's translation
   * - `center` ← eye + forward · d, with d the camera's own gaze distance
   *              |center − eye|, seeded from its lookat scalars before the read
   * - `up`     ← the eye matrix's up column (orthonormal; applies back to
   *              the same view)
   * - `fov` / `halfHeight` — vertical fov (radians) under perspective, the
   *   world-unit half-height under ortho; the other null
   * - `near`, `far` — clip plane distances (positive) under the renderer's
   *   NDC-z convention
   *
   * Before setup(), with no projection populated yet, the lookat comes from
   * the camera's scalars and the lens is null with near 0.1, far 1000.
   *
   * Pass a pre-allocated out to avoid allocation per frame:
   * ```js
   * const out = { eye:[0,0,0], center:[0,0,0], up:[0,1,0],
   *               fov:null, halfHeight:null, near:0.1, far:1000 }
   * track.add(cam.capturePose(out))
   * ```
   *
   * @function capturePose
   * @memberof p5.Camera
   * @param {{ eye:number[], center:number[], up:number[],
   *           fov:number|null, halfHeight:number|null,
   *           near:number, far:number }} [out]
   * @returns {{ eye:number[], center:number[], up:number[],
   *             fov:number|null, halfHeight:number|null,
   *             near:number, far:number }}
   * @example
   * <caption>A second camera captured into a preallocated out: drawn as a pose spec, and read out</caption>
   * let cam
   * const out = {
   *   eye: [0, 0, 0], center: [0, 0, 0], up: [0, 1, 0],
   *   fov: null, halfHeight: null, near: 0.1, far: 1000
   * }
   *
   * async function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   textFont(await loadFont('fonts/noto_sans.ttf'))
   *   textSize(14)
   *   camera(300, -200, 500, 0, 0, 0, 0, 1, 0)
   *   cam = createCamera()
   *   cam.perspective(PI / 4, width / height, 50, 350)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   const t = frameCount * 0.01
   *   cam.camera(250 * sin(t), -80, 250 * cos(t), 0, 0, 0, 0, 1, 0)
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   cam.capturePose(out)
   *   stroke('#ffd166')
   *   viewFrustum({ camera: out })   // the captured pose is a pose spec
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   text('fov ' + degrees(out.fov).toFixed(0) + '   near ' + out.near.toFixed(0) + '   far ' + out.far.toFixed(0), 10, 20)
   *   endHUD()
   * }
   */
  p5.Camera.prototype.capturePose = function (out) {
    out = out || createCamera();
    // Seed the lookat from the camera's scalars: the decomposer keeps this
    // gaze distance, so center lands where the camera looks.
    out.eye[0]    = this.eyeX;    out.eye[1]    = this.eyeY;    out.eye[2]    = this.eyeZ;
    out.center[0] = this.centerX; out.center[1] = this.centerY; out.center[2] = this.centerZ;
    const P = this.projMatrix?.mat4;
    const E = this.cameraMatrix ? this.mat4Eye(_E) : null;
    if (E && P) return cameraFromMat4(out, E, P, getNdcZ());
    // Pre-setup: no matrices yet — the scalar lookat and an unset lens.
    out.up[0] = this.upX ?? 0; out.up[1] = this.upY ?? 1; out.up[2] = this.upZ ?? 0;
    out.fov = null; out.halfHeight = null;
    out.near = 0.1; out.far = 1000;
    return out;
  };

  /**
   * Apply a { eye, center, up, fov?, halfHeight?, near?, far? } pose to this
   * camera. Calls cam.camera(eye, center, up) directly — no matrix
   * reconstruction, so a captured pose applies back to the same view.
   *
   * The projection is applied when fov or halfHeight is non-null:
   *
   * - `fov` set — `perspective(fov, aspect, near, far)`
   * - `halfHeight` set — `ortho(-hw*aspect, hw*aspect, -hw, hw, near, far)`
   *
   * `near` / `far` on the pose are used when present, falling back to
   * (0.1, 1000).
   *
   * Also accepts a { pos, rot, scl } TRS pose (a PoseTrack sample) for
   * object-on-camera effects — the core's cameraFromPose at the camera's
   * current gaze distance: eye ← pos, up and forward from rot; scl is ignored
   * and the lens untouched.
   *
   * @function applyPose
   * @memberof p5.Camera
   * @param {{ eye:number[], center:number[], up:number[],
   *           fov?:number|null, halfHeight?:number|null,
   *           near?:number, far?:number } |
   *          { pos:number[], rot:number[], scl?:number[] }} pose
   * @returns {p5.Camera} this
   * @example
   * <caption>A lookat pose written each frame to a second camera</caption>
   * let cam
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   camera(300, -200, 500, 0, 0, 0, 0, 1, 0)
   *   cam = createCamera()
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   const t = frameCount * 0.01
   *   cam.applyPose({
   *     eye: [250 * sin(t), -80, 250 * cos(t)], center: [0, 0, 0],
   *     fov: PI / 4, near: 50, far: 350
   *   })
   *   stroke('#ffd166')
   *   viewFrustum({ camera: cam })
   * }
   * @example
   * <caption>The TRS form: a PoseTrack sample drives the camera like an object</caption>
   * let cam, track
   * const pose = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scl: [1, 1, 1] }
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   camera(300, -200, 500, 0, 0, 0, 0, 1, 0)
   *   cam = createCamera()
   *   cam.perspective(PI / 4, width / height, 40, 300)
   *   track = createPoseTrack()
   *   track.add({ pos: [250, -80, 0], rot: { dir: [-250, 80, 0] } })
   *   track.add({ pos: [0, -150, 250], rot: { dir: [0, 150, -250] } })
   *   track.add({ pos: [-250, -80, 0], rot: { dir: [250, 80, 0] } })
   *   track.play({ loop: true, bounce: true, duration: 90 })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   trackPath(track, { marker: null })
   *   cam.applyPose(track.eval(pose))   // translate + rotate; scl is ignored
   *   stroke('#ffd166')
   *   viewFrustum({ camera: cam })
   * }
   */
  p5.Camera.prototype.applyPose = function (pose) {
    if (!pose) return this;

    // { eye, center, up } — native CameraTrack output
    if (pose.eye && pose.center) {
      const up = pose.up || [0,1,0];
      this.camera(
        pose.eye[0],    pose.eye[1],    pose.eye[2],
        pose.center[0], pose.center[1], pose.center[2],
        up[0],          up[1],          up[2]
      );
      const near = pose.near ?? 0.1;
      const far  = pose.far  ?? 1000;
      if (pose.fov != null) {
        const aspect = (this._renderer.width / this._renderer.height) || 1;
        this.perspective(pose.fov, aspect, near, far);
      } else if (pose.halfHeight != null) {
        const aspect = (this._renderer.width / this._renderer.height) || 1;
        const hw = pose.halfHeight;
        this.ortho(-hw * aspect, hw * aspect, -hw, hw, near, far);
      }
      return this;
    }

    // { pos, rot } — TRS form: animate the camera like an object (shake, bob).
    // Seed the gaze distance from the camera, then let the core place the lookat.
    if (pose.pos && pose.rot) {
      _cam.eye[0]    = this.eyeX;    _cam.eye[1]    = this.eyeY;    _cam.eye[2]    = this.eyeZ;
      _cam.center[0] = this.centerX; _cam.center[1] = this.centerY; _cam.center[2] = this.centerZ;
      cameraFromPose(_cam, pose);
      this.camera(
        _cam.eye[0],    _cam.eye[1],    _cam.eye[2],
        _cam.center[0], _cam.center[1], _cam.center[2],
        _cam.up[0],     _cam.up[1],     _cam.up[2]
      );
    }
    return this;
  };
}
