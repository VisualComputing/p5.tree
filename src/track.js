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
 *  fn.createPoseTrack()        PoseTrack wired to the draw loop.
 *  fn.createCameraTrack([cam]) CameraTrack wired + auto-apply; defaults to current camera.
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
  PoseTrack, CameraTrack, qToMat4,
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
   * @method createPoseTrack
   * @memberof p5
   * @returns {PoseTrack}
   */
  fn.createPoseTrack = function () {
    const track = new PoseTrack();
    _wirePoseTrack(track, this);
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
   * @method createCameraTrack
   * @memberof p5
   * @param {p5.Camera} [cam]  Camera to drive. Defaults to the current camera.
   *                           Use createCamera() for a dedicated camera.
   * @returns {CameraTrack}
   */
  fn.createCameraTrack = function (cam) {
    const pInst = this;
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
