/**
 * @file p5 bridge for the ui/ package (createUniformUI, createTrackUI).
 * @module p5.tree/ui
 * @license GPL-3.0-only
 *
 * This thin bridge does three things per UI type:
 *   1. Resolves p5-specific types (Camera -> PoseTrack, p5.Element -> DOM).
 *   2. Mounts the UI container into the canvas parent by default.
 *   3. Registers a persistent player so tick() is called every frame.
 */

'use strict';

import { createUniformUI as _uniformUI, createTrackUI as _trackUI } from '@nakednous/ui';
import { registerPlayer, getCamTrack, tickCamera, _applyCamAtCursor } from './track.js';

/**
 * Install fn.createUniformUI and fn.createTrackUI.
 * @param {p5} p5  The p5 constructor.
 * @param {Object} fn  p5 prototype.
 */
export function installUI(p5, fn) {

  // ── createUniformUI ────────────────────────────────────────────────
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
   *   TODO: auto-bind once p5.strands uniform API stabilises.
   * @param {(HTMLElement|p5.Element)} [opt.parent]  Mount target.
   *   Defaults to the canvas parent element.
   * @returns {Object} UI handle with .el, .tick(), .dispose(), per-control accessors.
   *
   * @example <caption>Manual read (p5.strands / closures)</caption>
   * let ui;
   * function setup() {
   *   createCanvas(600, 400, WEBGL);
   *   ui = createUniformUI({
   *     frequency: { min: 0, max: 10, value: 2, step: 0.1 },
   *     amplitude: { min: 0, max: 1, value: 0.05, step: 0.01 }
   *   }, { x: 10, y: 10, labels: true, color: 'white', title: 'FX' });
   * }
   *
   * @example <caption>Auto-apply (GLSL setUniform)</caption>
   * let ui;
   * function setup() {
   *   createCanvas(600, 400, WEBGL);
   *   const blur = createFilterShader(blurFrag);
   *   ui = createUniformUI({
   *     blurIntensity: { min: 0, max: 4, value: 2, step: 0.1 }
   *   }, { target: blur, x: 10, y: 10, labels: true });
   * }
   */
  fn.createUniformUI = function (schema, opt) {
    opt = opt || {};
    const pInst = this;
    // Default parent: canvas container
    if (!opt.parent) {
      opt.parent = pInst._renderer && pInst._renderer.canvas
        ? pInst._renderer.canvas.parentElement
        : document.body;
    } else if (opt.parent && opt.parent.elt) {
      opt.parent = opt.parent.elt;  // unwrap p5.Element
    }
    const ui = _uniformUI(schema, opt);
    // Persistent player — always returns true (never self-removes)
    registerPlayer(pInst, { tick() { ui.tick(); return true; } });
    return ui;
  };

  // ── createTrackUI ──────────────────────────────────────────────────
  /**
   * Create transport controls for a PoseTrack or Camera path.
   *
   * @method createTrackUI
   * @memberof p5
   * @param {(PoseTrack|p5.Camera)} [trackOrCam]  Target to control.
   *   If a Camera is passed, its internal PoseTrack is resolved automatically.
   *   If omitted (first arg is the options object), defaults to curCamera.
   * @param {Object} [opt]  Layout options (seek, props, info, rate, loop, ...).
   * @param {(HTMLElement|p5.Element)} [opt.parent]  Mount target.
   *   Defaults to the canvas parent element.
   * @returns {Object} UI handle with .el, .tick(), .dispose().
   *
   * @example <caption>Camera path with transport controls</caption>
   * let cam, ui;
   * function setup() {
   *   createCanvas(600, 400, WEBGL);
   *   cam = createCamera();
   *   // addPath(eye, center, up) — three vec3 arguments
   *   cam.addPath([0, 0, 500],    [0, 0, 0], [0, 1, 0]);
   *   cam.addPath([200, -100, 0], [0, 0, 0], [0, 1, 0]);
   *   cam.addPath([-150, 50, 300],[0, 0, 0], [0, 1, 0]);
   *   ui = createTrackUI(cam, { info: true, y: 10, x: 10 });
   * }
   * function draw() {
   *   background(0);
   *   orbitControl();
   *   box(100);
   * }
   *
   * @example <caption>Standalone PoseTrack</caption>
   * let track, ui;
   * function setup() {
   *   createCanvas(600, 400, WEBGL);
   *   track = createPoseTrack();
   *   track.add({ pos: [0, 0, 0] });
   *   track.add({ pos: [100, 50, -200] });
   *   track.add({ pos: [-50, 100, 0] });
   *   ui = createTrackUI(track, { info: true });
   * }
   */
  fn.createTrackUI = function (trackOrCamOrOpt, opt) {
    const pInst = this;

    // If first arg is a plain options object (no track/camera), default to curCamera
    if (trackOrCamOrOpt && typeof trackOrCamOrOpt === 'object'
        && !(trackOrCamOrOpt instanceof p5.Camera)
        && !trackOrCamOrOpt.play && !trackOrCamOrOpt.seek) {
      opt = trackOrCamOrOpt;
      trackOrCamOrOpt = pInst._renderer && pInst._renderer.states
        ? pInst._renderer.states.curCamera : null;
    }
    opt = opt || {};

    // Default parent: canvas container
    if (!opt.parent) {
      opt.parent = pInst._renderer && pInst._renderer.canvas
        ? pInst._renderer.canvas.parentElement
        : document.body;
    } else if (opt.parent && opt.parent.elt) {
      opt.parent = opt.parent.elt;
    }

    let target;
    let isCam = trackOrCamOrOpt instanceof p5.Camera;

    if (isCam) {
      // Operate directly on the underlying PoseTrack — bypass playPath/stopPath
      // which need cam._renderer._pInst (fragile). The bridge owns pInst and
      // registers a persistent player that handles both camera ticking and UI sync.
      const cam = trackOrCamOrOpt;
      const b = getCamTrack(cam);
      const track = b.track;
      target = {
        play(o) {
          if (track.keyframes.length < 2) return;
          const opts = {};
          if (o && typeof o === 'number') { opts.rate = o; }
          else if (o) {
            if ('rate' in o) opts.rate = o.rate;
            if ('loop' in o) opts.loop = o.loop;
            if ('pingPong' in o) opts.pingPong = o.pingPong;
            if ('duration' in o) opts.duration = o.duration;
          }
          track.play(opts);
        },
        stop(reset) {
          track.stop(reset);
          _applyCamAtCursor(cam);
        },
        seek(t) {
          track.seek(t);
          _applyCamAtCursor(cam);
        },
        time()  { return track.time(); },
        info()  { return track.info(); },
        add()   { cam.addPath(); },          // snapshot current camera
        reset() { cam.resetPath(); },        // clear all keyframes
        get playing()  { return track.playing; },
        get onPlay()   { return track.onPlay; },
        set onPlay(f)  { track.onPlay = f; },
        get onEnd()    { return track.onEnd; },
        set onEnd(f)   { track.onEnd = f; },
      };
    } else {
      target = trackOrCamOrOpt;  // PoseTrack directly
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
