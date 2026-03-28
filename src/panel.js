/**
 * @file Unified panel bridge: parameter panels and track transport controls.
 * @module p5.tree/panel
 * @license AGPL-3.0-only
 *
 * ── What lives here ──────────────────────────────────────────────────────────
 *  fn.createPanel(trackOrSchema, opt)
 *    Unified factory — type-discriminated by first argument:
 *      track (has .play)  → transport panel (PoseTrack or CameraTrack)
 *      schema (plain obj) → parameter panel (shader uniforms, scene params)
 *
 * ── Bridge responsibilities ───────────────────────────────────────────────────
 *  1. Resolve opt.parent   → canvas parent element (default) or explicit mount
 *  2. Resolve opt.target   → wrap p5 shader's setUniform as plain (name,val)=>...
 *  3. Resolve opt.camera   → curCamera default for PoseTrack + button
 *  4. Wrap track           → build duck-typed wrapper for deps/ui (via _wrapTrack)
 *  5. Register player      → auto-tick via predraw loop
 *
 * ── Camera resolution for + button ───────────────────────────────────────────
 *  CameraTrack              → track.camera (set by createCameraTrack)
 *  PoseTrack + opt.camera   → use that camera explicitly
 *  PoseTrack, omitted       → curCamera (covers ~90% of use cases)
 *  Either  + null           → + button suppressed
 */

'use strict';

import { createPanel as _createPanel } from '@nakednous/ui';
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

// ── Parent resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the mount parent for a panel.
 * Priority: explicit opt.parent → canvas parent → document.body.
 * Unwraps p5.Element to its raw HTMLElement.
 * @param {p5} pInst
 * @param {HTMLElement|p5.Element|undefined} parent
 * @returns {HTMLElement}
 */
function _resolveParent(pInst, parent) {
  if (parent) return (parent.elt !== undefined) ? parent.elt : parent;
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
 * Returns [x,y,z] or null if renderer state is unavailable.
 * @param {p5} pInst
 * @param {number} d
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
  coreMapLocation(_sc_v3, 0, 0, ndcZ, NDC, WORLD, { ipvMatrix: _sc_ipv }, [0, 0, 1, 1], ndcMin);
  return [_sc_v3[0], _sc_v3[1], _sc_v3[2]];
}

// ── Track wrapper ─────────────────────────────────────────────────────────────

/**
 * Build a duck-typed wrapper around a track for consumption by deps/ui.
 *
 * The wrapper exposes the transport contract (_createTrackUI duck-type):
 *   play, stop, seek, time, playing, reset, info, add (optional)
 *
 * Lib-space hook slots (_onPlay, _onEnd, _onStop) are forwarded to the
 * underlying track via property getters/setters so that trackUI's assignments
 * reach the object that actually fires the hooks.
 *
 * For CameraTrack: apply is already wired in createCameraTrack; the wrapper only
 *   handles snap (1-kf), seek-while-stopped, and + button capture.
 *   Depth slider is suppressed (not meaningful for camera tracks).
 *
 * For PoseTrack: + button records position = frustum-centre at depth slider
 *   value, rotation = current camera orientation.
 *
 * @param {PoseTrack|CameraTrack} track
 * @param {p5.Camera|null} cam
 * @param {boolean} isCameraTrack
 * @param {p5} pInst
 * @param {boolean} showReset  When false, w.reset is omitted and _createPanel
 *   suppresses the reset button. Use when keyframes are immutable by design.
 * @returns {Object}
 */
function _wrapTrack(track, cam, isCameraTrack, pInst, showReset) {
  const _snapOut = isCameraTrack
    ? { eye:[0,0,0], center:[0,0,0], up:[0,1,0], fov:null, halfHeight:null }
    : { pos:[0,0,0], rot:[0,0,0,1], scl:[1,1,1] };

  const _captureOut = { eye:[0,0,0], center:[0,0,0], up:[0,1,0], fov:null, halfHeight:null };
  const _addOut     = { eye:[0,0,0], center:[0,0,0], up:[0,1,0], fov:null, halfHeight:null };

  function _applySnap() {
    const applyCam = isCameraTrack ? track.camera : null;
    if (applyCam && track.keyframes.length > 0) applyCam.applyPose(track.eval(_snapOut));
  }

  // Chain onEnd so the final keyframe lands exactly when playback ends.
  const _prevOnEnd = track.onEnd;
  track.onEnd = function (t) {
    if (typeof _prevOnEnd === 'function') { try { _prevOnEnd(t); } catch (_) {} }
    _applySnap();
  };

  const w = {
    get playing()  { return track.playing; },
    get loop()     { return track.loop; },
    get pingPong() { return track.pingPong; },
    get rate()     { return track.rate; },
    play:  (o) => {
      track.play(o);
      if (!track.playing && track.keyframes.length === 1) _applySnap();
    },
    stop:  ()  => track.stop(),
    seek:  (t) => { track.seek(t); _applySnap(); },
    time:  ()  => track.time(),
  };
  if (showReset && typeof track.reset === 'function') w.reset = () => track.reset();
  if (typeof track.info === 'function') w.info = () => track.info();

  // Forward lib-space hook slots to the underlying track.
  // trackUI assigns w._onPlay / _onEnd / _onStop; track.play() fires track._onPlay.
  // Without this forwarding the panel never receives playback events from
  // track.play() called externally (e.g. via keyPressed).
  Object.defineProperty(w, '_onPlay', {
    get() { return track._onPlay; },
    set(v) { track._onPlay = v; },
  });
  Object.defineProperty(w, '_onEnd', {
    get() { return track._onEnd; },
    set(v) { track._onEnd = v; },
  });
  Object.defineProperty(w, '_onStop', {
    get() { return track._onStop; },
    set(v) { track._onStop = v; },
  });

  if (cam !== null && typeof track.add === 'function') {
    if (isCameraTrack) {
      w.add = () => {
        cam.capturePose(_addOut);
        track.add(_addOut, { deduplicate: false });
      };
    } else {
      w.add = (d) => {
        const pos = _centerAtDepth(pInst, typeof d === 'number' ? d : 0.5) || [0,0,0];
        cam.capturePose(_captureOut);
        const e = _captureOut.eye, c = _captureOut.center;
        const dir = [c[0]-e[0], c[1]-e[1], c[2]-e[2]];
        track.add({ pos, rot: { dir, up: _captureOut.up } });
      };
    }
  }

  return w;
}

