/**
 * @file Animating objects and the camera along keyframes
 * @module p5.tree/track
 * @license AGPL-3.0-only
 *
 * Keyframe animation for a `p5.WEBGL` sketch. `createPoseTrack` animates an
 * object: add position, rotation and scale keyframes, play, and read the
 * interpolated pose each frame to place whatever you draw. `createCameraTrack`
 * animates a camera the same way from eye and center keyframes, and the camera
 * follows on its own with nothing to do in `p5.draw()`. Both tracks play
 * automatically each frame, and `{ handles: true }` adds draggable keyframe
 * dots (`TrackHandles`).
 *
 * Reach for `p5.Camera.capturePose` and `p5.Camera.applyPose` to read the
 * current camera into a keyframe or set a camera from one, and for `applyPose`
 * and `rotateQuat` to place an object from a pose or a quaternion. `getCamera`
 * returns the current camera.
 *
 * @details
 * ### What lives here
 *
 *  ```
 *  Players — the host's registry (host.players), reached through
 *    registerPlayer / unregisterPlayer / tickPlayers / clearPlayers
 *
 *  fn.getCamera          Return the current p5 camera (curCamera).
 *  fn.createPoseTrack([opts])          The host's poseTrack; { handles } → TrackHandles.
 *  fn.createCameraTrack([cam][, opts]) The host's cameraTrack over a camera state
 *                        captured from the p5.Camera, applied back to it after
 *                        every evaluation; add() takes a p5.Camera too.
 *
 *  TrackHandles          The host's, with p5 handles as members and a draw().
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
 *  A p5.Camera is read through capturePose; a lookat object with eyeX /
 *  centerX / upX scalars is converted here (the host accepts camera states
 *  only).
 */

'use strict';

import {
  PoseTrack, CameraTrack, createCamera, cameraFromMat4, cameraFromPose,
} from '@nakednous/tree';
import { TrackHandles as HostTrackHandles } from '@nakednous/host';
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

// The sketch's host, or null (with a diagnostic) before createCanvas().
function _hostOrWarn(pInst, who) {
  const host = ensureHost(pInst);
  if (!host) console.error('[p5.tree] ' + who + ': no canvas yet — call after createCanvas().');
  return host;
}

