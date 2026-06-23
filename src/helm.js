/**
 * @file Source-agnostic 6-DOF pose helm — p5 bridge factories + activity gizmo.
 * @module p5.tree/helm
 * @license AGPL-3.0-only
 *
 * Wraps the renderer-agnostic `PoseHelm` (`@nakednous/tree/helm`) with the
 * p5-specific wiring a live rate-driven controller needs: the draw-loop player
 * that integrates each frame, the basis resolution against a p5 camera (a pose
 * helm's `from`, or a camera helm's body-fly frame), the seed that aligns the
 * integrated pose with a live camera, and a diagnostic gizmo. Constructed like
 * a track (`createCameraHelm` / `createPoseHelm` → stateful controller); the
 * gizmo (`helmRig`) is consumed like every other gizmo.
 *
 * ── Family placement ─────────────────────────────────────────────────────────
 * `PoseHelm : CameraHelm :: PoseTrack : CameraTrack` — ONE core class, TWO
 * bridge factories. As with the track factories, neither factory is a wrapper
 * class: each builds a core `PoseHelm`, registers a draw-loop player (the same
 * registry `createCameraTrack` uses — players tick in predraw, torn down by the
 * remove lifecycle), and attaches the bridge-only `bind` / `dispose` seams.
 *
 *   createCameraHelm([cam][, opts])  fly `cam` from the stream (body-relative).
 *   createPoseHelm([opts]) + bind()  produce a pose, drive any target with it
 *                                     (screen-relative manipulation).
 *
 * ── Layering ─────────────────────────────────────────────────────────────────
 * The numeric core integrates a rate into a `{ pos, rot }` pose in ONE frame
 * and never learns about a camera. This bridge supplies the per-step `basis`
 * (an eye→world mat4): a camera helm's own driven-camera frame (body-fly), or a
 * pose helm's resolved `from` (WORLD | EYE | SELF | mat4). It then feeds the
 * pose to a target via `applyPose`. Nothing here re-implements the integration,
 * the quaternion algebra, or matrix math — it only moves numbers across the
 * boundary.
 *
 * ── `from` → basis resolution (the one camera-aware step) ────────────────────
 * The two factories resolve the integration basis differently — and that IS the
 * difference between the two manipulation conventions:
 *
 *   createCameraHelm — ALWAYS body-fly, no `from`. The basis is the DRIVEN
 *                      camera's own eye matrix, which equals the pose this helm
 *                      wrote last frame (zero staleness; the lookAt round-trip
 *                      is exact for proper rotations), so a forward push flies
 *                      forward. A camera *is* the frame it flies in.
 *   createPoseHelm   — has `from` (the pose-helm frame). The bridge resolves it
 *                      into the `basis` the core's `step` consumes:
 *
 *                        WORLD   → null             the identity basis.
 *                        EYE     → cam.mat4Eye(_em) the VIEWING camera
 *                                                   (`getCamera()`, re-read each
 *                                                   frame) ⇒ screen-relative.
 *                        SELF    → qToMat4(_em,rot) the helm's OWN current pose
 *                                                   rotation ⇒ body-relative
 *                                                   (the object analogue of
 *                                                   camera body-fly).
 *                        <mat4>  → _rawMat4(from)   an explicit fixed frame
 *                                                   (p5.Matrix | Float32Array).
 *
 *                      `from` is mapDirection's convention, narrowed to frames
 *                      with a rotation basis (SCREEN / NDC / MODEL rejected) and
 *                      never a p5.Camera value — a specific camera enters as
 *                      `cam.mat4Eye(buf)`.
 *
 * ── Seeding ──────────────────────────────────────────────────────────────────
 * Driving a live camera (or binding one as a target) seeds the integrated pose
 * from the camera's current lookAt so frame 0 doesn't jump: `pos ← eye`,
 * `rot ← qFromLookDir(center − eye, up)`. With EYE, the seeded `rot` then equals
 * the camera's own eye-matrix rotation, which is exactly the body-relative
 * invariant the zero-staleness argument needs.
 */

'use strict';

import { PoseHelm, qFromLookDir, qToMat4, qFromMat4 } from '@nakednous/tree';
import { registerPlayer, unregisterPlayer } from './track.js';

// ═══════════════════════════════════════════════════════════════════════════
// Module-level scratch — synchronous, single-threaded, never returned
// ═══════════════════════════════════════════════════════════════════════════
//
// A player's tick() and a gizmo draw run to completion within one frame with no
// reentrancy across helms, so shared scratch is safe — the same discipline as
// gizmos.js (_sl/_wl) and handle.js (_pW/_aW).

