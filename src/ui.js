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
import { qFromMat4 } from '@nakednous/tree';
import {
  registerPlayer, getCamTrack, tickCamera, _applyCamAtCursor
} from './track.js';

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
   * @param {Object} [opt]  Layout options (seek, props, info, rate, loop, ...).
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
        /** Add current camera as a new keyframe. */
        add()   { cam.addPath(); },
        /** Clear all keyframes and stop. */
        reset() { cam.resetPath(); },
        get playing()  { return track.playing; },
        get onPlay()   { return track.onPlay; },
        set onPlay(f)  { track.onPlay = f; },
        get onEnd()    { return track.onEnd; },
        set onEnd(f)   { track.onEnd = f; }
      };

    } else {
      // ── PoseTrack target ─────────────────────────────────────────────────
      // Augment the bare PoseTrack with an add() that captures the current
      // camera's eye position and orientation as a pose keyframe.
      const track = trackOrCamOrOpt;

      const _captureFromCamera = () => {
        const cam = pInst._renderer && pInst._renderer.states
          ? pInst._renderer.states.curCamera : null;
        if (!cam) return null;
        const rot = [0, 0, 0, 1];
        if (cam.cameraMatrix && cam.cameraMatrix.mat4) {
          qFromMat4(rot, cam.cameraMatrix.mat4);
        }
        // Eye position via coordinate-space helper if available, else direct
        let pos;
        if (typeof pInst.mapLocation === 'function') {
          const v = pInst.mapLocation([0, 0, 0], { from: p5.Tree.EYE, to: p5.Tree.WORLD });
          pos = [v.x, v.y, v.z];
        } else {
          pos = [cam.eyeX, cam.eyeY, cam.eyeZ];
        }
        return { pos, rot, scl: [1, 1, 1] };
      };

      target = {
        play(o)  { track.play(o); },
        stop()   { track.stop(); },
        seek(t)  { track.seek(t); },
        time()   { return track.time(); },
        info()   { return track.info(); },
        /** Capture current camera pose and push it as a new keyframe. */
        add() {
          const pose = _captureFromCamera();
          if (pose) track.keyframes.push(pose);
        },
        /** Clear all keyframes and stop. */
        reset() { track.reset(); },
        get playing()  { return track.playing; },
        get onPlay()   { return track.onPlay; },
        set onPlay(f)  { track.onPlay = f; },
        get onEnd()    { return track.onEnd; },
        set onEnd(f)   { track.onEnd = f; }
      };
    }

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
