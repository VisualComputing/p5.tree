/**
 * @file PoseTrack / CameraTrack bridge: player registry, camera pose helpers.
 * @module p5.tree/track
 * @license GPL-3.0-only
 *
 * ── What lives here ──────────────────────────────────────────────────────────
 *  Player registry
 *    registerPlayer / unregisterPlayer / tickPlayers / clearPlayers
 *
 *  fn.getCamera          Return the current p5 camera (curCamera).
 *  fn.createTrack(cam?)  Unified factory:
 *                          cam is p5.Camera → CameraTrack wired + auto-apply
 *                          cam omitted/null → PoseTrack wired to the draw loop
 *
 *  p5.Renderer3D.rotateQuat   rotate by [x,y,z,w] quaternion
 *  p5.Renderer3D.applyPose    apply TRS { pos, rot, scl } to the transform stack
 *  fn.rotateQuat / fn.applyPose   forwarders to the renderer
 *
 *  p5.Camera.capturePose  read live camera → { eye, center, up }
 *  p5.Camera.applyPose    write { eye, center, up } → cam.camera()
 *
 * ── { camera } spec support ───────────────────────────────────────────────────
 *  CameraTrack.add() returned by createTrack() accepts a { camera } spec:
 *    track.add({ camera: cam })        — capture live pose from a p5.Camera
 *    track.add({ camera: getCamera() })
 *  Interception is in the bridge (here), not in deps/tree — eyeX/centerX/upX
 *  are p5-specific property names; the numeric core stays renderer-agnostic.
 */

'use strict';

