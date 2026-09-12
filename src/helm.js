/**
 * @file Flying the camera or an object from a live 6-DOF device
 * @module p5.tree/helm
 * @license AGPL-3.0-only
 *
 * Six-degree-of-freedom control for a `p5.WEBGL` sketch: feed translation and
 * rotation rates each frame from a SpaceMouse, a gamepad, a touch gesture or
 * any other live source, and something moves. `createCameraHelm` flies a
 * camera body-relative, a forward push flying forward. `createPoseHelm`
 * produces a pose and drives whatever you `bind` to it: a plain pose object, a
 * second `p5.Camera` or your own setter, with `from` choosing whether pushes
 * are screen-, world- or body-relative.
 *
 * `helmRig` draws a control rig of the six channels, in the scene or as a
 * corner HUD, lighting up the one being driven; add `identify` to see which
 * input channel moves which axis when wiring up a new device.
 *
 * @details
 * The host's helm factories (`@nakednous/host`) do the work: a core
 * `PoseHelm` stepped by the host's players each predraw, the body-fly basis
 * of a camera helm (the driven state's own eye matrix) and a pose helm's
 * `from` (WORLD | EYE, the host's view bag | SELF | a mat4), the bind shapes
 * for a camera state, an `{ applyPose }` sink, an accessor and a `{ pos,
 * rot }` object. What p5.tree adds: the `p5.Camera` on either side — a camera
 * helm flies a camera state captured from the p5 camera and writes its
 * lookat back each tick; a pose helm's `bind(p5.Camera)` is an accessor over
 * `capturePose` / `applyPose` — and the `helmRig` gizmo.
 *
 * ### Family placement
 * `PoseHelm : CameraHelm :: PoseTrack : CameraTrack` — ONE core class, TWO
 * factories. Neither is a wrapper class: each returns the core `PoseHelm`
 * with `dispose()` (and `bind()` on the pose helm) attached.
 *
 *    ```
 *   createCameraHelm([cam][, opts])  fly `cam` from the stream (body-relative).
 *   createPoseHelm([opts]) + bind()  produce a pose, drive any target with it
 *                                     (screen-relative manipulation).
 *    ```
 *
 * ### `from` → basis (the one camera-aware step)
 *
 *    ```
 *   createCameraHelm — ALWAYS body-fly, no `from`: the basis is the driven
 *                      camera's own eye matrix, which equals the pose the helm
 *                      wrote last frame (zero staleness), so a forward push
 *                      flies forward. A camera *is* the frame it flies in.
 *   createPoseHelm   — `from` names the frame the rates are read in:
 *                        WORLD   → the identity basis.
 *                        EYE     → the VIEWING camera, from the host's view bag
 *                                  as filled each predraw ⇒ screen-relative.
 *                        SELF    → the helm's own current rotation ⇒ body-relative
 *                                  (the object analogue of camera body-fly).
 *                        <mat4>  → an explicit fixed frame (p5.Matrix | Float32Array).
 *    ```
 *
 * ### Seeding
 * Driving a live camera (or binding one as a target) seeds the integrated pose
 * from the camera's current lookat so frame 0 doesn't jump: `pos ← eye`,
 * `rot ← qFromLookDir(center − eye, up)` — the core's `cameraToPose`.
 */

'use strict';

import { PoseHelm, createCamera, cameraToPose, qFromMat4, mat4MulPoint } from '@nakednous/tree';
import { helmBasis } from '@nakednous/host';
import { ensureHost, hostOf, syncHostView } from './matrix.js';

// ═══════════════════════════════════════════════════════════════════════════
// Module-level scratch — synchronous, single-threaded, never returned
// ═══════════════════════════════════════════════════════════════════════════

const _pose  = { pos: [0, 0, 0], rot: [0, 0, 0, 1] };  // a p5.Camera's pose, for the bind accessor
const _cp    = createCamera();                          // capturePose() scratch
const _em    = new Float32Array(16);                    // resolved basis (rig orient)
const _act   = [0, 0, 0, 0, 0, 0];                      // helm.activity() readout (gizmo)
const _rigQ  = [0, 0, 0, 1];                            // resolved-`from` rotation (rig orient)
const _lp    = [0, 0, 0];                               // a rig label's anchor, rig frame
const _lw    = [0, 0, 0];                               // the same anchor in world
let _rigSeq = 0;                                        // rig ids, for the label layer

// Semantic per-axis colours — X / Y / Z, matching gizmos.js _AXIS_COLORS
// (Red / Lime / DodgerBlue). RGB triples so the idle state can dim via alpha.
const _HELM_RGB = [[255, 0, 0], [0, 255, 0], [30, 144, 255]];

// HUD-rig viewing angle. The FBO overload frames the rig through its own ortho
// camera; `tilt` is that camera's elevation above the rig's horizontal, with the
// azimuth fixed at the isometric 45° so X and Z stay symmetric and all three
// axes read. Default is true isometric. A user-supplied `tilt` honours angleMode
// (p5 v2 default RADIANS); the iso default is intrinsic, not converted.
const _AZ_ISO = Math.PI / 4;                  // 45° — iso azimuth (one knob controls the look)
const _EL_ISO = Math.atan(1 / Math.SQRT2);    // 35.264° — true isometric elevation (the default)