// A lookat object with p5-style scalars (eyeX / centerX / upX) → a camera
// spec; null when the object doesn't look like one.
function _cameraToSpec(cam) {
  if (!cam || typeof cam !== 'object') return null;
  if (cam.eyeX === undefined || cam.centerX === undefined) return null;
  return {
    eye:    [cam.eyeX,    cam.eyeY,    cam.eyeZ],
    center: [cam.centerX, cam.centerY, cam.centerZ],
    up:     [cam.upX ?? 0, cam.upY ?? 1, cam.upZ ?? 0],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TrackHandles — per-keyframe manipulators (the factories' `handles` opt)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The host's TrackHandles with p5 handles as members (so they draw) and the
// draw() the trackPath HANDLES bit calls. The composition, the router, the
// index-resolved binders, the rebuild on a keyframe-count change, the idle
// sync and the keyframe-coordinate hooks are the host's.
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

// ═══════════════════════════════════════════════════════════════════════════════
// Install
// ═══════════════════════════════════════════════════════════════════════════════

export function installTrack(p5, fn) {

  p5.Tree.PoseTrack   = PoseTrack;
  p5.Tree.CameraTrack = CameraTrack;

  /**
   * Keyframe handles of a track, stored at `track.handles` by the track
   * factories' `handles` opt: the host's controller with p5 handles as members.
   */
  class TrackHandles extends HostTrackHandles {
    /**
     * @param {p5}      p          The sketch instance.
     * @param {Object}  track      PoseTrack | CameraTrack.
     * @param {true|Object} opts   `true` for all defaults, or
     *   { center?, rot?, rotRadius?, rotSnap?, grabPx?, snap?, hover? }.
     * @param {boolean} isCamera   CameraTrack (eye/center) vs PoseTrack (pos/rot).
     */
    constructor(p, track, opts, isCamera) {
      super(ensureHost(p), track, opts, isCamera);
      this._p = p;
    }

    // The members are p5 handles, so trackPath can draw them.
    _makeHandle(opts) { return this._p.createHandle(opts); }
    _makeRouter(opts) { return this._p.createPointerRouter(opts); }

    /**
     * Drive the keyframe handles for this frame and report whether one is being
     * dragged. Call it first in `p5.draw()` and orbit only when it returns false,
     * so a press on a dot grabs it while one that misses orbits (see the orbit
     * gate example). Needs a `p5.WEBGL` canvas and a track created with
     * `handles`.
     *
     * @details
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
    update() { return super.update(); }

    /**
     * Tell whether any keyframe handle is being dragged right now (see the
     * magenta path example).
     *
     * @function grabbed
     * @memberof TrackHandles
     * @returns {boolean} true while any keyframe handle is grabbed.
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
    grabbed() { return super.grabbed(); }

    /**
     * Give the index of the keyframe whose handle is under the pointer or being
     * dragged, or null when there is none (see the bulls-eye example).
     *
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
    hovered() { return super.hovered(); }

    /**
     * Refresh the handle dots after editing keyframes from code in the same
     * frame, so they draw where the keyframes are (see the bobbing keyframe
     * example). Chainable.
     *
     * @details
     * Re-seed every idle member from its keyframe. update() already does this
     * each frame; call directly only between update() and a same-frame read.
     * Chainable.
     *
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
     *   // keyframe 1 bobs under script control between grabs
     *   if (!track.handles.grabbed()) {
     *     track.keyframes[1].pos[1] = -60 + 30 * sin(frameCount * 0.05)
     *     track.handles.sync()
     *   }
     *   axes()
     *   stroke('white')
     *   trackPath(track, { marker: null })
     *   fill('#ff4fd8')
     *   trackPath(track, { bits: p5.Tree.HANDLES, marker: null })
     * }
     */
    sync() { return super.sync(); }

    /**
     * Remove the keyframe handles from the track: the dots disappear and the
     * orbit runs unconditionally (see the key-press example).
     *
     * @details
     * Dispose members + router and detach from the track.
     *
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
    dispose() { super.dispose(); }

    /**
     * Draw the keyframe handle dots with the sketch's current fill and stroke; a
     * hovered or grabbed dot grows. Pass `size` for the dot radius and `emphasis`
     * for the hover growth (see the standalone draw example). Normally
     * `trackPath` with the `HANDLES` bit draws them for you.
     *
     * @details
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
      if (!this.enabled) return this;
      const T    = p5.Tree;
      const base = Number.isFinite(opts.size)     ? opts.size     : this.grabPx;
      const emph = Number.isFinite(opts.emphasis) ? opts.emphasis : 1.4;
      for (const m of this.members) {
        const hot  = m.h.hovered() || m.h.grabbed();
        const bits = m.field === 'rot' ? (T.HANDLE | T.AIM | T.LOCUS) : T.HANDLE;
        m.h.draw({ bits, size: base * (hot ? emph : 1) });
      }
      return this;
    }
  }

  // ── fn.getCamera ───────────────────────────────────────────────────────────

  /**
   * Return the current `p5.Camera`, the one drawing the canvas right now.
   *
   * Returns null if called before `p5.createCanvas()`.
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
   * Animate an object along keyframes: add poses, play, and read the
   * interpolated pose each frame with eval to place whatever you draw.
   * Position, rotation and scale each have their own interpolation mode, and
   * `{ handles: true }` adds draggable keyframe dots with an optional rotation
   * ring (see the keyframe handles example). Needs a `p5.WEBGL` canvas.
   *
   * @details
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
   * Null before `createCanvas()`.
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
    const host = _hostOrWarn(this, 'createPoseTrack');
    if (!host) return null;
    const track = host.poseTrack();
    if (opts.handles) track.handles = new TrackHandles(this, track, opts.handles, false);
    return track;
  };

  // ── fn.createCameraTrack ───────────────────────────────────────────────────

  /**
   * Animate the camera along keyframes: add lookats, play, and the camera
   * follows with nothing to do in `p5.draw()`. Pass a camera to fly a second
   * one while the default stays free to orbit, and add `{ handles: true }` to
   * drag keyframe eyes and centers (see the keyframe handles example). Needs a
   * `p5.WEBGL` canvas; keyframe handles need a second camera to fly, viewed
   * from the default one.
   *
   * @details
   * Create a CameraTrack bound to a p5.Camera: the host's track over a camera
   * state, applied back to the p5.Camera (lookat and lens) after every
   * evaluation, and once more when playback stops so the camera rests on the
   * path.
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
   * Null before `createCanvas()`.
   *
   * @function createCameraTrack
   * @memberof p5
   * @param {p5.Camera} [cam]  Camera to drive. Defaults to the current camera.
   *                           Use `p5.createCamera()` for a dedicated camera.
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
    // Options-only call — createCameraTrack({ handles: true }): a plain
    // object with no lookat surface is an opts bag, not a camera.
    if (cam && typeof cam === 'object' && !(cam instanceof p5.Camera) &&
        cam.eyeX === undefined) {
      opts = cam; cam = undefined;
    }
    cam = cam ?? this.getCamera() ?? null;
    const host = _hostOrWarn(this, 'createCameraTrack');
    if (!host) return null;

    // The camera state the host evaluates into, seeded from the p5 camera;
    // every evaluation lands back on the camera through applyPose.
    const state = cam ? cam.capturePose(createCamera()) : null;
    const track = host.cameraTrack(state);
    track.camera = cam;
    if (cam) track._onApply = (s) => cam.applyPose(s);

    // add(): a p5.Camera (or a lookat object with p5-style scalars) reads
    // through capturePose; everything else is the host's.
    const hostAdd = track.add;
    track.add = function (spec, addOpts) {
      if (spec == null) {
        if (!cam) return;
        spec = cam.capturePose();
      } else if (Array.isArray(spec)) {
        for (const s of spec) track.add(s, addOpts);
        return;
      } else if (spec.camera != null) {
        const c = spec.camera;
        spec = typeof c.capturePose === 'function' ? c.capturePose() : (_cameraToSpec(c) || c);
      }
      hostAdd(spec, addOpts);
    };

    if (opts.handles) track.handles = new TrackHandles(this, track, opts.handles, true);
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
   *   qMul(q, dq, q)   // q is both an input and the output
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
   * Apply a `{ pos, rot, scl }` pose (translate, rotate, scale) to the
   * current transform.
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
   * Read this camera's eye, center, up and lens into a pose you can add to a
   * camera track or draw as a frustum. Pass your own `out` object to reuse it
   * every frame (see the second camera example). Works on any `p5.Camera`,
   * live or not.
   *
   * @details
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
   * Set this camera from a pose: eye, center and up, plus the lens when a fov
   * or halfHeight is given. Also accepts a `{ pos, rot, scl }` pose from a
   * `PoseTrack`, so a camera can ride an object's animation.
   *
   * @details
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