import { PoseTrack, CameraTrack, qToMat4 } from '@nakednous/tree';

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
 * Equivalent forms for a track returned by createTrack(cam):
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
      if (track.camera) spec = { camera: track.camera };
      else return;
    }
    // Bulk array — recurse so { camera } entries are resolved per-element.
    if (Array.isArray(spec)) {
      for (const s of spec) track.add(s, opts);
      return;
    }
    // { camera } — convert to plain { eye, center, up } before forwarding.
    if (spec.camera != null) {
      const converted = _cameraToSpec(spec.camera);
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
   * Use with createTrack() to bind a CameraTrack to the default camera:
   * ```js
   * const track = createTrack(getCamera())
   * ```
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

  // ── fn.createTrack ─────────────────────────────────────────────────────────

  /**
   * Unified track factory. Returns a PoseTrack or CameraTrack depending
   * on whether a camera is provided.
   *
   * **PoseTrack** — pass nothing (or null):
   * ```js
   * const track = createTrack()
   * const out = { pos:[0,0,0], rot:[0,0,0,1], scl:[1,1,1] }
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
   * **CameraTrack (explicit camera)**:
   * ```js
   * const cam   = createCamera()
   * const track = createTrack(cam)
   *
   * track.add({ eye:[0,0,500], center:[0,0,0] })
   * track.add({ eye:[300,-150,0], center:[0,0,0] })
   * track.add()                          // capture bound camera (track.camera)
   * track.add({ camera: cam })           // capture any p5.Camera
   * track.add({ camera: getCamera() })   // or from the default camera
   * track.play({ loop: true })
   *
   * // in draw(): no guard needed — applyPose fires automatically in predraw
   * setCamera(cam)
   * orbitControl()
   * ```
   *
   * **CameraTrack (default camera)**:
   * ```js
   * const track = createTrack(getCamera())
   * ```
   *
   * Interpolation modes are set directly on the returned track:
   * ```js
   * track.posInterp    = 'linear'       // PoseTrack: 'catmullrom' | 'linear'
   * track.rotInterp    = 'squad'        // PoseTrack: 'slerp' | 'nlerp' | 'squad'
   * track.eyeInterp    = 'linear'       // CameraTrack: 'catmullrom' | 'linear'
   * track.centerInterp = 'catmullrom'   // CameraTrack: 'catmullrom' | 'linear'
   * ```
   *
   * @method createTrack
   * @memberof p5
   * @param {p5.Camera|null} [cam]
   *   Camera to drive.  Pass a p5.Camera (or getCamera()) for a CameraTrack.
   *   Omit or pass null/undefined for an unbound PoseTrack.
   * @returns {PoseTrack|CameraTrack}
   */
  fn.createTrack = function (cam) {
    const pInst = this;

    // ── PoseTrack path ──────────────────────────────────────────────────────
    if (!cam) {
      const track = new PoseTrack();
      _wirePoseTrack(track, pInst);
      return track;
    }

    // ── CameraTrack path ────────────────────────────────────────────────────
    const track = new CameraTrack();
    const out   = { eye:[0,0,0], center:[0,0,0], up:[0,1,0] };

    // Expose so createTrackUI can read it without an extra option.
    track.camera = cam;

    // Patch add() to accept { camera: p5Camera } specs (bridge-side only).
    _patchCameraTrackAdd(track);

    const applyPlayer = {
      tick() {
        if (!track.playing) return false;
        track.tick();
        cam.applyPose(track.eval(out));
        return track.playing;
      }
    };

    track._onActivate   = () => registerPlayer(pInst, applyPlayer);
    track._onDeactivate = () => {
      unregisterPlayer(pInst, applyPlayer);
      // Land exactly on the final keyframe when playback ends.
      if (track.keyframes.length > 0) cam.applyPose(track.eval(out));
    };

    return track;
  };

  // ── p5.Renderer3D — TRS helpers ────────────────────────────────────────────

  /**
   * Rotate by a unit quaternion [x,y,z,w].
   * @method rotateQuat
   * @memberof p5.Renderer3D
   * @param {number[]} q
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
   * @param {{ pos?:number[], rot?:number[], scl?:number[] }} pose
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
   * Read the live camera state into a { eye, center, up } object.
   *
   * - `eye`    ← [eyeX, eyeY, eyeZ]
   * - `center` ← [centerX, centerY, centerZ]
   * - `up`     ← [upX, upY, upZ]  (the hint p5 stores, not the orthogonalised up)
   *
   * Reads cam.upX/Y/Z directly — always the real hint, correct for both
   * upright cameras (up=[0,1,0]) and pole-flipped cameras (up=[0,-1,0]).
   *
   * Pass a pre-allocated out to avoid allocation per frame:
   * ```js
   * const out = { eye:[0,0,0], center:[0,0,0], up:[0,1,0] }
   * track.add(cam.capturePose(out))
   * ```
   *
   * @method capturePose
   * @memberof p5.Camera
   * @param {{ eye:number[], center:number[], up:number[] }} [out]
   * @returns {{ eye:number[], center:number[], up:number[] }}
   */
  p5.Camera.prototype.capturePose = function (out) {
    out = out || { eye:[0,0,0], center:[0,0,0], up:[0,1,0] };
    out.eye[0]    = this.eyeX;    out.eye[1]    = this.eyeY;    out.eye[2]    = this.eyeZ;
    out.center[0] = this.centerX; out.center[1] = this.centerY; out.center[2] = this.centerZ;
    out.up[0]     = this.upX !== undefined ? this.upX : 0;
    out.up[1]     = this.upY !== undefined ? this.upY : 1;
    out.up[2]     = this.upZ !== undefined ? this.upZ : 0;
    return out;
  };

  /**
   * Apply a { eye, center, up } pose to this camera.
   * Calls cam.camera(eye, center, up) directly — no matrix reconstruction,
   * no up_ortho drift, exact roundtrip from capturePose().
   *
   * Also handles legacy { pos, rot, scl } TRS poses from PoseTrack for
   * object-on-camera effects (translate/rotate only, scl is ignored).
   *
   * @method applyPose
   * @memberof p5.Camera
   * @param {{ eye:number[], center:number[], up:number[] } |
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
