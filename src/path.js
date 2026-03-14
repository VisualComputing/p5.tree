/**
 * @file PoseTrack bridge: player registry, camera pose capture/apply,
 *       Renderer3D TRS helpers.
 * @module p5.tree/path
 * @license GPL-3.0-only
 *
 * ── What lives here ──────────────────────────────────────────────────────────
 *  Player registry   registerPlayer / unregisterPlayer / tickPlayers / clearPlayers
 *  fn.createPoseTrack          PoseTrack wired to the p5 draw loop
 *  p5.Renderer3D.rotateQuat    rotate by [x,y,z,w] quaternion
 *  p5.Renderer3D.applyPose     apply TRS pose to the transform stack
 *  fn.rotateQuat / fn.applyPose  forwarders to the renderer
 *  p5.Camera.capturePose       read current camera state → TRS pose
 *  p5.Camera.applyPose         write TRS pose back to the camera
 *
 * ── What was removed (was @module p5.tree/path pre 0.0.19) ──────────────────
 *  addPath / setPath / removePath / playPath / seekPath / stopPath / resetPath
 *  pathTime / pathInfo  (camera path shorthand methods + global forwarders)
 *  CameraAdapter, getCamTrack, tickCamera, _applyCamAtCursor, applyCamInterp
 *  p5.Camera.slerp usage
 *  camera.path backward-compat property
 *
 * ── Migration ────────────────────────────────────────────────────────────────
 *  Old:
 *    cam.addPath()
 *    cam.playPath({ loop: true })
 *    // in draw:  (applied automatically)
 *
 *  New:
 *    const track = createPoseTrack()
 *    const out   = { pos: [0,0,0], rot: [0,0,0,1], scl: [1,1,1] }
 *    // record:
 *    track.add(cam.capturePose())
 *    // play:
 *    track.play({ loop: true })
 *    // in draw:
 *    if (track.playing) { track.tick(); cam.applyPose(track.eval(out)) }
 */

'use strict';

import { PoseTrack } from '@nakednous/tree';


// ═══════════════════════════════════════════════════════════════════════════════
// Player registry
// Tracks are registered here so their tick() is called every predraw.
// ═══════════════════════════════════════════════════════════════════════════════

const PATH_PLAYERS = new WeakMap();

function _getPlayers(pInst) {
  let players = PATH_PLAYERS.get(pInst);
  if (!players) { players = new Set(); PATH_PLAYERS.set(pInst, players); }
  return players;
}

/**
 * Register a player with the given p5 instance.
 * `player.tick()` is called each predraw; the player is removed when it
 * returns false / undefined.
 * @param {p5} pInst
 * @param {{ tick: () => boolean }} player
 */
export function registerPlayer(pInst, player) {
  if (!pInst || !player) return;
  _getPlayers(pInst).add(player);
}

/**
 * Unregister a player from the given p5 instance.
 * @param {p5} pInst
 * @param {{ tick: () => boolean }} player
 */
export function unregisterPlayer(pInst, player) {
  if (!pInst || !player) return;
  _getPlayers(pInst).delete(player);
}

/**
 * Tick all registered players for a p5 instance.
 * Called automatically from the predraw lifecycle.
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
 * Remove all players for a p5 instance.
 * Called from the remove lifecycle.
 * @param {p5} pInst
 */