// ── installPanel ──────────────────────────────────────────────────────────────

/**
 * Install fn.createPanel onto p5.
 * @param {p5} p5
 * @param {Object} fn  p5 prototype.
 */
export function installPanel(p5, fn) {

  /**
   * Unified panel factory.
   *
   * First argument determines the panel type:
   *
   * **Track panel** (PoseTrack or CameraTrack):
   * ```js
   * // CameraTrack — camera auto-resolved from track.camera
   * const cam   = createCamera()
   * const track = createCameraTrack(cam)
   * createPanel(track, { x: 10, y: 10, color: 'white' })
   *
   * // PoseTrack — curCamera used for + button by default
   * const track = createPoseTrack()
   * createPanel(track, { x: 10, y: 10, color: 'white' })
   *
   * // PoseTrack — explicit camera override
   * createPanel(track, { camera: cam2, x: 10, y: 10 })
   *
   * // Suppress + button (camera: null)
   * createPanel(track, { camera: null, x: 10, y: 10 })
   *
   * // Suppress reset button
   * createPanel(track, { reset: false, x: 10, y: 10 })
   * ```
   *
   * **Param panel** (shader uniforms, scene parameters):
   * ```js
   * // Push to a p5 shader automatically each frame
   * createPanel({
   *   blurRadius: { min: 0, max: 10, value: 2, step: 0.1 }
   * }, { target: myShader, x: 10, y: 10, labels: true })
   *
   * // Unbound — read values manually
   * const panel = createPanel({
   *   speed: { min: 0, max: 1, value: 0.5 }
   * }, { x: 10, y: 10, labels: true, color: 'white' })
   * // in draw(): use panel.speed.value()
   * ```
   *
   * @method createPanel
   * @memberof p5
   * @param {PoseTrack|CameraTrack|Object} trackOrSchema
   *   A track instance (PoseTrack / CameraTrack) or a plain schema object.
   * @param {Object} [opt]
   *   Layout and behaviour options.
   * @param {p5.Camera|null} [opt.camera]
   *   Track panels only. Override camera for + button.
   *   null suppresses the + button. Defaults to track.camera for CameraTrack,
   *   curCamera for PoseTrack.
   * @param {boolean} [opt.reset=true]
   *   Track panels only. Set false to suppress the reset button.
   * @param {Object|Function} [opt.target]
   *   Param panels only. Value sink: p5 shader, (name,val)=>..., or {set}.
   * @param {(HTMLElement|p5.Element)} [opt.parent]
   *   Mount target. Defaults to the canvas parent element.
   * @returns {Object} Panel handle with .el, .tick(), .dispose().
   */
  fn.createPanel = function (trackOrSchema, opt) {
    const pInst = this;
    opt = Object.assign({}, opt);
    opt.parent = _resolveParent(pInst, opt.parent);

    const isTrack = typeof trackOrSchema?.play === 'function';

    if (isTrack) {
      const track         = trackOrSchema;
      const isCameraTrack = track instanceof CameraTrack;

      // Forward lifecycle hooks onto the track before wrapping.
      if (typeof opt.onPlay === 'function') { track.onPlay = opt.onPlay; delete opt.onPlay; }
      if (typeof opt.onEnd  === 'function') { track.onEnd  = opt.onEnd;  delete opt.onEnd;  }
      if (typeof opt.onStop === 'function') { track.onStop = opt.onStop; delete opt.onStop; }

      const showReset = opt.reset !== false;
      delete opt.reset;

      // Resolve camera for + button.
      let cam;
      if ('camera' in opt) {
        cam = opt.camera === null             ? null
            : opt.camera instanceof p5.Camera ? opt.camera
            : (pInst._renderer?.states?.curCamera ?? null);
      } else if (isCameraTrack) {
        cam = track.camera ?? (pInst._renderer?.states?.curCamera ?? null);
      } else {
        cam = pInst._renderer?.states?.curCamera ?? null;
      }
      delete opt.camera;

      // Depth slider not meaningful for camera tracks.
      if (isCameraTrack && !('depth' in opt)) opt.depth = false;

      const panel = _createPanel(_wrapTrack(track, cam, isCameraTrack, pInst, showReset), opt);
      registerPlayer(pInst, { tick() { panel.tick(); return true; } });
      return panel;
    }

    // ── Param panel path ──────────────────────────────────────────────────────
    // Intercept p5 shader targets — wrap setUniform as a plain function.
    if (opt.target && typeof opt.target.setUniform === 'function') {
      const shader = opt.target;
      // p5 wires _renderer into the shader on the first shader() call inside draw();
      // guard against predraw ticks firing before the shader is activated.
      opt.target = (name, value) => {
        if (shader._renderer) shader.setUniform(name, value);
      };
    }

    const panel = _createPanel(trackOrSchema, opt);
    registerPlayer(pInst, { tick() { panel.tick(); return true; } });
    return panel;
  };
}
