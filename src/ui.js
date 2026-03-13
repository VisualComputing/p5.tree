/**
 * @file p5 bridge for the ui/ package (createUniformUI, createTrackUI).
 * @module p5.tree/ui
 * @license GPL-3.0-only
 *
 * This thin bridge does three things per UI type:
 *   1. Resolves p5-specific types (p5.Camera → wrapped target, p5.Element → DOM).
 *   2. Mounts the UI container into the canvas parent by default.
 *   3. Registers a persistent player so tick() is called every frame.
 *
 * Parent resolution rule
 * ----------------------
 *   opt.parent is resolved here, before passing to the generic UI factories.
 *   Generic factories (createUniformUI / createTrackUI) receive a plain
 *   HTMLElement and know nothing about p5.Element or canvas structure.
 */

'use strict';

import { createUniformUI as _uniformUI, createTrackUI as _trackUI } from '@nakednous/ui';
import {
  qFromMat4,
  NDC, WORLD,
  mapLocation as coreMapLocation,
  mat4Mul, mat4Invert,
} from '@nakednous/tree';
import {
  registerPlayer, getCamTrack, tickCamera, _applyCamAtCursor
} from './path.js';

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
 * Uses coreMapLocation (NDC→WORLD) directly to avoid going through the p5
 * bridge wrapper. Returns a plain [x, y, z] array, or null if renderer
 * state is unavailable.
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

// ── installUI ─────────────────────────────────────────────────────────────────

/**
 * Install fn.createUniformUI and fn.createTrackUI.
 * @param {p5} p5  The p5 constructor.
 * @param {Object} fn  p5 prototype.
 */