const _pose  = { pos: [0, 0, 0], rot: [0, 0, 0, 1] };  // step() output → applyPose() input
const _em    = new Float32Array(16);                   // resolved eye→world basis
const _cp    = {                                       // capturePose() scratch (camera seed)
  eye: [0, 0, 0], center: [0, 0, 0], up: [0, 1, 0],
  fov: null, halfHeight: null, near: 0.1, far: 1000,
};
const _qhome = [0, 0, 0, 1];                            // seed orientation
const _fwd   = [0, 0, 0];                               // center − eye (look direction)
const _act   = [0, 0, 0, 0, 0, 0];                      // helm.activity() readout (gizmo)
const _self  = { pos: [0, 0, 0], rot: [0, 0, 0, 1] };  // helm.eval() readout (SELF basis / rig)
const _rigQ  = [0, 0, 0, 1];                            // resolved-`from` rotation (rig orient)

// Semantic per-axis colours — X / Y / Z, matching gizmos.js _AXIS_COLORS
// (Red / Lime / DodgerBlue). RGB triples so the idle state can dim via alpha.
const _HELM_RGB = [[255, 0, 0], [0, 255, 0], [30, 144, 255]];

const _rawMat4 = (m) => (m != null && m.mat4 != null) ? m.mat4 : m;

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

// ── Helpers (camera-aware, but core-agnostic) ───────────────────────────────

// Apply the opts a factory accepts onto a fresh helm. Profile / deadzone are
// public, mutable fields — opts is sugar for setting them at construction.
// `from` is NOT here: it is pose-helm-only, applied by createPoseHelm (a camera
// helm is always body-fly).
function _applyOpts(helm, opts) {
  if (!opts) return;
  if (opts.profile)         helm.profile  = opts.profile;
  if (opts.deadzone != null) helm.deadzone = opts.deadzone;
}

// Resolve a pose helm's `from` → the eye→world basis step() consumes. `from` is
// mapDirection's convention, narrowed to frames with a rotation basis: EYE (the
// viewing camera), WORLD (the identity basis), SELF (the helm's OWN current pose
// rotation — body-relative, the object analogue of camera body-fly), or an
// explicit mat4. SELF reads helm.eval().rot each call and rebuilds it as a
// rotation matrix — equivalent to a per-frame pose mat4. SCREEN / NDC
// (projective) and MODEL (the live model matrix, not the helm's frame) carry no
// such basis and fall back to WORLD with a diagnostic. Returns null (identity)
// for WORLD, an absent viewing camera, or a singular eye matrix.
//
// A camera helm never calls this — it is always body-fly, integrating in the
// driven camera's own eye matrix.
function _resolveFrom(helm, viewCam, em) {
  const from = helm.from;
  if (from != null && typeof from !== 'string') return _rawMat4(from);   // explicit frame
  if (from === 'EYE')  return viewCam ? viewCam.mat4Eye(em) : null;       // viewing camera
  if (from === 'SELF') return qToMat4(em, helm.eval(_self).rot);          // the helm's own pose
  if (from === 'WORLD' || from == null) return null;                     // identity basis
  console.error('[p5.tree] createPoseHelm: `from` must be EYE, WORLD, SELF, or a mat4 frame — the mapDirection convention, minus the projective spaces (SCREEN / NDC) and MODEL, which carry no rotation basis. Falling back to WORLD.');
  return null;                                                           // unknown space
}

// Seed the helm's integrated pose from a live camera's lookAt, so frame 0 is
// continuous with the camera and (under EYE) the seeded rot equals the camera's
// eye-matrix rotation. Reads through capturePose for the real up hint.
function _seedHelmFromCamera(helm, cam) {
  cam.capturePose(_cp);
  _fwd[0] = _cp.center[0] - _cp.eye[0];
  _fwd[1] = _cp.center[1] - _cp.eye[1];
  _fwd[2] = _cp.center[2] - _cp.eye[2];
  qFromLookDir(_qhome, _fwd, _cp.up);
  helm.home({ pos: _cp.eye, rot: _qhome });
}

