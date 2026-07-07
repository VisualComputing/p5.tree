/**
 * @file PoseTrack / CameraTrack bridge: player registry, camera pose helpers.
 * @module p5.tree/track
 * @license AGPL-3.0-only
 *
 * ── What lives here ──────────────────────────────────────────────────────────
 *  Player registry
 *    registerPlayer / unregisterPlayer / tickPlayers / clearPlayers
 *
 *  fn.getCamera          Return the current p5 camera (curCamera).
 *  fn.createPoseTrack([opts])          PoseTrack wired to the draw loop.
 *  fn.createCameraTrack([cam][, opts]) CameraTrack wired + auto-apply; defaults to current camera.
 *
 *  TrackHandles          Per-keyframe manipulators — the factories' `handles`
 *                        opt, stored at track.handles. Section below; full
 *                        spec: track-handles-design.md (tree repo root).
 *
 *  p5.Renderer3D.rotateQuat   rotate by [x,y,z,w] quaternion
 *  p5.Renderer3D.applyPose    apply TRS { pos, rot, scl } to the transform stack
 *  fn.rotateQuat / fn.applyPose   forwarders to the renderer
 *
 *  p5.Camera.capturePose  read live camera → { eye, center, up, fov, halfHeight, near, far }
 *  p5.Camera.applyPose    write { eye, center, up, fov, halfHeight, near, far } → cam.camera() + projection
 *
 * ── { camera } spec support ───────────────────────────────────────────────────
 *  CameraTrack.add() returned by createCameraTrack() accepts a { camera } spec:
 *    track.add({ camera: cam })        — capture live pose from a p5.Camera
 *    track.add({ camera: getCamera() })
 *  Interception is in the bridge (here), not in deps/tree — eyeX/centerX/upX
 *  are p5-specific property names; the numeric core stays renderer-agnostic.
 */

'use strict';

import {
  PoseTrack, CameraTrack, qToMat4, qFromAxisAngle,
  projFov, projTop, projIsOrtho,
  projNear, projFar,
} from '@nakednous/tree';
import { getNdcZ } from './matrix.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Player registry
// ═══════════════════════════════════════════════════════════════════════════════

const PATH_PLAYERS = new WeakMap();

function _getPlayers(pInst) {
  let p = PATH_PLAYERS.get(pInst);
  if (!p) { p = new Set(); PATH_PLAYERS.set(pInst, p); }
  return p;
}

/**
 * Register a player with a p5 instance.
 * `player.tick()` is called each predraw; removed when it returns false.
 * @param {p5} pInst
 * @param {{ tick: () => boolean }} player
 */
export function registerPlayer(pInst, player) {
  if (pInst && player) _getPlayers(pInst).add(player);
}

/**
 * Unregister a player from a p5 instance.
 * @param {p5} pInst
 * @param {{ tick: () => boolean }} player
 */
export function unregisterPlayer(pInst, player) {
  if (pInst && player) _getPlayers(pInst).delete(player);
}

/**
 * Tick all registered players. Called from the predraw lifecycle.
 * @param {p5} pInst
 */
export function tickPlayers(pInst) {
  const players = PATH_PLAYERS.get(pInst);
  if (!players) return;
  for (const p of [...players]) {
    if (!p.tick()) players.delete(p);
  }
}

/**
 * Remove all players. Called from the remove lifecycle.
 * @param {p5} pInst
 */
