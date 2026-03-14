/**
 * @file p5 bridge for the ui/ package (createUI, createTrackUI).
 * @module p5.tree/ui
 * @license GPL-3.0-only
 *
 * This thin bridge does three things per UI type:
 *   1. Resolves p5-specific types (p5.Camera → wrapped target, p5.Element → DOM).
 *   2. Mounts the UI container into the canvas parent by default.
 *   3. Registers a persistent player so tick() is called every frame.
 *
 * For createUI specifically, the bridge also intercepts opt.target:
 *   - p5 shader (has .setUniform) → wrapped as (name, value) => shader.setUniform(name, value)
 *   - function or { set } object  → passed through unchanged
 *
 * This keeps setUniform knowledge out of @nakednous/ui entirely.
 *
 * Parent resolution rule
 * ----------------------
 *   opt.parent is resolved here, before passing to the generic UI factories.
 *   Generic factories (createUI / createTrackUI) receive a plain
 *   HTMLElement and know nothing about p5.Element or canvas structure.
 */

// TODO: unify createUI and createTrackUI ?? Really depends on path refactor
// also renaming then this module (e.g., panel)

'use strict';

import { createUI as _createUI, createTrackUI as _trackUI } from '@nakednous/ui';
import {
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
   *
   * @example <caption>Custom sink — Web Audio</caption>
   * ui = createUI({
   *   frequency: { min: 20, max: 20000, value: 440, step: 1 }
   * }, { target: (name, value) => oscillator[name].value = value })
   */
  fn.createUI = function (schema, opt) {
    const pInst = this;
    opt         = Object.assign({}, opt);   // do not mutate caller's object
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
   */
  fn.createTrackUI = function (trackOrCam, opt) {
    const pInst = this;

    // Normalise overload: createTrackUI(opt) — no track arg
    if (trackOrCam && !opt && typeof trackOrCam === 'object' &&
        !(trackOrCam instanceof p5.Camera) &&
        typeof trackOrCam.keyframes === 'undefined') {
      opt = trackOrCam;
      trackOrCam = undefined;
    }
    opt = Object.assign({}, opt);
    opt.parent = _resolveParent(pInst, opt.parent);

    // Resolve depth → world position for the + button
    const depthVal = opt.depth ?? 0.5;
    opt.getAddPos  = () => _centerAtDepth(pInst, depthVal);

    // Camera overload — wrap path add/play/seek/stop/reset
    if (trackOrCam instanceof p5.Camera) {
      const cam = trackOrCam;
      const wrapped = {
        get keyframes() { return getCamTrack(cam).keyframes; },
        add(pose)       { return cam.addPath(pose?.pos ?? opt.getAddPos?.() ?? [0,0,0], pose?.center ?? [0,0,0], pose?.up ?? [0,1,0]); },
        play(o)         { return tickCamera(cam, o); },
        stop()          { return cam.stopPath(); },
        reset()         { return cam.resetPath(); },
        seek(t)         { return cam.seekPath(t); },
        get playing()   { return getCamTrack(cam).playing; },
        get time()      { return getCamTrack(cam).time; },
        get loop()      { return getCamTrack(cam).loop; },
        get rate()      { return getCamTrack(cam).rate; },
        get duration()  { return getCamTrack(cam).duration; },
        onEnd:  null,
        onStop: null,
      };
      const ui = _trackUI(wrapped, opt);
      registerPlayer(pInst, { tick() { ui.tick(); return true; } });
      return ui;
    }

    // PoseTrack overload
    const track = trackOrCam ?? getCamTrack(pInst._renderer?.states?.curCamera);
    const ui    = _trackUI(track, opt);
    registerPlayer(pInst, { tick() { ui.tick(); return true; } });
    return ui;
  };
}