// Frame dt in seconds, clamped to 50 ms so a stalled tab can't teleport the
// pose on the catch-up frame (matches the e7 reference integrator).
const _dtOf = (pInst) => Math.min((pInst.deltaTime || 16) / 1000, 0.05);

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
  const ACT_FULL = 500;        // raw rate ≈ full deflection (the e7/e8 HUD reference)
  const ARC_FULL = Math.PI;    // a full push sweeps half the ring

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
        const lp = [0, 0, 0]; lp[ax] = L + ch.sign * head * 1.5;
        p.text('L' + ch.lane, lp[0], lp[1], lp[2]);
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
        const aa = (ax + 1) % 3;
        const lp = [0, 0, 0]; lp[aa] = r;
        p.text('L' + ch.lane, lp[0], lp[1], lp[2]);
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
   * Create a CameraHelm: fly a p5.Camera from a live 6-DOF rate stream.
   *
   * Returns a stateful controller (like `createCameraTrack`), not a draw call.
   * The bound camera is seeded from its current lookAt (frame 0 is continuous)
   * and re-driven every frame from the latest `feed()`. The stream is always
   * body-relative — a forward push flies forward — because the helm integrates
   * in the driven camera's own (zero-staleness) eye matrix. There is no `from`:
   * a camera helm *is* the frame it flies in. (For screen- or world-relative
   * camera motion, bind the camera to a `createPoseHelm` instead.)
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
   * `home`, `eval`, `activity`) plus `dispose()` to unregister.
   *
   * @method createCameraHelm
   * @for p5
   * @param {p5.Camera | Object} [cam]  Camera to drive, or the opts object.
   *                                    Defaults to the current camera.
   * @param {{ profile?: Object, deadzone?: number }} [opts]
   * @returns {PoseHelm}
   */
  fn.createCameraHelm = function (cam, opts) {
    const pInst = this;
    // Arg juggle: createCameraHelm(opts) / createCameraHelm() — first arg is the
    // opts object (or absent) when it isn't a camera.
    if (cam && !(cam instanceof p5.Camera)) { opts = cam; cam = null; }
    cam = cam ?? this.getCamera() ?? null;
    if (!cam) {
      console.error('[p5.tree] createCameraHelm: no camera available — call after createCanvas() or pass a p5.Camera.');
    }

    if (opts && opts.from != null) {
      console.error('[p5.tree] createCameraHelm: a camera helm is always body-fly and has no `from` — it integrates in the frame of the driven camera. Ignoring `from`; bind the camera to a createPoseHelm for screen- or world-relative motion.');
    }

    const helm = new PoseHelm();
    _applyOpts(helm, opts);
    if (cam) _seedHelmFromCamera(helm, cam);

    // Continuous player — integrates and re-drives the camera every predraw.
    // Body-fly: the basis is the driven camera's own eye matrix (which equals
    // the pose written last frame ⇒ zero staleness), so a body delta composes
    // body-relative. Always returns true (a helm has no playing/stopped state);
    // torn down by dispose() or the remove lifecycle (clearPlayers).
    const player = {
      tick() {
        helm.step(_pose, _dtOf(pInst), cam ? cam.mat4Eye(_em) : null);
        if (cam) cam.applyPose(_pose);   // { pos, rot } → lookAt at constant gaze distance
        return true;
      },
    };
    registerPlayer(pInst, player);

    helm.dispose = function () {
      unregisterPlayer(pInst, player);
      if (helm._rigFbo && typeof helm._rigFbo.remove === 'function') { helm._rigFbo.remove(); helm._rigFbo = null; }
      return helm;
    };
    return helm;
  };

  // ── fn.createPoseHelm ──────────────────────────────────────────────────────

  /**
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
   *   bind(cam)               p5.Camera — seeded from its lookAt; driven via
   *                           applyPose (manipulate the camera as an object).
   *   bind({ get, set })      accessor floor — get() seeds, set(pose) writes.
   *   bind({ applyPose })     any pose sink — applyPose(pose) each frame.
   *   bind({ pos, rot })      plain pose object — seeded from, mutated in place.
   *
   * The returned helm exposes the core surface (`feed`, `profile`, `deadzone`,
   * `from`, `home`, `eval`, `activity`) plus `bind(target)` and `dispose()`.
   * `opts.bind` binds immediately. Chainable: `createPoseHelm().bind(obj)`.
   *
   * @method createPoseHelm
   * @for p5
   * @param {{ profile?: Object, deadzone?: number,
   *           from?: string | Float32Array | p5.Matrix,
   *           bind?: p5.Camera | Object }} [opts]
   * @returns {PoseHelm}
   */
  fn.createPoseHelm = function (opts) {
    const pInst = this;
    const helm  = new PoseHelm();
    _applyOpts(helm, opts);
    if (opts && opts.from != null) helm.from = opts.from;   // pose-helm frame (EYE | WORLD | SELF | mat4)

    let sink = null;   // (pose) => void — set by bind()

    // Continuous player — idles until bound, then integrates in the resolved
    // `from` frame (EYE re-reads the VIEWING camera each frame; SELF re-reads
    // the helm's own pose) and pushes the pose to the sink.
    const player = {
      tick() {
        if (sink) {
          helm.step(_pose, _dtOf(pInst), _resolveFrom(helm, pInst.getCamera(), _em));
          sink(_pose);
        }
        return true;
      },
    };
    registerPlayer(pInst, player);

    /**
     * Bind a target the helm drives while running. Polymorphic; see the factory
     * docs for the four accepted shapes. Seeds the integrated pose from the
     * target's current value where one is readable (camera / accessor / plain
     * pose) so there's no frame-0 jump. An unrecognised target logs and leaves
     * the helm unbound (the player keeps idling). Chainable.
     *
     * @param {p5.Camera | { get: Function, set: Function } |
     *         { applyPose: Function } | { pos: number[], rot: number[] }} target
     * @returns {PoseHelm} this
     */
    helm.bind = function (target) {
      if (target instanceof p5.Camera) {
        _seedHelmFromCamera(helm, target);
        sink = (pose) => target.applyPose(pose);
      } else if (target && typeof target.get === 'function' && typeof target.set === 'function') {
        helm.home(target.get());
        sink = (pose) => target.set(pose);
      } else if (target && typeof target.applyPose === 'function') {
        sink = (pose) => target.applyPose(pose);   // pose-only sink — nothing to seed from
      } else if (target && target.pos && target.rot) {
        helm.home(target);
        sink = (pose) => {
          target.pos[0] = pose.pos[0]; target.pos[1] = pose.pos[1]; target.pos[2] = pose.pos[2];
          target.rot[0] = pose.rot[0]; target.rot[1] = pose.rot[1];
          target.rot[2] = pose.rot[2]; target.rot[3] = pose.rot[3];
        };
      } else {
        console.error('[p5.tree] createPoseHelm: bind() target must be a p5.Camera, an { applyPose } sink, a { get, set } accessor, or a { pos, rot } object. Leaving unbound.');
      }
      return helm;
    };

    helm.dispose = function () {
      unregisterPlayer(pInst, player);
      if (helm._rigFbo && typeof helm._rigFbo.remove === 'function') { helm._rigFbo.remove(); helm._rigFbo = null; }
      return helm;
    };

    if (opts && opts.bind != null) helm.bind(opts.bind);
    return helm;
  };

  // ── helmRig (gizmo) ─────────────────────────────────────────────────────────

  fn.helmRig = function (helm, opts) { this._renderer.helmRig(helm, opts); return this; };

  /**
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
   *   helmRig(helm, { size, bits, identify })   // in-scene rig
   *   helmRig(helm, { x, y, size, tilt })       // FBO-backed HUD overload
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
   *   TRANSLATE — the three translation arrows along ±X / ±Y / ±Z.
   *   ROTATE    — the three rotation rings (pitch ⊥X, yaw ⊥Y, roll ⊥Z).
   *
   * `identify: true` (in-scene) labels each arrow / ring with its input lane
   * index ('L0' …) — the fed channel that drives that DOF — for wiring up a new
   * transport. Requires a font (textFont(...)); p5 draws no text without one.
   *
   * @method helmRig
   * @for p5
   * @param {PoseHelm} helm
   * @param {{ size?: number, bits?: number, identify?: boolean,
   *           x?: number, y?: number, tilt?: number | number[] }} [opts]
   * @returns {p5} this
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
        if (helm._rigFbo && typeof helm._rigFbo.remove === 'function') helm._rigFbo.remove();
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
    // pushes go (WORLD → world axes; EYE → the viewing camera; SELF → the helm's
    // own pose). Position is the caller's (translate before); the rig owns the
    // rotation, so the object is NOT applyPose'd before it.
    const {
      size     = 100,
      bits     = p5.Tree.TRANSLATE | p5.Tree.ROTATE,
      identify = false,
    } = opts;
    const doT = (bits & p5.Tree.TRANSLATE) !== 0;
    const doR = (bits & p5.Tree.ROTATE)    !== 0;

    p.push();
    const basis = _resolveFrom(helm, p.getCamera(), _em);   // null for WORLD
    if (basis) { qFromMat4(_rigQ, basis); this.rotateQuat(_rigQ); }
    _drawRig(p, helm, size, doT, doR, identify);
    p.pop();
  };
}