export function installUI(p5, fn) {

  // ── createUniformUI ────────────────────────────────────────────────────────
  /**
   * Create a uniform UI panel and auto-tick it every frame.
   *
   * @method createUniformUI
   * @memberof p5
   * @param {Object} schema    Control definitions (same keys as uniform names).
   * @param {Object} [opt]     Layout options (x, y, width, color, labels, ...).
   * @param {Object} [opt.target]  Shader or anything with setUniform(name, value).
   *   If provided, tick() auto-applies values each frame.
   *   If omitted, read values manually via ui[name].value() (e.g. strands closures).
   * @param {(HTMLElement|p5.Element)} [opt.parent]  Mount target.
   *   Defaults to the canvas parent element.
   * @returns {Object} UI handle with .el, .tick(), .dispose(), per-control accessors.
   *
   * @example <caption>Manual read (p5.strands / closures)</caption>
   * let ui
   * function setup() {
   *   createCanvas(600, 400, WEBGL)
   *   ui = createUniformUI({
   *     frequency: { min: 0, max: 10, value: 2, step: 0.1 },
   *     amplitude: { min: 0, max: 1, value: 0.05, step: 0.01 }
   *   }, { x: 10, y: 10, labels: true, color: 'white', title: 'FX' })
   * }
   *
   * @example <caption>Auto-apply (GLSL setUniform)</caption>
   * let ui
   * function setup() {
   *   createCanvas(600, 400, WEBGL)
   *   const blur = createFilterShader(blurFrag)
   *   ui = createUniformUI({
   *     blurIntensity: { min: 0, max: 4, value: 2, step: 0.1 }
   *   }, { target: blur, x: 10, y: 10, labels: true })
   * }
   */
  fn.createUniformUI = function (schema, opt) {
    const pInst  = this;
    opt          = Object.assign({}, opt);   // do not mutate caller's object
    opt.parent   = _resolveParent(pInst, opt.parent);
    const ui     = _uniformUI(schema, opt);
    // Persistent player — tick() always returns true (UI never self-removes)
    registerPlayer(pInst, { tick() { ui.tick(); return true; } });
    return ui;
  };

  // ── createTrackUI ──────────────────────────────────────────────────────────
  /**
   * Create transport controls for a PoseTrack or Camera path.
   *
   * @method createTrackUI
   * @memberof p5
   * @param {(PoseTrack|p5.Camera)} [trackOrCam]  Target to control.
   *   If a Camera is passed, its internal PoseTrack is resolved automatically
   *   and the `+` button adds the current camera pose as a keyframe.
   *   If a PoseTrack is passed, the `+` button captures a pose from the
   *   current camera (eye position + orientation).
   *   If omitted (first arg is the options object), defaults to curCamera.
   * @param {Object} [opt]  Layout options (seek, props, info, rate, loop, depth, ...).
   * @param {number}  [opt.depth=0.5]  Initial add-pose depth [0..1]: 0 = near plane,
   *   1 = far plane.  The `+` button places the new keyframe at the frustum centre
   *   ray unprojected to this NDC depth.
   * @param {(HTMLElement|p5.Element)} [opt.parent]  Mount target.
   *   Defaults to the canvas parent element.
   * @returns {Object} UI handle with .el, .tick(), .dispose().
   *
   * @example <caption>Camera path with transport controls</caption>
   * let cam, ui
   * function setup() {
   *   createCanvas(600, 400, WEBGL)
   *   cam = createCamera()
   *   cam.addPath([0, 0, 500],    [0, 0, 0], [0, 1, 0])
   *   cam.addPath([200, -100, 0], [0, 0, 0], [0, 1, 0])
   *   cam.addPath([-150, 50, 300],[0, 0, 0], [0, 1, 0])
   *   ui = createTrackUI(cam, { info: true, y: 10, x: 10 })
   * }
   *
   * @example <caption>Standalone PoseTrack</caption>
   * let track, ui
   * function setup() {
   *   createCanvas(600, 400, WEBGL)
   *   track = createPoseTrack()
   *   ui = createTrackUI(track, { info: true })
   * }
   */
  fn.createTrackUI = function (trackOrCamOrOpt, opt) {
    const pInst = this;

    // If first arg is a plain options object (no track/camera), default to curCamera
    if (trackOrCamOrOpt && typeof trackOrCamOrOpt === 'object'
        && !(trackOrCamOrOpt instanceof p5.Camera)
        && !trackOrCamOrOpt.play
        && !trackOrCamOrOpt.seek) {
      opt              = trackOrCamOrOpt;
      trackOrCamOrOpt  = pInst._renderer && pInst._renderer.states
        ? pInst._renderer.states.curCamera : null;
    }
    opt        = Object.assign({}, opt || {});
    opt.parent = _resolveParent(pInst, opt.parent);

    const isCam = trackOrCamOrOpt instanceof p5.Camera;
    // Depth slider is only meaningful for PoseTrack targets (placing an object
    // at a scene depth). Camera keyframes snapshot the whole camera pose, so
    // depth does not apply.
    if (isCam) opt.depth = false;
    let target;

    if (isCam) {
      // ── Camera target ────────────────────────────────────────────────────
      // Operate directly on the underlying PoseTrack through a thin wrapper
      // so that the bridge (not p5.Camera) controls the player lifecycle.
      const cam   = trackOrCamOrOpt;
      const b     = getCamTrack(cam);
      const track = b.track;

      target = {
        play(o) {
          if (track.keyframes.length === 0) return;
          // One keyframe: snap and return, do not animate
          if (track.keyframes.length === 1) {
            _applyCamAtCursor(cam);
            return;
          }
          const opts = {};
          if (o && typeof o === 'number') {
            opts.rate = o;
          } else if (o) {
            if ('rate'     in o) opts.rate     = o.rate;
            if ('loop'     in o) opts.loop     = o.loop;
            if ('pingPong' in o) opts.pingPong = o.pingPong;
            if ('duration' in o) opts.duration = o.duration;
          }
          track.play(opts);
        },
        stop() {
          track.stop();
          _applyCamAtCursor(cam);
        },
        seek(t) {
          track.seek(t);
          _applyCamAtCursor(cam);
        },
        time()  { return track.time(); },
        info()  { return track.info(); },
        /**
         * Snapshot the current camera pose as a new keyframe.
         * Depth is not applicable to camera keyframes — the snapshot IS the camera.
         */
        add() { cam.addPath(); },
        /** Clear all keyframes and stop. */
        reset() { cam.resetPath(); },
        get playing()  { return track.playing; },
        get onPlay()   { return track.onPlay; },
        set onPlay(f)  { track.onPlay = f; },
        get onEnd()    { return track.onEnd; },
        set onEnd(f)   { track.onEnd = f; },
        get onStop()   { return track.onStop; },
        set onStop(f)  { track.onStop = f; }
      };

    } else {
      // ── PoseTrack target ─────────────────────────────────────────────────
      // Augment the bare PoseTrack with an add() that captures a pose from the
      // current camera at the frustum centre unprojected to depth d.
      const track = trackOrCamOrOpt;

      /**
       * Capture a pose from the current camera at NDC depth d.
       * Position: frustum centre at depth d (NDC→WORLD).
       * Orientation: quaternion extracted from the current camera matrix.
       * @param {number} [d=0.5]
       * @returns {{ pos, rot, scl }|null}
       */
      const _captureFromCamera = (d = 0.5) => {
        const cam = pInst._renderer && pInst._renderer.states
          ? pInst._renderer.states.curCamera : null;
        if (!cam) return null;
        const rot = [0, 0, 0, 1];
        if (cam.cameraMatrix && cam.cameraMatrix.mat4) {
          qFromMat4(rot, cam.cameraMatrix.mat4);
        }
        const wp  = _centerAtDepth(pInst, d);
        const pos = wp ? wp : [cam.eyeX, cam.eyeY, cam.eyeZ];
        return { pos, rot, scl: [1, 1, 1] };
      };

      target = {
        play(o)  { track.play(o); },
        stop()   { track.stop(); },
        seek(t)  { track.seek(t); },
        time()   { return track.time(); },
        info()   { return track.info(); },
        /**
         * Capture current camera pose at depth d and push it as a new keyframe.
         * @param {number} [d=0.5]
         */
        add(d = 0.5) {
          const pose = _captureFromCamera(d);
          if (pose) track.keyframes.push(pose);
        },
        /** Clear all keyframes and stop. */
        reset() { track.reset(); },
        get playing()  { return track.playing; },
        get onPlay()   { return track.onPlay; },
        set onPlay(f)  { track.onPlay = f; },
        get onEnd()    { return track.onEnd; },
        set onEnd(f)   { track.onEnd = f; },
        get onStop()   { return track.onStop; },
        set onStop(f)  { track.onStop = f; }
      };
    }

    // Wire user-supplied hooks from opt onto target *before* _trackUI chains
    // them. trackUI.js captures target.on* as _prevOn* and calls them after
    // its own UI-sync wrapper — so they must be set here, not after.
    if (typeof opt.onPlay === 'function') { target.onPlay = opt.onPlay; delete opt.onPlay; }
    if (typeof opt.onEnd  === 'function') { target.onEnd  = opt.onEnd;  delete opt.onEnd;  }
    if (typeof opt.onStop === 'function') { target.onStop = opt.onStop; delete opt.onStop; }

    const ui = _trackUI(target, opt);

    // Single persistent player: ticks camera (if applicable) + UI sync
    if (isCam) {
      const cam = trackOrCamOrOpt;
      registerPlayer(pInst, {
        tick() { tickCamera(cam); ui.tick(); return true; }
      });
    } else {
      registerPlayer(pInst, { tick() { ui.tick(); return true; } });
    }

    return ui;
  };
}
