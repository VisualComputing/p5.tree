/**
 * @file p5 bridge for the ui/ package (createUI, createTrackUI).
 * @module p5.tree/ui
 * @license GPL-3.0-only
 *
 * This thin bridge does three things per UI type:
 *   1. Resolves p5-specific types (p5.Element → DOM, shader → setUniform wrapper).
 *   2. Mounts the UI container into the canvas parent by default.
 *   3. Registers a persistent player so tick() is called every frame.
 *
 * For createUI specifically, the bridge intercepts opt.target:
 *   - p5 shader (has .setUniform) → wrapped as (name, value) => shader.setUniform(name, value)
 *   - function or { set } object  → passed through unchanged
 *
 * createTrackUI camera resolution for the + button:
 *
 *   CameraTrack  → track.camera (set by createTrack), no option needed.
 *   PoseTrack    → opt.camera if provided, else curCamera, else null (no + button).
 *   opt.camera === null → explicitly suppress + button for either track type.
 *
 * w.add behaviour:
 *   CameraTrack  → track.add(cam.capturePose())  —  records { eye, center, up }
 *   PoseTrack    → track.add({ pos: _centerAtDepth(depth), rot: { eye, center, up } })
 *                  position is the frustum-centre world point at the depth slider value;
 *                  rotation is derived from the current camera orientation.
 *                  This is the inverse of the old behaviour that silently gave pos:[0,0,0].
 */

// TODO: unify createUI and createTrackUI onto createPanel (task 2)

'use strict';

import { createUI as _createUI, createTrackUI as _trackUI } from '@nakednous/ui';
import {
  NDC, WORLD,
  mapLocation as coreMapLocation,
  mat4Mul, mat4Invert,
} from '@nakednous/tree';
import { registerPlayer, unregisterPlayer } from './track.js';
import { CameraTrack } from '@nakednous/tree';

// ── Module-level scratch (allocated once at import time) ──────────────────────

const _sc_pv  = new Float32Array(16);  // proj * view
const _sc_ipv = new Float32Array(16);  // inv(proj * view)
const _sc_v3  = new Float32Array(3);   // scratch 3-vector

// ── Shared parent resolution ──────────────────────────────────────────────────

/**
 * Resolve the mount parent for a UI.
 * Priority: explicit opt.parent → canvas container → document.body.
 * Unwraps p5.Element to its raw HTMLElement.
 * @param {p5} pInst
 * @param {HTMLElement|p5.Element|undefined} parent
 * @returns {HTMLElement}
 */
function _resolveParent(pInst, parent) {
  if (parent) {
    return (parent.elt !== undefined) ? parent.elt : parent;   // unwrap p5.Element
  }
  return (pInst._renderer && pInst._renderer.canvas)
    ? pInst._renderer.canvas.parentElement
    : document.body;
}

// ── Depth helpers ─────────────────────────────────────────────────────────────

/**
 * Detect NDC Z minimum from the renderer's drawing context.
 * Returns −1 for WebGL, 0 for WebGPU.
 * @param {Object} renderer
 * @returns {number}
 */
function _ndcZMin(renderer) {
  if (renderer.drawingContext &&
      typeof WebGL2RenderingContext !== 'undefined' &&
      renderer.drawingContext instanceof WebGL2RenderingContext) return -1;
  return 0;
}

/**
 * Unproject the frustum centre at parametric depth d [0..1] into world space.
 * d=0 → near plane centre,  d=1 → far plane centre.
 *
 * Returns a plain [x, y, z] array, or null if renderer state is unavailable.
 *
 * @param {p5} pInst
 * @param {number} d  Depth in [0..1].
 * @returns {number[]|null}
 */
function _centerAtDepth(pInst, d) {
  const renderer = pInst._renderer;
  if (!renderer || !renderer.states) return null;
  const proj = renderer.states.uPMatrix?.mat4;
  const view = renderer.states.curCamera?.cameraMatrix?.mat4;
  if (!proj || !view) return null;
  const ndcMin = _ndcZMin(renderer);
  const ndcZ   = ndcMin + d * (1 - ndcMin);
  mat4Mul(_sc_pv, proj, view);
  if (!mat4Invert(_sc_ipv, _sc_pv)) return null;
  coreMapLocation(_sc_v3, 0, 0, ndcZ, NDC, WORLD, { ipv: _sc_ipv }, [0, 0, 1, 1], ndcMin);
  return [_sc_v3[0], _sc_v3[1], _sc_v3[2]];
}

// ── createTrackUI helpers ─────────────────────────────────────────────────────