export function clearPlayers(pInst) {
  const players = PATH_PLAYERS.get(pInst);
  if (players) players.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Install
// ═══════════════════════════════════════════════════════════════════════════════

export function installPath(p5, fn) {

  // Expose core type on p5.Tree namespace so users can instanceof-check.
  p5.Tree.PoseTrack = PoseTrack;

  // ── fn.createPoseTrack ─────────────────────────────────────────────────────

  /**
   * Create a PoseTrack wired to this p5 instance's draw loop.
   * play() auto-registers the track; stop() / natural end auto-unregisters it.
   * Multiple concurrent PoseTracks are fully supported.
   *
   * @method createPoseTrack
   * @memberof p5
   * @returns {PoseTrack}
   *
   * @example
   * let track, out
   * function setup() {
   *   createCanvas(600, 400, WEBGL)
   *   track = createPoseTrack()
   *   out   = { pos: [0,0,0], rot: [0,0,0,1], scl: [1,1,1] }
   *   track.add(camera.capturePose())
   *   // …record more keyframes…
   *   track.play({ loop: true })
   * }
   * function draw() {
   *   background(20)
   *   if (track.playing) {
   *     track.tick()
   *     camera.applyPose(track.eval(out))
   *   }
   * }
   */
  fn.createPoseTrack = function () {
    const pInst = this;
    const track = new PoseTrack();
    let   player = null;

    // Lib-space hook: playing went false → true
    track._onActivate = () => {
      player = player || { tick() { track.tick(); return track.playing; } };
      registerPlayer(pInst, player);
    };

    // Lib-space hook: playing went true → false (any cause)
    track._onDeactivate = () => {
      unregisterPlayer(pInst, player);
    };

    return track;
  };

  // ── p5.Renderer3D — TRS helpers ────────────────────────────────────────────

  /**
   * Rotate by a unit quaternion [x,y,z,w], applied as an axis-angle rotation.
   * No-op when the quaternion's vector part is below `eps`.
   *
   * @method rotateQuat
   * @memberof p5.Renderer3D
   * @param {number[]} q         Unit quaternion [x,y,z,w].
   * @param {Object}  [opts]
   * @param {number}  [opts.eps=1e-8]  Minimum sine threshold.
   * @returns {p5.Renderer3D} this
   */
  p5.Renderer3D.prototype.rotateQuat = function (q, opts) {
    const p       = this._pInst;
    const eps     = opts?.eps ?? 1e-8;
    const x = q[0], y = q[1], z = q[2];
    const sinHalf = Math.sqrt(x * x + y * y + z * z);
    if (sinHalf < eps) return this;
    const angle = 2 * Math.atan2(sinHalf, q[3]);
    p.rotate(angle, [x / sinHalf, y / sinHalf, z / sinHalf]);
    return this;
  };

  /**
   * Apply a TRS pose to the current transform stack —
   * translate → rotateQuat → scale, in that order.
   * Missing components are skipped silently.
   *
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

  // ── fn forwarders ──────────────────────────────────────────────────────────

  /**
   * Rotate by a unit quaternion [x,y,z,w].
   * Delegates to p5.Renderer3D.rotateQuat.
   * @method rotateQuat
   * @memberof p5
   * @param {number[]} q
   * @param {Object}  [opts]
   */
  fn.rotateQuat = function (q, opts) { this._renderer.rotateQuat(q, opts); return this; };

  /**
   * Apply a TRS pose to the transform stack.
   * Delegates to p5.Renderer3D.applyPose.
   * @method applyPose
   * @memberof p5
   * @param {{ pos?:number[], rot?:number[], scl?:number[] }} pose
   */
  fn.applyPose = function (pose) { this._renderer.applyPose(pose); return this; };

  // ── p5.Camera — capturePose / applyPose ────────────────────────────────────

  /**
   * Read the current camera state into a TRS pose object.
   *
   * Field repurposing for camera poses:
   * - `pos`  ← [eyeX, eyeY, eyeZ]
   * - `scl`  ← [centerX, centerY, centerZ]  (lookat center, NOT scale)
   * - `rot`  ← quaternion encoding the up-hint direction as a rotation from
   *            world Y [0,1,0] to cam.upX/Y/Z.
   *
   * Why up-hint and not up_ortho (from cameraMatrix col1):
   *   p5 stores the raw up hint in cam.upX/Y/Z. cam.camera() is called with
   *   that hint; p5 orthogonalizes internally. If applyPose passes up_ortho
   *   instead of the hint, p5 stores the orthogonalized vector as the new
   *   cam.upX/Y/Z, which shifts orbitControl's reference frame and causes
   *   visually noticeable drift from the recorded position.
   *
   * For cameras with up=[0,1,0] (the common case) rot is always identity,
   * guaranteeing a perfect roundtrip. For rolled cameras, slerp between
   * two "Y-to-upHint" quaternions gives smooth up interpolation.
   *
   * Pass a pre-allocated `out` to avoid allocation per frame:
   * ```js
   * const out = { pos: [0,0,0], rot: [0,0,0,1], scl: [0,0,0] }
   * track.add(cam.capturePose(out))
   * ```
   *
   * @method capturePose
   * @memberof p5.Camera
   * @param {{ pos:number[], rot:number[], scl:number[] }} [out]
   * @returns {{ pos:number[], rot:number[], scl:number[] }}
   */
  p5.Camera.prototype.capturePose = function (out) {
    out = out || { pos: [0, 0, 0], rot: [0, 0, 0, 1], scl: [0, 0, 0] };
    // pos = eye
    out.pos[0] = this.eyeX;    out.pos[1] = this.eyeY;    out.pos[2] = this.eyeZ;
    // scl = center (repurposed — not scale)
    out.scl[0] = this.centerX; out.scl[1] = this.centerY; out.scl[2] = this.centerZ;
    // rot = quaternion from world Y to cam.upX/Y/Z (the hint, not the orthogonalized up).
    // For upHint=[0,1,0]: rot = identity → perfect roundtrip, no drift.
    const ux = this.upX || 0, uy = this.upY !== undefined ? this.upY : 1, uz = this.upZ || 0;
    const ul  = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    const unx = ux / ul, uny = uy / ul, unz = uz / ul;
    // quaternion from [0,1,0] to [unx,uny,unz]
    const d = uny; // dot([0,1,0], [unx,uny,unz])
    if (d > 0.9999) {
      out.rot[0] = 0; out.rot[1] = 0; out.rot[2] = 0; out.rot[3] = 1; // identity
    } else if (d < -0.9999) {
      out.rot[0] = 0; out.rot[1] = 0; out.rot[2] = 1; out.rot[3] = 0; // 180° around Z
    } else {
      // axis = [0,1,0] × [unx,uny,unz] = [unz*0-unx*0... wait:
      // [0,1,0]×[ux,uy,uz] = [1*uz-0*uy, 0*ux-0*uz, 0*uy-1*ux] = [uz, 0, -ux]
      const ax = unz, ay = 0, az = -unx;
      const al = Math.sqrt(ax * ax + az * az) || 1;
      const angle = Math.acos(Math.max(-1, Math.min(1, d)));
      const s = Math.sin(angle / 2), c = Math.cos(angle / 2);
      out.rot[0] = ax / al * s; out.rot[1] = ay * s; out.rot[2] = az / al * s; out.rot[3] = c;
    }
    return out;
  };

  /**
   * Apply a TRS pose to this camera.
   *
   * Interprets the pose fields as set by capturePose:
   * - `pos`  → eye position
   * - `scl`  → lookat center (interpolated directly by PoseTrack)
   * - `rot`  → quaternion encoding up direction; Y [0,1,0] rotated by rot gives upHint
   *
   * @method applyPose
   * @memberof p5.Camera
   * @param {{ pos:number[], rot:number[], scl:number[] }} pose
   * @returns {p5.Camera} this
   */
  p5.Camera.prototype.applyPose = function (pose) {
    if (!pose || !pose.pos || !pose.rot) return this;
    const q = pose.rot;
    // Rotate world Y [0,1,0] by q to recover the up hint.
    // Standard formula for q * [0,1,0] * q^-1:
    const upX = 2 * (q[0] * q[1] - q[3] * q[2]);
    const upY = 1 - 2 * (q[0] * q[0] + q[2] * q[2]);
    const upZ = 2 * (q[1] * q[2] + q[3] * q[0]);
    // center from scl; fall back to current center for manually-constructed poses
    const cx = pose.scl ? pose.scl[0] : this.centerX;
    const cy = pose.scl ? pose.scl[1] : this.centerY;
    const cz = pose.scl ? pose.scl[2] : this.centerZ;
    this.camera(pose.pos[0], pose.pos[1], pose.pos[2], cx, cy, cz, upX, upY, upZ);
    return this;
  };
}
