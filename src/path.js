/**
 * @file PoseTrack / CameraTrack bridge: player registry, camera pose helpers.
 * @module p5.tree/path
 * @license GPL-3.0-only
 *
 * ── What lives here ──────────────────────────────────────────────────────────
 *  Player registry
 *    registerPlayer / unregisterPlayer / tickPlayers / clearPlayers
 *
 *  fn.createPoseTrack    PoseTrack wired to the p5 draw loop
 *  fn.createCameraTrack  CameraTrack wired to the p5 draw loop + auto-apply
 *
 *  p5.Renderer3D.rotateQuat   rotate by [x,y,z,w] quaternion
 *  p5.Renderer3D.applyPose    apply TRS { pos, rot, scl } to the transform stack
 *  fn.rotateQuat / fn.applyPose   forwarders to the renderer
 *
 *  p5.Camera.capturePose  read live camera → { eye, center, up }
 *  p5.Camera.applyPose    write { eye, center, up } → cam.camera()
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

// ── shared player factory ─────────────────────────────────────────────────────

function _wireTrack(track, pInst) {
  let player = null;
  track._onActivate   = () => {
    player = player || { tick() { track.tick(); return track.playing; } };
    registerPlayer(pInst, player);
  };
  track._onDeactivate = () => unregisterPlayer(pInst, player);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Install
// ═══════════════════════════════════════════════════════════════════════════════

export function installPath(p5, fn) {

  p5.Tree.PoseTrack   = PoseTrack;
  p5.Tree.CameraTrack = CameraTrack;

  // ── fn.createPoseTrack ─────────────────────────────────────────────────────

  /**
   * Create a PoseTrack wired to this p5 instance's draw loop.
   * play() auto-registers; stop() / natural end auto-unregisters.
   *
   * @method createPoseTrack
   * @memberof p5
   * @returns {PoseTrack}
   *
   * @example
   * let track
   * const out = { pos:[0,0,0], rot:[0,0,0,1], scl:[1,1,1] }
   * function setup() {
   *   createCanvas(600, 400, WEBGL)
   *   track = createPoseTrack()
   *   track.add({ pos:[0,0,0], rot:[0,0,0,1], scl:[1,1,1] })
   *   track.add({ pos:[200,0,0], rot:[0,0,0,1], scl:[1,1,1] })
   *   track.play({ loop: true })
   * }
   * function draw() {
   *   background(20)
   *   if (track.playing) {
   *     push()
   *     applyPose(track.eval(out))
   *     box(60)
   *     pop()
   *   }
   * }
   */
  fn.createPoseTrack = function () {
    const track = new PoseTrack();
    _wireTrack(track, this);
    return track;
  };

  // ── fn.createCameraTrack ───────────────────────────────────────────────────

  /**
   * Create a CameraTrack wired to this p5 instance's draw loop.
   *
   * Stores { eye, center, up } keyframes natively — no field repurposing.
   * Playback applies each frame automatically via cam.applyPose().
   *
   * The draw guard `if (track.playing)` is NOT needed in user code —
   * applyPose is wired internally in predraw, after tick() advances
   * the cursor and before draw() runs.
   *
   * Typical usage:
   * ```js
   * let cam, track, out
   * function setup() {
   *   createCanvas(600, 400, WEBGL)
   *   cam   = createCamera()
   *   track = createCameraTrack(cam)
   *   track.add({ eye:[0,0,500], center:[0,0,0] })
   *   track.add({ eye:[300,-150,0], center:[0,0,0] })
   *   track.play({ loop: true })
   * }
   * function draw() {
   *   background(20)
   *   setCamera(cam)
   *   orbitControl()
   *   axes(); grid()
   * }
   * ```
   *
   * When not playing, orbitControl works freely.
   * When playing, the track pose overwrites whatever orbitControl did.
   *
   * @method createCameraTrack
   * @memberof p5
   * @param {p5.Camera} [cam]  Camera to drive. Defaults to curCamera.
   * @returns {CameraTrack}
   */
  fn.createCameraTrack = function (cam) {
    const pInst = this;
    const track = new CameraTrack();
    const out   = { eye:[0,0,0], center:[0,0,0], up:[0,1,0] };

    // Resolve camera once at creation time.
    // curCamera is always set after createCanvas() so lazy resolution isn't needed.
    // Fall back to curCamera only when cam is omitted (default camera use case).
    const resolvedCam = cam || pInst._renderer?.states?.curCamera;

    // Expose on track so createTrackUI can read it without an extra option.
    track.camera = resolvedCam;

    const applyPlayer = {
      tick() {
        if (!track.playing) return false;
        track.tick();
        if (resolvedCam) resolvedCam.applyPose(track.eval(out));
        return track.playing;
      }
    };

    track._onActivate   = () => registerPlayer(pInst, applyPlayer);
    track._onDeactivate = () => {
      unregisterPlayer(pInst, applyPlayer);
      // Apply final pose so camera lands exactly on the last keyframe.
      if (resolvedCam && track.keyframes.length > 0) resolvedCam.applyPose(track.eval(out));
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
    const x=q[0],y=q[1],z=q[2];
    const sinHalf = Math.sqrt(x*x+y*y+z*z);
    if (sinHalf < eps) return this;
    const angle = 2*Math.atan2(sinHalf, q[3]);
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

  // fn forwarders
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
   * - `up`     ← [upX, upY, upZ]  (the hint p5 stores, not the orthogonalized up)
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

    // { pos, rot } — legacy TRS form (translates + rotates the view)
    // Useful for animating the camera like an object (shake, bob, etc.)
    if (pose.pos && pose.rot) {
      const rm = new Float32Array(16);
      qToMat4(rm, pose.rot);
      const upX=rm[4], upY=rm[5], upZ=rm[6];
      const fwdX=-rm[8], fwdY=-rm[9], fwdZ=-rm[10];
      const dx=this.centerX-this.eyeX, dy=this.centerY-this.eyeY, dz=this.centerZ-this.eyeZ;
      const dist=Math.sqrt(dx*dx+dy*dy+dz*dz)||1;
      this.camera(
        pose.pos[0], pose.pos[1], pose.pos[2],
        pose.pos[0]+fwdX*dist, pose.pos[1]+fwdY*dist, pose.pos[2]+fwdZ*dist,
        upX, upY, upZ
      );
    }
    return this;
  };
}