/**
 * Wrap a track with camera apply logic for the UI.
 *
 * For CameraTrack: apply is already wired internally in createTrack.
 * The UI wrapper handles snap (1-kf), seek-while-stopped, and + button capture.
 * Depth slider is hidden (not relevant for camera tracks).
 *
 * For PoseTrack: + button adds a keyframe whose position is the frustum-centre
 * world point at the current depth slider value, and whose rotation is derived
 * from the current camera orientation.  This gives meaningful keyframes when
 * using a PoseTrack to animate objects through the scene.
 *
 * @param {CameraTrack|PoseTrack} track
 * @param {p5.Camera|null} cam
 * @param {boolean} isCameraTrack
 * @param {p5} pInst  Required for _centerAtDepth on PoseTrack.
 * @returns {Object}  duck-typed target for _trackUI
 */
function _wrapTrack(track, cam, isCameraTrack, pInst) {
  // Scratch for snap/seek apply — shape matches track type
  const _snapOut = isCameraTrack
    ? { eye:[0,0,0], center:[0,0,0], up:[0,1,0] }
    : { pos:[0,0,0], rot:[0,0,0,1], scl:[1,1,1] };

  // Scratch for PoseTrack + button capture (allocated once per UI creation)
  const _captureOut = { eye:[0,0,0], center:[0,0,0], up:[0,1,0] };

  function _applySnap() {
    if (cam && track.keyframes.length > 0) cam.applyPose(track.eval(_snapOut));
  }

  // Chain onEnd so the final keyframe is applied when playback ends naturally.
  const _prevOnEnd = track.onEnd;
  track.onEnd = function (t) {
    if (typeof _prevOnEnd === 'function') { try { _prevOnEnd(t); } catch (_) {} }
    _applySnap();
  };

  const w = {
    get playing() { return track.playing; },
    play: (o) => {
      track.play(o);
      // 1-KF snap: play() sets cursor but leaves playing=false.
      if (!track.playing && track.keyframes.length === 1) _applySnap();
    },
    stop:  ()  => track.stop(),
    seek:  (t) => { track.seek(t); _applySnap(); },
    time:  ()  => track.time(),
  };
  if (typeof track.reset === 'function') w.reset = () => track.reset();
  if (typeof track.info  === 'function') w.info  = () => track.info();

  // + button capture — behaviour differs by track type
  if (cam !== null && typeof track.add === 'function') {
    if (isCameraTrack) {
      // Camera track: record the exact lookat pose
      w.add = () => track.add(cam.capturePose());
    } else {
      // Pose track: position = frustum-centre world point at depth d,
      // rotation = camera orientation at capture time.
      w.add = (d) => {
        const pos = _centerAtDepth(pInst, typeof d === 'number' ? d : 0.5) || [0, 0, 0];
        cam.capturePose(_captureOut);
        track.add({
          pos,
          rot: { eye: _captureOut.eye, center: _captureOut.center, up: _captureOut.up },
        });
      };
    }
  }

  return w;
}

// ── installUI ─────────────────────────────────────────────────────────────────

/**
 * Install fn.createUI and fn.createTrackUI.
 * @param {p5} p5  The p5 constructor.
 * @param {Object} fn  p5 prototype.
 */