// (p, tilt) → [azimuth, elevation] in radians. tilt omitted → iso; a scalar is
// the elevation (azimuth stays iso); [az, el] sets both.
function _rigAzEl(p, tilt) {
  if (tilt == null) return [_AZ_ISO, _EL_ISO];
  const rad = (a) => (p.angleMode && p.angleMode() === p.DEGREES) ? a * Math.PI / 180 : a;
  if (Array.isArray(tilt)) return [rad(tilt[0]), rad(tilt[1])];
  return [_AZ_ISO, rad(tilt)];
}

// The sketch's host, or null (with a diagnostic) before createCanvas().
function _hostOrWarn(pInst, who) {
  const host = ensureHost(pInst);
  if (!host) console.error('[p5.tree] ' + who + ': no canvas yet — call after createCanvas().');
  return host;
}

// Release the rig framebuffer a helmRig HUD overload cached on the helm.
function _releaseRig(helm) {
  if (helm._rigFbo && typeof helm._rigFbo.remove === 'function') helm._rigFbo.remove();
  helm._rigFbo = null;
}

// ── Gizmo draw primitives (local-array style, parity with gizmos.js) ────────

// Arrow along a principal axis (0=X, 1=Y, 2=Z), signed length L, head size h.
function _drawArrow(p, axis, L, h) {
  const a = (axis + 1) % 3, b = (axis + 2) % 3;
  const tip = [0, 0, 0]; tip[axis] = L;
  p.line(0, 0, 0, tip[0], tip[1], tip[2]);
  const s  = Math.sign(L) || 1;
  const ha = [0, 0, 0]; ha[axis] = L - s * h;       // arrowhead base ring height
  ha[a] =  h * 0.5; p.line(tip[0], tip[1], tip[2], ha[0], ha[1], ha[2]);
  ha[a] = -h * 0.5; p.line(tip[0], tip[1], tip[2], ha[0], ha[1], ha[2]);
  ha[a] = 0;
  ha[b] =  h * 0.5; p.line(tip[0], tip[1], tip[2], ha[0], ha[1], ha[2]);
  ha[b] = -h * 0.5; p.line(tip[0], tip[1], tip[2], ha[0], ha[1], ha[2]);
}

// Sampled ring in the plane ⊥ a principal axis (0=X→YZ, 1=Y→ZX, 2=Z→XY).
function _drawRing(p, axis, r, detail) {
  const a = (axis + 1) % 3, b = (axis + 2) % 3;
  const v = [0, 0, 0];
  let px = 0, py = 0, pz = 0;
  for (let i = 0; i <= detail; i++) {
    const t = (i / detail) * Math.PI * 2;
    v[0] = v[1] = v[2] = 0;
    v[a] = Math.cos(t) * r;
    v[b] = Math.sin(t) * r;
    if (i > 0) p.line(px, py, pz, v[0], v[1], v[2]);
    px = v[0]; py = v[1]; pz = v[2];
  }
}

// Sampled arc in the plane ⊥ a principal axis, from angle 0 to `sweep` (signed),
// `detail` segments. The signed-meter overlay for the rotation rings.
function _drawArc(p, axis, r, sweep, detail) {
  const a = (axis + 1) % 3, b = (axis + 2) % 3;
  const n = Math.max(1, detail | 0);
  const v = [0, 0, 0];
  let px = 0, py = 0, pz = 0;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * sweep;
    v[0] = v[1] = v[2] = 0;
    v[a] = Math.cos(t) * r;
    v[b] = Math.sin(t) * r;
    if (i > 0) p.line(px, py, pz, v[0], v[1], v[2]);
    px = v[0]; py = v[1]; pz = v[2];
  }
}

// An `identify` label through the host's label layer: the anchor, given in
// the rig's frame, goes to world through the current model matrix; the label
// is transient, so a rig that stops drawing takes its labels with it.
function _rigLabel(p, helm, key, text) {
  const host = hostOf(p);
  if (!host) return;
  const id = helm._rigId || (helm._rigId = ++_rigSeq);
  mat4MulPoint(_lw, p._renderer.states.uModelMatrix.mat4, _lp[0], _lp[1], _lp[2]);
  host.labels.set('helmRig' + id + ':' + key, text, _lw[0], _lw[1], _lw[2], { frame: true, class: 'helm-rig' });
}