export function clearPlayers(pInst) {
  const players = PATH_PLAYERS.get(pInst);
  if (players) players.clear();
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
// Full spec: track-handles-design.md (tree repo root).
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
   *   if (!track.handles.update()) orbitControl()
   *
   * @returns {boolean} true while any keyframe handle is grabbed.
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

  /** @returns {boolean} true while any member is grabbed. */
  grabbed() {
    for (const m of this._members) if (m.h.grabbed()) return true;
    return false;
  }

  /** @returns {number|null} keyframe index under the pointer (or grabbed). */
  hovered() {
    for (const m of this._members) if (m.h.hovered()) return m.index;
    return null;
  }

  /**
   * Re-seed every idle member from its keyframe. update() already does this
   * each frame; call directly only between update() and a same-frame read.
   * Chainable.
   * @returns {TrackHandles} this
   */
  sync() { this._syncIdle(); return this; }

  /** Dispose members + router and detach from the track. */
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
   * @param {{ size?: number, emphasis?: number }} [opts]
   *        size — base dot radius in px (default grabPx);
   *        emphasis — hover/grab scale factor (default 1.4).
   * @returns {TrackHandles} this
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
   * @method getCamera
   * @memberof p5
   * @returns {p5.Camera|null}
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
   * See track-handles-design.md (tree repo).
   *
   * @method createPoseTrack
   * @memberof p5
   * @param {{ handles?: boolean|Object }} [opts]
   * @returns {PoseTrack}
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
   * See track-handles-design.md (tree repo).
   *
   * @method createCameraTrack
   * @memberof p5
   * @param {p5.Camera} [cam]  Camera to drive. Defaults to the current camera.
   *                           Use createCamera() for a dedicated camera.
   * @param {{ handles?: boolean|Object }} [opts]
   * @returns {CameraTrack}
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
   * Rotate by a unit quaternion [x,y,z,w].
   * @method rotateQuat
   * @memberof p5.Renderer3D
   * @param {Float32Array|ArrayLike} q  Unit quaternion [x,y,z,w].
   * @param {{ eps?:number }} [opts]
   * @returns {p5.Renderer3D} this
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
   * @method applyPose
   * @memberof p5.Renderer3D
   * @param {{ pos?:ArrayLike, rot?:ArrayLike, scl?:ArrayLike }} pose
   * @returns {p5.Renderer3D} this
   */
  p5.Renderer3D.prototype.applyPose = function (pose) {
    if (!pose) return this;
    const p = this._pInst;
    if (pose.pos) p.translate(pose.pos[0], pose.pos[1], pose.pos[2]);
    if (pose.rot) this.rotateQuat(pose.rot);
    if (pose.scl) p.scale(pose.scl[0], pose.scl[1], pose.scl[2]);
    return this;
  };

  /** @method rotateQuat @memberof p5 */
  fn.rotateQuat = function (q, opts) { this._renderer.rotateQuat(q, opts); return this; };
  /** @method applyPose @memberof p5 */
  fn.applyPose  = function (pose)    { this._renderer.applyPose(pose);     return this; };

  // ── p5.Camera — capturePose / applyPose ────────────────────────────────────

  /**
   * Read the live camera state into a { eye, center, up, fov, halfHeight,
   * near, far } object.
   *
   * - `eye`    ← [eyeX, eyeY, eyeZ]
   * - `center` ← [centerX, centerY, centerZ]
   * - `up`     ← [upX, upY, upZ]  (the hint p5 stores, not the orthogonalised up)
   *
   * Reads cam.upX/Y/Z directly — always the real hint, correct for both
   * upright cameras (up=[0,1,0]) and pole-flipped cameras (up=[0,-1,0]).
   *
   * Also captures the camera's projection (read from `this.projMatrix` —
   * the camera's own projection matrix, populated by `cam.perspective()`,
   * `cam.ortho()`, or `cam.frustum()`. Does NOT depend on the camera
   * being active on the renderer, so `otherCam.capturePose()` returns
   * otherCam's actual projection regardless of what's live):
   *   fov        — vertical fov (radians) for perspective cameras; null for ortho.
   *   halfHeight — world-unit half-height of ortho frustum; null for perspective.
   *   near, far  — clip plane distances (positive). Always real — extracted
   *                from the projection matrix regardless of projection type.
   *                Falls back to (0.1, 1000) when no projection matrix is
   *                populated (e.g. pre-setup()).
   *
   * Pass a pre-allocated out to avoid allocation per frame:
   * ```js
   * const out = { eye:[0,0,0], center:[0,0,0], up:[0,1,0],
   *               fov:null, halfHeight:null, near:0.1, far:1000 }
   * track.add(cam.capturePose(out))
   * ```
   *
   * @method capturePose
   * @memberof p5.Camera
   * @param {{ eye:number[], center:number[], up:number[],
   *           fov:number|null, halfHeight:number|null,
   *           near:number, far:number }} [out]
   * @returns {{ eye:number[], center:number[], up:number[],
   *             fov:number|null, halfHeight:number|null,
   *             near:number, far:number }}
   */
  p5.Camera.prototype.capturePose = function (out) {
    out = out || {
      eye:[0,0,0], center:[0,0,0], up:[0,1,0],
      fov:null, halfHeight:null,
      near:0.1, far:1000,
    };
    out.eye[0]    = this.eyeX;    out.eye[1]    = this.eyeY;    out.eye[2]    = this.eyeZ;
    out.center[0] = this.centerX; out.center[1] = this.centerY; out.center[2] = this.centerZ;
    out.up[0]     = this.upX !== undefined ? this.upX : 0;
    out.up[1]     = this.upY !== undefined ? this.upY : 1;
    out.up[2]     = this.upZ !== undefined ? this.upZ : 0;
    // Read the camera's own projection — not the renderer's live state.
    // this.projMatrix is populated by cam.perspective / ortho / frustum,
    // and by the default camera setup during createCamera().
    const pMat = this.projMatrix?.mat4;
    if (pMat) {
      const ndcZ = getNdcZ();
      if (projIsOrtho(pMat)) {
        out.fov        = null;
        out.halfHeight = projTop(pMat, ndcZ);
      } else {
        out.fov        = projFov(pMat);
        out.halfHeight = null;
      }
      out.near = projNear(pMat, ndcZ);
      out.far  = projFar(pMat);
    } else {
      out.fov = null; out.halfHeight = null;
      out.near = 0.1; out.far = 1000;
    }
    return out;
  };

  /**
   * Apply a { eye, center, up, fov?, halfHeight?, near?, far? } pose to this
   * camera. Calls cam.camera(eye, center, up) directly — no matrix
   * reconstruction, no up_ortho drift, exact roundtrip from capturePose().
   *
   * The projection is applied when fov or halfHeight is non-null:
   *   fov set        — perspective(fov, aspect, near, far)
   *   halfHeight set — ortho(-hw*aspect, hw*aspect, -hw, hw, near, far)
   *
   * `near` / `far` on the pose are used when present, falling back to
   * (0.1, 1000) for back-compat with hand-built poses that predate those
   * fields.
   *
   * Also handles legacy { pos, rot, scl } TRS poses from PoseTrack for
   * object-on-camera effects (translate/rotate only; scl is ignored).
   *
   * @method applyPose
   * @memberof p5.Camera
   * @param {{ eye:number[], center:number[], up:number[],
   *           fov?:number|null, halfHeight?:number|null,
   *           near?:number, far?:number } |
   *          { pos:number[], rot:number[], scl?:number[] }} pose
   * @returns {p5.Camera} this
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

    // { pos, rot } — TRS form (translates + rotates the view)
    // Useful for animating the camera like an object (shake, bob, etc.)
    if (pose.pos && pose.rot) {
      const rm = new Float32Array(16);
      qToMat4(rm, pose.rot);
      const upX=rm[4], upY=rm[5], upZ=rm[6];
      const fwdX=-rm[8], fwdY=-rm[9], fwdZ=-rm[10];
      const dx=this.centerX-this.eyeX, dy=this.centerY-this.eyeY, dz=this.centerZ-this.eyeZ;
      const dist = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
      this.camera(
        pose.pos[0], pose.pos[1], pose.pos[2],
        pose.pos[0]+fwdX*dist, pose.pos[1]+fwdY*dist, pose.pos[2]+fwdZ*dist,
        upX, upY, upZ
      );
    }
    return this;
  };
}