export function installUI(p5, fn) {

  // ── createUI ───────────────────────────────────────────────────────────────
  /**
   * Create a parameter panel and auto-tick it every frame.
   *
   * Schema keys map to control names. Controls are sliders, checkboxes, color
   * pickers, dropdowns, or buttons — inferred from the value type, or set
   * explicitly via `cfg.type`.
   *
   * `target` accepts:
   *   - a p5 shader (anything with `.setUniform`) — values are pushed via setUniform
   *   - a plain function `(name, value) => ...` — called directly each tick
   *   - an object with `.set(name, value)` — that method is called each tick
   *   - omitted — read values manually via `ui[name].value()`
   *
   * @method createUI
   * @memberof p5
   * @param {Object} schema    Control definitions keyed by name.
   * @param {Object} [opt]     Layout options (x, y, width, color, labels, ...).
   * @param {Object|Function} [opt.target]  Value sink — shader, function, or { set }.
   * @param {(HTMLElement|p5.Element)} [opt.parent]  Mount target.
   *   Defaults to the canvas parent element.
   * @returns {Object} UI handle with .el, .tick(), .dispose(), per-control accessors.
   *
   * @example <caption>Scene params — manual read</caption>
   * let ui
   * function setup() {
   *   createCanvas(600, 400, WEBGL)
   *   ui = createUI({
   *     speed:     { min: 0, max: 0.05, value: 0.012, step: 0.001 },
   *     shininess: { min: 1, max: 200,  value: 80,    step: 1     },
   *     showGrid:  { value: true }
   *   }, { x: 10, y: 10, labels: true, color: 'white', title: 'Scene' })
   * }
   *
   * @example <caption>Shader uniforms — auto-push via target</caption>
   * let ui
   * function setup() {
   *   createCanvas(600, 400, WEBGL)
   *   const blur = createFilterShader(blurFrag)
   *   ui = createUI({
   *     blurIntensity: { min: 0, max: 4, value: 2, step: 0.1 }
   *   }, { target: blur, x: 10, y: 10, labels: true })
   * }
   */
  fn.createUI = function (schema, opt) {
    const pInst = this;
    opt         = Object.assign({}, opt);
    // Intercept p5 shader targets — wrap setUniform as a plain function
    // so @nakednous/ui never needs to know what a uniform is.
    if (opt.target && typeof opt.target.setUniform === 'function') {
      const shader = opt.target;
      opt.target   = (name, value) => shader.setUniform(name, value);
    }
    opt.parent = _resolveParent(pInst, opt.parent);
    const ui   = _createUI(schema, opt);
    // Persistent player — tick() always returns true (UI never self-removes)
    registerPlayer(pInst, { tick() { ui.tick(); return true; } });
    return ui;
  };

  // ── createTrackUI ──────────────────────────────────────────────────────────
  /**
   * Create transport controls for a PoseTrack or CameraTrack.
   *
   * **`+` button behaviour:**
   *
   * | Track type | Camera source | What `+` records |
   * |---|---|---|
   * | CameraTrack | track.camera | `{ eye, center, up }` via capturePose |
   * | PoseTrack | curCamera (default) | `{ pos: frustum-centre@depth, rot: camera orientation }` |
   * | PoseTrack | opt.camera (explicit) | same, using the specified camera |
   * | Either | opt.camera === null | `+` button suppressed |
   *
   * For PoseTrack the depth slider controls which world-space point along the
   * frustum centre ray becomes the keyframe position (0 = near plane, 1 = far).
   * This lets you place object animation keyframes at meaningful scene depths
   * without manually typing coordinates.
   *
   * @method createTrackUI
   * @memberof p5
   * @param {PoseTrack|CameraTrack} track  The track to control.
   * @param {Object} [opt]  Layout options (seek, props, info, rate, loop, depth, ...).
   * @param {p5.Camera|null} [opt.camera]
   *   Override camera for + button. null suppresses the button.
   * @param {(HTMLElement|p5.Element)} [opt.parent]  Mount target.
   *   Defaults to the canvas parent element.
   * @returns {Object} UI handle with .el, .tick(), .dispose().
   *
   * @example <caption>CameraTrack</caption>
   * let cam, track
   * function setup() {
   *   createCanvas(600, 400, WEBGL)
   *   cam   = createCamera()
   *   track = createTrack(cam)
   *   createTrackUI(track, { x: 10, y: 10, color: 'white' })
   * }
   * function draw() {
   *   background(20)
   *   setCamera(cam)
   *   orbitControl()
   * }
   *
   * @example <caption>PoseTrack — depth-based + button</caption>
   * let track, out
   * function setup() {
   *   createCanvas(600, 400, WEBGL)
   *   track = createTrack()
   *   out   = { pos:[0,0,0], rot:[0,0,0,1], scl:[1,1,1] }
   *   createTrackUI(track, { x: 10, y: 10, color: 'white' })
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
  fn.createTrackUI = function (track, opt) {
    const pInst = this;
    opt = Object.assign({}, opt);
    opt.parent = _resolveParent(pInst, opt.parent);

    // Hooks passed in opts are forwarded directly onto the track.
    if (typeof opt.onPlay === 'function') { track.onPlay = opt.onPlay; delete opt.onPlay; }
    if (typeof opt.onEnd  === 'function') { track.onEnd  = opt.onEnd;  delete opt.onEnd;  }
    if (typeof opt.onStop === 'function') { track.onStop = opt.onStop; delete opt.onStop; }

    const isCameraTrack = track instanceof CameraTrack;

    // Camera for + button capture.
    let cam;
    if ('camera' in opt) {
      cam = opt.camera === null ? null
          : opt.camera instanceof p5.Camera ? opt.camera
          : (pInst._renderer?.states?.curCamera ?? null);
    } else if (isCameraTrack) {
      cam = track.camera ?? (pInst._renderer?.states?.curCamera ?? null);
    } else {
      // PoseTrack default: use curCamera so the + button and depth slider work.
      cam = pInst._renderer?.states?.curCamera ?? null;
    }
    delete opt.camera;

    // Hide depth slider for camera tracks — not meaningful there.
    if (isCameraTrack && !('depth' in opt)) opt.depth = false;

    const uiTarget = _wrapTrack(track, cam, isCameraTrack, pInst);
    const ui = _trackUI(uiTarget, opt);
    registerPlayer(pInst, { tick() { ui.tick(); return true; } });
    return ui;
  };
}