// Draw the rig at the current model transform: three translation arrows and
// three rotation rings, each a DIM baseline (the sign/sens geometry) plus, for
// the channel driven this frame, a BRIGHT signed overlay growing in the live
// push/pull direction with length / arc ∝ magnitude, in the semantic axis
// colour. Reads activity() (already post deadzone·sign·sens, so already signed);
// the live magnitude is the raw lane rate recovered as |activity|/sens and
// normalised to the canonical full deflection the e7/e8 HUDs use. Orientation
// and placement are the caller's; this draws in whatever frame is current.
function _drawRig(p, helm, size, doT, doR, identify) {
  helm.activity(_act);
  const prof   = helm.profile;
  const head   = size * 0.08;
  const ringR0 = size * 0.5;
  const TREF   = 0.30, RREF = 0.0025;
  const ACT_FULL = helm.fullScale;   // full-deflection scale, read off the helm
  const ARC_FULL = Math.PI;          // a full push sweeps half the ring

  if (doT) {
    const T = [prof.Tx, prof.Ty, prof.Tz];
    for (let ax = 0; ax < 3; ax++) {
      const ch = T[ax], c = _HELM_RGB[ax];
      const L  = ch.sign * size * (ch.sens / TREF);
      p.stroke(c[0], c[1], c[2], 110);           // dim baseline = sign·sens readout
      _drawArrow(p, ax, L, head);
      const a = _act[ax];                         // signed effective rate
      if (a !== 0) {                              // bright overlay = live push/pull
        const f  = Math.min(Math.abs(a) / (ch.sens * ACT_FULL), 1);
        const Lo = Math.sign(a) * f * Math.abs(L);
        p.stroke(c[0], c[1], c[2], 255);
        _drawArrow(p, ax, Lo, head);
      }
      if (identify) {
        _lp[0] = _lp[1] = _lp[2] = 0; _lp[ax] = L + ch.sign * head * 1.5;
        _rigLabel(p, helm, 'T' + ax, 'L' + ch.lane);
      }
    }
  }

  if (doR) {
    const R = [prof.Rp, prof.Ry, prof.Rr];   // pitch ⊥X, yaw ⊥Y, roll ⊥Z
    for (let ax = 0; ax < 3; ax++) {
      const ch = R[ax], c = _HELM_RGB[ax];
      const r  = ringR0 * (ch.sens / RREF);
      p.stroke(c[0], c[1], c[2], 110);           // dim baseline ring = sens readout
      _drawRing(p, ax, r, 48);
      const a = _act[3 + ax];                     // signed effective rate
      if (a !== 0) {                              // bright signed arc = live magnitude
        const f = Math.min(Math.abs(a) / (ch.sens * ACT_FULL), 1);
        p.stroke(c[0], c[1], c[2], 255);
        _drawArc(p, ax, r, Math.sign(a) * f * ARC_FULL, 24);
      }
      if (identify) {
        _lp[0] = _lp[1] = _lp[2] = 0; _lp[(ax + 1) % 3] = r;
        _rigLabel(p, helm, 'R' + ax, 'L' + ch.lane);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Install
// ═══════════════════════════════════════════════════════════════════════════

export function installHelm(p5, fn) {

  p5.Tree.PoseHelm = PoseHelm;

  // ── fn.createCameraHelm ────────────────────────────────────────────────────

  /**
   * Fly the camera from a 6-DOF device: feed it translation and rotation rates
   * each frame and the camera moves body-relative, a forward push flying
   * forward. Pass a camera to fly a second one, or opts for `deadzone` and a
   * `profile` that maps input channels to axes (see the probe example). Needs a
   * `p5.WEBGL` canvas and a rate source such as a SpaceMouse, a gamepad or a
   * touch gesture.
   *
   * @details
   * Create a CameraHelm: fly a p5.Camera from a live 6-DOF rate stream.
   *
   * Returns a stateful controller (like `createCameraTrack`), not a draw call.
   * The camera is captured into a camera state the host's helm flies; the
   * state's lookat is written back to the p5.Camera every predraw (the lens
   * is untouched). Seeded from the camera's current lookat (frame 0 is
   * continuous) and re-driven every frame from the latest `feed()`. The
   * stream is always body-relative — a forward push flies forward. There is
   * no `from`: a camera helm *is* the frame it flies in. (For screen- or
   * world-relative camera motion, bind the camera to a `createPoseHelm`.)
   *
   * ```js
   * let helm
   * function setup() {
   *   createCanvas(720, 480, WEBGL)
   *   helm = createCameraHelm()            // binds the default camera
   * }
   * function draw() {
   *   background(10)
   *   // a transport feeds raw device rates (SpaceNavigator, gesture, …):
   *   helm.feed(translation, rotation)     // either half may be omitted
   *   grid(); axes()
   * }
   * ```
   *
   * The first argument may be omitted, a p5.Camera, or the opts object:
   * ```js
   * createCameraHelm()                       // default camera
   * createCameraHelm(getCamera())            // explicit camera
   * createCameraHelm({ deadzone: 12 })       // opts only, default camera
   * ```
   *
   * The returned helm exposes the core surface (`feed`, `profile`, `deadzone`,
   * `home`, `eval`, `activity`) plus `dispose()` to unregister. Null before
   * `createCanvas()`.
   *
   * @function createCameraHelm
   * @memberof p5
   * @param {p5.Camera | Object} [cam]  Camera to drive, or the opts object.
   *                                    Defaults to the current camera.
   * @param {{ profile?: Object, deadzone?: number }} [opts]
   * @returns {PoseHelm}
   * @example
   * <caption>Fly the default camera from a probe: hold the mouse, y pushes forward and x yaws; the rig reads the lanes</caption>
   * let helm
   * const lin = [0, 0, 0], ang = [0, 0, 0]
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   helm = createCameraHelm()   // the current camera, seeded from its lookat
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   // a probe in place of a device, on the default lane mapping: lane 1 is Tz, lane 2 is Ry
   *   const hold = mouseIsPressed ? 1 : 0
   *   lin[1] = hold * 500 * (0.5 - mouseY / height) * 2
   *   ang[2] = hold * 500 * (mouseX / width - 0.5) * 2
   *   helm.feed(lin, ang)
   *   axes()
   *   stroke('white')
   *   push()
   *   rotateX(HALF_PI)
   *   grid({ size: 400, subdivisions: 20 })
   *   pop()
   *   noStroke()
   *   fill('#ff4fd8')
   *   for (let i = 0; i < 6; i++) {
   *     push()
   *     translate(150 * cos(i * PI / 3), -20, 150 * sin(i * PI / 3))
   *     box(40)
   *     pop()
   *   }
   *   helmRig(helm, { x: width - 136, y: 16, size: 120 })
   * }
   */
  fn.createCameraHelm = function (cam, opts) {
    // Arg juggle: createCameraHelm(opts) / createCameraHelm() — first arg is the
    // opts object (or absent) when it isn't a camera.
    if (cam && !(cam instanceof p5.Camera)) { opts = cam; cam = null; }
    cam = cam ?? this.getCamera() ?? null;
    const host = _hostOrWarn(this, 'createCameraHelm');
    if (!host || !cam) return null;

    // The camera state the host flies, captured from the p5 camera once; its
    // lookat lands back on the camera after every step.
    const state = cam.capturePose(createCamera());
    const helm = host.cameraHelm(state, opts);
    helm._onApply = (s) => cam.camera(
      s.eye[0], s.eye[1], s.eye[2], s.center[0], s.center[1], s.center[2], s.up[0], s.up[1], s.up[2]);
    const hostDispose = helm.dispose;
    helm.dispose = () => { hostDispose(); _releaseRig(helm); return helm; };
    return helm;
  };

  // ── fn.createPoseHelm ──────────────────────────────────────────────────────

  /**
   * Drive an object from a 6-DOF device: feed it translation and rotation
   * rates each frame and the bound target's position and rotation follow.
   * Bind a plain pose, a `p5.Camera` or any object with an `applyPose` method,
   * and choose with `from` whether pushes are screen-, world- or body-relative (see
   * the `SELF` example). Needs a `p5.WEBGL` canvas and a rate source such as a
   * SpaceMouse, a gamepad or a touch gesture.
   *
   * @details
   * Create a PoseHelm: integrate a live 6-DOF rate stream into a `{ pos, rot }`
   * pose and drive a bound target with it.
   *
   * Returns a stateful controller (like `createPoseTrack`), not a draw call.
   * Until a target is bound the player idles. `from` sets what manipulation is
   * relative to — the mapDirection convention (EYE | WORLD | SELF | a mat4). The
   * default `from: EYE` is screen-relative (EYE resolves against the VIEWING
   * camera), so a forward push moves the target away from the viewer regardless
   * of what the target is; `WORLD` integrates in world axes; `SELF` integrates
   * in the target's own evolving pose — body-relative, so a forward push follows
   * where the object currently points; a mat4 (e.g. a specific camera's
   * `cam.mat4Eye(buf)`) integrates in that fixed frame.
   *
   * ```js
   * const obj  = { pos: [0, 0, 0], rot: [0, 0, 0, 1] }
   * let helm
   * function setup() {
   *   createCanvas(720, 480, WEBGL)
   *   helm = createPoseHelm()
   *   helm.bind(obj)                       // mutate obj.pos / obj.rot in place
   * }
   * function draw() {
   *   background(10)
   *   helm.feed(translation, rotation)
   *   push(); applyPose(obj); box(80); pop()
   * }
   * ```
   *
   * `bind(target)` is polymorphic (dispatch by shape, no positional ambiguity):
   *
   * - `bind(cam)` — p5.Camera: seeded from its lookAt; driven via applyPose
   *   (manipulate the camera as an object).
   * - `bind({ get, set })` — accessor floor: get() seeds, set(pose) writes.
   * - `bind({ applyPose })` — any pose sink: applyPose(pose) each frame.
   * - `bind({ pos, rot })` — plain pose object: seeded from, mutated in place.
   *
   * The returned helm exposes the core surface (`feed`, `profile`, `deadzone`,
   * `from`, `home`, `eval`, `activity`) plus `bind(target)` and `dispose()`.
   * `opts.bind` binds immediately. Chainable: `createPoseHelm().bind(obj)`.
   * Null before `createCanvas()`.
   *
   * @function createPoseHelm
   * @memberof p5
   * @param {{ profile?: Object, deadzone?: number,
   *           from?: string | Float32Array | p5.Matrix,
   *           bind?: p5.Camera | Object }} [opts]
   * @returns {PoseHelm}
   * @example
   * <caption>from: EYE, the default: hold any key and steer with the mouse; the push is screen-relative whatever the orbit</caption>
   * let helm
   * const obj = { pos: [0, 0, 0], rot: [0, 0, 0, 1] }
   * const lin = [0, 0, 0], ang = [0, 0, 0]
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   helm = createPoseHelm().bind(obj)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   // a probe in place of a device: lane 0 is Tx, lane 2 is Ty
   *   const hold = keyIsPressed ? 1 : 0
   *   lin[0] = hold * 500 * (mouseX / width - 0.5) * 2
   *   lin[2] = hold * 500 * (mouseY / height - 0.5) * 2
   *   helm.feed(lin, ang)
   *   axes()
   *   push()
   *   applyPose(obj)
   *   stroke('white')
   *   fill('#ff4fd8')
   *   box(40)
   *   pop()
   * }
   * @example
   * <caption>from: SELF, body-relative: a swept forward push and yaw drive the box like a car</caption>
   * let helm
   * const obj = { pos: [0, 0, 0], rot: [0, 0, 0, 1] }
   * const lin = [0, 0, 0], ang = [0, 0, 0]
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   helm = createPoseHelm({ from: p5.Tree.SELF }).bind(obj)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   const t = millis() / 1000
   *   lin[1] = 250 * sin(t * 0.7)   // lane 1: Tz, forward and back
   *   ang[2] = 250 * sin(t * 0.4)   // lane 2: Ry, yaw
   *   helm.feed(lin, ang)
   *   if (Math.hypot(obj.pos[0], obj.pos[1], obj.pos[2]) > 160) {
   *     helm.home({ pos: [0, 0, 0], rot: [0, 0, 0, 1] })   // wandered off: back to the origin
   *   }
   *   axes()
   *   push()
   *   applyPose(obj)
   *   axes({ size: 40 })
   *   stroke('#ff4fd8')
   *   noFill()
   *   box(30)
   *   pop()
   * }
   */
  fn.createPoseHelm = function (opts) {
    const host = _hostOrWarn(this, 'createPoseHelm');
    if (!host) return null;
    const { bind, ...rest } = opts || {};
    const helm = host.poseHelm(rest);
    const hostBind = helm.bind;

    /**
     * Choose what the helm drives: a plain pose object, a `p5.Camera`, an
     * object with an `applyPose` method or a get/set accessor. The target's
     * current value seeds the helm so there is no jump on the first frame (see
     * the second camera example).
     * Chainable.
     *
     * @details
     * A p5.Camera binds as an accessor: get() is the camera's lookat as a pose
     * (`capturePose` then `cameraToPose`), set(pose) is `applyPose`'s TRS
     * branch, which keeps the camera's gaze distance. Every other shape is
     * the host's. An unrecognised target logs and leaves the helm unbound (the
     * player keeps idling). Chainable.
     *
     * @function bind
     * @memberof PoseHelm
     * @param {p5.Camera | { get: Function, set: Function } |
     *         { applyPose: Function } | { pos: number[], rot: number[] }} target
     * @returns {PoseHelm} this
     * @example
     * <caption>A second camera as the target: flown in world axes from a probe, shown as its frustum</caption>
     * let cam, helm
     * const lin = [0, 0, 0], ang = [0, 0, 0]
     *
     * function setup() {
     *   createCanvas(400, 300, WEBGL)
     *   camera(300, -200, 500, 0, 0, 0, 0, 1, 0)
     *   cam = createCamera()
     *   cam.camera(0, -60, 250, 0, 0, 0, 0, 1, 0)
     *   cam.perspective(PI / 4, width / height, 40, 300)
     *   helm = createPoseHelm({ from: p5.Tree.WORLD }).bind(cam)   // seeded from cam's lookat
     * }
     *
     * function draw() {
     *   background('#138D75')
     *   orbitControl()
     *   axes()
     *   stroke('white')
     *   noFill()
     *   box(60)
     *   const t = millis() / 1000
     *   lin[0] = 250 * sin(t * 0.7)   // lane 0: Tx, side to side
     *   ang[2] = 250 * sin(t * 0.4)   // lane 2: Ry, yaw
     *   helm.feed(lin, ang)
     *   stroke('#ffd166')
     *   viewFrustum({ camera: cam })
     * }
     */
    helm.bind = function (target) {
      if (target instanceof p5.Camera) {
        return hostBind({
          get: () => cameraToPose(_pose, target.capturePose(_cp)),
          set: (pose) => target.applyPose(pose),
        });
      }
      return hostBind(target);
    };

    const hostDispose = helm.dispose;
    helm.dispose = () => { hostDispose(); _releaseRig(helm); return helm; };

    if (bind != null) helm.bind(bind);
    return helm;
  };

  // ── fn.createHid ───────────────────────────────────────────────────────────

  /**
   * A SpaceMouse over WebHID: a stream of raw 6-DOF rates that feeds a helm
   * every frame once bound. Call `connect()` from a click or a key press to
   * choose the device; a device this page was already granted reattaches on
   * its own. Chromium-family browsers only, in a top-level page over https or
   * localhost — `available` says whether this page can ask at all,
   * `connected` whether a device is reporting. Needs a `p5.WEBGL` canvas.
   *
   * @details
   * The host's hid stream: `requestDevice` under the 3Dconnexion vendor
   * filters, reports decoded out of band into `lin` / `ang` (the
   * SpaceNavigator's two int16 little-endian reports, or one six-lane report),
   * the latest fed to the bound helm each predraw. `opts.filters` and
   * `opts.decode(report, reportId, lin, ang)` take another device. Inside an
   * iframe without `allow="hid"` the stream is unavailable and never prompts.
   * Disposed with the sketch.
   *
   * @function createHid
   * @memberof p5
   * @param {{ bind?: PoseHelm, filters?: Object[], decode?: Function, resume?: boolean }} [opts]
   * @returns {Object} The stream: `{ available, connected, lin, ang, connect(), bind(helm), unbind(), dispose() }`.
   * @example
   * <caption>Fly the camera from a SpaceMouse: click the canvas to connect; the rig shows the live lanes</caption>
   * let helm, hid
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   helm = createCameraHelm()
   *   hid = createHid({ bind: helm })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   axes()
   *   stroke('white')
   *   push()
   *   rotateX(HALF_PI)
   *   grid({ size: 400, subdivisions: 20 })
   *   pop()
   *   noStroke()
   *   fill('#ff4fd8')
   *   for (let i = 0; i < 6; i++) {
   *     push()
   *     translate(150 * cos(i * PI / 3), -20, 150 * sin(i * PI / 3))
   *     box(40)
   *     pop()
   *   }
   *   helmRig(helm, { x: width - 136, y: 16, size: 120 })
   *   const status = !hid.available ? 'WebHID unavailable here (top-level Chromium page)'
   *     : hid.connected ? 'connected: push the puck' : 'click to connect a SpaceMouse'
   *   treeHost().labels.setScreen('status', status, 10, 16, { anchor: 'left' })
   * }
   *
   * function mousePressed() {
   *   if (hid.available && !hid.connected) hid.connect()
   * }
   */
  fn.createHid = function (opts) {
    const host = _hostOrWarn(this, 'createHid');
    return host ? host.hid(opts) : null;
  };

  // ── fn.createGamepad ───────────────────────────────────────────────────────

  /**
   * A gamepad as a 6-DOF rate source: polled every frame, feeding a helm once
   * bound. The standard layout maps the left stick to slide and lift, the
   * right stick to yaw and pitch, the triggers to push; pass `map` for
   * another. A pad appears once the page has seen a button press on it.
   * Needs a `p5.WEBGL` canvas.
   *
   * @details
   * The host's gamepad stream over `navigator.getGamepads()`: `index` picks a
   * pad (default the first connected), `map` is `{ lin, ang }` with three lane
   * specs each — an axis index, `{ buttons: [neg, pos] }` or null. Axes are
   * ±1, so a helm profile tuned for a ±500 puck wants `sens` scaled and
   * `fullScale` set to 1 for honest rig meters. Disposed with the sketch.
   *
   * @function createGamepad
   * @memberof p5
   * @param {{ bind?: PoseHelm, index?: number, map?: Object }} [opts]
   * @returns {Object} The stream: `{ available, connected, index, lin, ang, bind(helm), unbind(), dispose() }`.
   * @example
   * <caption>Fly the camera from a gamepad: press any button on it first; the rig meters read the ±1 sticks</caption>
   * let helm, pad
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   helm = createCameraHelm({ fullScale: 1 })
   *   for (const k of ['Tx', 'Ty', 'Tz']) helm.profile[k].sens *= 500
   *   for (const k of ['Rp', 'Ry', 'Rr']) helm.profile[k].sens *= 500
   *   pad = createGamepad({ bind: helm })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   axes()
   *   stroke('white')
   *   push()
   *   rotateX(HALF_PI)
   *   grid({ size: 400, subdivisions: 20 })
   *   pop()
   *   noStroke()
   *   fill('#ff4fd8')
   *   for (let i = 0; i < 6; i++) {
   *     push()
   *     translate(150 * cos(i * PI / 3), -20, 150 * sin(i * PI / 3))
   *     box(40)
   *     pop()
   *   }
   *   helmRig(helm, { x: width - 136, y: 16, size: 120 })
   *   const status = !pad.available ? 'no Gamepad API here' : pad.connected ? 'gamepad connected' : 'press a gamepad button'
   *   treeHost().labels.setScreen('status', status, 10, 16, { anchor: 'left' })
   * }
   */
  fn.createGamepad = function (opts) {
    const host = _hostOrWarn(this, 'createGamepad');
    return host ? host.gamepad(opts) : null;
  };

  // ── helmRig (gizmo) ─────────────────────────────────────────────────────────

  fn.helmRig = function (helm, opts) { this._renderer.helmRig(helm, opts); return this; };

  /**
   * Draw a control rig showing a helm's six degrees of freedom: translation
   * arrows and rotation rings, with the channel being driven lit up in the
   * direction of the push. Give `x` and `y` for a corner HUD, or draw it in the
   * scene at the driven object; add `identify` to label each input channel with
   * DOM text over the canvas, no font needed. Needs a `p5.WEBGL` canvas.
   *
   * @details
   * Visualise a PoseHelm's DOF profile and live activity as a control rig —
   * three translation arrows (Tx / Ty / Tz) and three rotation rings (pitch /
   * yaw / roll). Each channel draws a DIM baseline whose geometry IS the profile
   * readout (arrow direction = `sign`, arrow length / ring radius = `sens`
   * relative to the canonical defaults 0.30 translation, 0.0025 rotation), and
   * the channel driven this frame overlays a BRIGHT element growing in the live
   * SIGNED direction (push vs pull) with length / arc proportional to magnitude,
   * in its semantic axis colour (X red, Y lime, Z blue). Push a physical axis and
   * watch which DOF moves and which way — the lane→DOF mapping read by doing.
   *
   * Two forms:
   *
   * ```js
   * helmRig(helm, { size, bits, identify })   // in-scene rig
   * helmRig(helm, { x, y, size, tilt })       // FBO-backed HUD overload
   * ```
   *
   * In-scene — drawn at the current model transform, oriented to the helm's
   * resolved `from` (WORLD → world axes, EYE → screen, SELF → the object's own
   * frame) so the arrows point where pushes actually go. The caller supplies
   * POSITION (translate to the driven object); the rig owns the ROTATION — do
   * NOT applyPose the object before it. The colours are intrinsic (they carry
   * the active-DOF signal), so ambient `stroke()` does not tint it.
   *
   * HUD overload — when `x` and `y` are given, the rig is rendered into a small
   * framebuffer through its own ortho camera and composited as a screen quad at
   * `(x, y)` of `size` pixels. Because it lands as a TEXTURE, ambient `tint()`
   * modulates it (the `viewFrustum` textured-plane path). Intended for camera
   * fly — it shows the body DOFs in a corner. `tilt` aims that camera: the
   * elevation above the rig's horizontal, in the sketch's `angleMode` unit,
   * azimuth fixed at the isometric 45° (default true iso ≈ 35.26°; `tilt: 0` is
   * level; `tilt: [az, el]` sets both). The framebuffer is created lazily and
   * cached on the helm, re-made only when `size` changes; `tilt` only re-aims.
   *
   * Bits (in-scene; default TRANSLATE | ROTATE):
   *
   * - {@link TRANSLATE} — the three translation arrows along ±X / ±Y / ±Z.
   * - {@link ROTATE} — the three rotation rings (pitch ⊥X, yaw ⊥Y, roll ⊥Z).
   *
   * `identify: true` (in-scene) labels each arrow / ring with its input lane
   * index ('L0' …) — the fed channel that drives that DOF — for wiring up a new
   * transport. The labels are DOM text on the host's label layer (`treeHost().labels`,
   * class `helm-rig` for CSS), projected each frame at the arrow tips and ring
   * rims; they live only while the rig draws.
   *
   * @function helmRig
   * @memberof p5
   * @param {PoseHelm} helm
   * @param {{ size?: number, bits?: number, identify?: boolean,
   *           x?: number, y?: number, tilt?: number | number[] }} [opts]
   * @param {number} [opts.size=100]  Rig extent — world units in-scene, pixels (default 120) in the HUD overload.
   * @param {number} [opts.bits=TRANSLATE | ROTATE]
   * @param {boolean} [opts.identify=false]
   * @returns {p5} this
   * @example
   * <caption>In-scene at the driven object: dim baselines are the profile, bright overlays the live push</caption>
   * let helm
   * const obj = { pos: [0, 0, 0], rot: [0, 0, 0, 1] }
   * const lin = [0, 0, 0], ang = [0, 0, 0]
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   camera(200, -150, 300, 0, 0, 0, 0, 1, 0)
   *   helm = createPoseHelm({ from: p5.Tree.WORLD }).bind(obj)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   const t = millis() / 1000
   *   lin[1] = 250 * sin(t * 0.9)   // lane 1: Tz
   *   ang[2] = 250 * sin(t * 0.9)   // lane 2: Ry
   *   helm.feed(lin, ang)
   *   axes()
   *   push()
   *   applyPose(obj)
   *   stroke('white')
   *   fill('#ff4fd8')
   *   box(30)
   *   pop()
   *   push()
   *   translate(obj.pos[0], obj.pos[1], obj.pos[2])   // position is ours, the rig owns the rotation
   *   helmRig(helm, { size: 80 })
   *   pop()
   * }
   * @example
   * <caption>identify: each arrow and ring names its input lane in DOM text; lanes 1 and 2 are the ones fed</caption>
   * let helm
   * const obj = { pos: [0, 0, 0], rot: [0, 0, 0, 1] }
   * const lin = [0, 0, 0], ang = [0, 0, 0]
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   camera(200, -150, 300, 0, 0, 0, 0, 1, 0)
   *   helm = createPoseHelm({ from: p5.Tree.WORLD }).bind(obj)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   const t = millis() / 1000
   *   lin[1] = 250 * sin(t * 0.9)   // lane 1: Tz
   *   ang[2] = 250 * cos(t * 0.9)   // lane 2: Ry
   *   helm.feed(lin, ang)
   *   axes()
   *   push()
   *   translate(obj.pos[0], obj.pos[1], obj.pos[2])
   *   helmRig(helm, { size: 80, identify: true })
   *   pop()
   * }
   * @example
   * <caption>The HUD overload: a corner readout through its own camera; tilt: 0 aims it head-on</caption>
   * let helm
   * const obj = { pos: [0, 0, 0], rot: [0, 0, 0, 1] }
   * const lin = [0, 0, 0], ang = [0, 0, 0]
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   helm = createPoseHelm({ from: p5.Tree.WORLD }).bind(obj)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   const t = millis() / 1000
   *   lin[0] = 250 * sin(t * 0.9)   // lane 0: Tx
   *   ang[0] = 250 * cos(t * 0.9)   // lane 0: Rp, pitch
   *   helm.feed(lin, ang)
   *   axes()
   *   push()
   *   applyPose(obj)
   *   stroke('white')
   *   fill('#ff4fd8')
   *   box(30)
   *   pop()
   *   helmRig(helm, { x: width - 136, y: 16, size: 120, tilt: 0 })
   * }
   */
  p5.Renderer3D.prototype.helmRig = function (helm, opts = {}) {
    const p = this._pInst;
    if (!p || !helm) return;

    // HUD overload — { x, y, size }: render the rig into a small FBO and
    // composite it as a textured screen quad, so ambient tint() modulates it.
    if (opts.x != null && opts.y != null) {
      const x = opts.x, y = opts.y, size = opts.size ?? 120;

      // Lazy FBO + dedicated ortho camera, cached on the helm (user-owned
      // cache). The rig is drawn at a fixed world reference; the FBO frames it
      // through this camera, aimed by `tilt` (elevation; azimuth fixed iso). The
      // FBO is rebuilt only when `size` changes; `tilt` only re-aims the camera.
      // createCamera() must run inside begin()/end().
      const RR = 100, d = RR * 2.4;
      const [_az, _el] = _rigAzEl(p, opts.tilt);
      const tiltKey = `${_az.toFixed(5)}:${_el.toFixed(5)}`;
      if (helm._rigFbo == null || helm._rigFboSize !== size) {
        _releaseRig(helm);
        helm._rigFbo     = p.createFramebuffer({ width: size, height: size });
        helm._rigFboSize = size;
        helm._rigFbo.begin();
        helm._rigCam = helm._rigFbo.createCamera();
        helm._rigCam.ortho(-RR * 0.9, RR * 0.9, -RR * 0.9, RR * 0.9, 0.1, d * 4);
        helm._rigFbo.end();
        helm._rigTiltKey = null;   // force a re-aim after a (re)build
      }
      if (helm._rigTiltKey !== tiltKey) {
        const ce = Math.cos(_el), se = Math.sin(_el), ca = Math.cos(_az), sa = Math.sin(_az);
        helm._rigFbo.begin();
        helm._rigCam.camera(d * ce * sa, -d * se, d * ce * ca, 0, 0, 0, 0, 1, 0);
        helm._rigFbo.end();
        helm._rigTiltKey = tiltKey;
      }

      // Render the rig into the FBO (transparent bg, the tilt-aimed view). A
      // p5.Framebuffer leaves the renderer's ACTIVE camera + matrices pointing
      // at the FBO's own camera after end(), so capture and restore curCamera
      // (plus uPMatrix / uViewMatrix) around the pass — otherwise a live
      // (driven) camera is corrupted for the next frame. setCamera() inside
      // begin() needs resetMatrix() to take effect.
      const states  = this.states;
      const prevCam = states.curCamera;
      const savP    = states.uPMatrix.copy();
      const savV    = states.uViewMatrix.copy();
      helm._rigFbo.begin();
      p.setCamera(helm._rigCam);
      p.resetMatrix();
      p.clear();
      p.push();
      _drawRig(p, helm, 100, true, true, false);
      p.pop();
      helm._rigFbo.end();
      if (prevCam) p.setCamera(prevCam);
      states.uPMatrix.set(savP);
      states.uViewMatrix.set(savV);

      // Composite the framebuffer as a screen image in HUD space — image()
      // draws it right-side-up and honours ambient tint() (the proven
      // viewFrustum HUD path), so tint() modulates the rig even though it is
      // built from raw strokes.
      this.beginHUD();
      p.image(helm._rigFbo, x, y, size, size);
      this.endHUD();
      return;
    }

    // In-scene rig — oriented to the resolved `from` so the arrows point where
    // pushes go (WORLD → world axes; EYE → the viewing camera, read from the
    // view bag refreshed here, after the orbit; SELF → the helm's own pose).
    // Position is the caller's (translate before); the rig owns the rotation,
    // so the object is NOT applyPose'd before it.
    const {
      size     = 100,
      bits     = p5.Tree.TRANSLATE | p5.Tree.ROTATE,
      identify = false,
    } = opts;
    const doT = (bits & p5.Tree.TRANSLATE) !== 0;
    const doR = (bits & p5.Tree.ROTATE)    !== 0;

    p.push();
    const host  = syncHostView(p);
    const basis = helmBasis(helm, host ? host.view : null, _em);   // null for WORLD
    if (basis) { qFromMat4(_rigQ, basis); this.rotateQuat(_rigQ); }
    _drawRig(p, helm, size, doT, doR, identify);
    p.pop();
  };
}
