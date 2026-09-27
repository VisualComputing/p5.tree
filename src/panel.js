/**
 * @file On-page controls for parameters and playback.
 * @module p5.tree/panel
 * @license AGPL-3.0-only
 *
 * Put a small control panel next to the canvas with one call. `createPanel()`
 * builds sliders, checkboxes and colour pickers from a plain object of
 * parameters and can push their values into a shader every frame; handed a
 * `PoseTrack` or `CameraTrack` it builds playback controls — play, seek, rate,
 * loop and a button to add a keyframe; handed a `PoseHelm` it exposes the
 * helm's per-axis settings and live meters.
 *
 * Reach for it when a sketch needs tweakable numbers or a timeline without
 * writing any page markup.
 *
 * @details
 * ### What lives here
 *
 *  ```
 *  fn.createPanel(trackOrSchema, opt)
 *    Unified factory — type-discriminated by first argument:
 *      track (has .play)  → transport panel (PoseTrack or CameraTrack)
 *      schema (plain obj) → parameter panel (shader uniforms, scene params)
 *  ```
 *
 * ### Bridge responsibilities
 *  1. Resolve opt.parent   → canvas parent element (default) or explicit mount
 *  2. Resolve opt.target   → wrap p5 shader's setUniform as plain (name,val)=>...
 *  3. Resolve opt.camera   → whether the + button is offered at all
 *  4. Wrap track           → build duck-typed wrapper for deps/ui (via _wrapTrack)
 *  5. Register player      → auto-tick via predraw loop
 *
 * ### The + button
 *
 *  ```
 *  CameraTrack              → captures the bound camera (track.camera)
 *  PoseTrack                → host's add(depth): the pose at the frustum centre
 *                             of that depth, aimed along the frame's own camera
 *                             (the view bag the predraw fills from the renderer)
 *  Either + camera: null    → + button suppressed
 *  ```
 *
 *  The placement itself lives in host, not here: the camera the sketch draws
 *  with is the camera the placement must use, and both bridges fill one bag.
 */

'use strict';

import { createPanel as _createPanel } from '@nakednous/ui';
import { CameraTrack } from '@nakednous/tree';
import { registerPlayer } from './track.js';

// ── Parent resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the mount parent for a panel.
 * Priority: explicit opt.parent → canvas parent → document.body.
 * Unwraps p5.Element to its raw HTMLElement.
 * @param {p5} pInst
 * @param {HTMLElement|p5.Element|undefined} parent
 * @returns {HTMLElement}
 */
// p5 records presses on the whole window, and orbitControl only asks whether
// the mouse lies inside the canvas rectangle — so a drag on a panel floating
// over the canvas would orbit the camera too. A panel keeps its pointer
// presses and wheel to itself: p5 never sees them, its own widgets do.
function _shield(panel) {
  const el = panel && panel.el;
  if (el && !el._p5treeShield) {
    el._p5treeShield = true;
    const stop = (e) => e.stopPropagation();
    el.addEventListener('pointerdown', stop);
    el.addEventListener('wheel', stop);
  }
  return panel;
}

function _resolveParent(pInst, parent) {
  if (parent) return (parent.elt !== undefined) ? parent.elt : parent;
  return (pInst._renderer && pInst._renderer.canvas)
    ? pInst._renderer.canvas.parentElement
    : document.body;
}

// ── Track wrapper ─────────────────────────────────────────────────────────────

/**
 * Build a duck-typed wrapper around a track for consumption by deps/ui.
 *
 * The wrapper exposes the transport contract (_createTrackUI duck-type):
 *   play, stop, seek, time, playing, reset, info, add, remove (optional)
 *
 * Lib-space hook slots (_onPlay, _onEnd, _onStop) are forwarded to the
 * underlying track via property getters/setters so that trackUI's assignments
 * reach the object that actually fires the hooks.
 *
 * For CameraTrack: apply is already wired in createCameraTrack; the wrapper only
 *   handles snap (1-kf), seek-while-stopped, and + button capture.
 *   Depth slider is suppressed (not meaningful for camera tracks).
 *
 * For PoseTrack: the + button is the track's own host `add(depth)`, which places
 *   the pose at the frustum centre of that depth, aimed along the frame's own
 *   camera — the view bag the predraw fills from the renderer. Nothing of the
 *   placement lives here: the camera the sketch draws with is the camera the
 *   placement must use, and host already reads it.
 *
 * @param {PoseTrack|CameraTrack} track
 * @param {p5.Camera|null} cam
 * @param {boolean} isCameraTrack
 * @param {boolean} showReset  When false, w.reset is omitted and _createPanel
 *   suppresses the reset button. Use when keyframes are immutable by design.
 * @returns {Object}
 */
function _wrapTrack(track, cam, isCameraTrack, showReset) {
  const _snapOut = isCameraTrack
    ? { eye:[0,0,0], center:[0,0,0], up:[0,1,0], fov:null, halfHeight:null }
    : { pos:[0,0,0], rot:[0,0,0,1], scl:[1,1,1] };

  const _addOut = { eye:[0,0,0], center:[0,0,0], up:[0,1,0], fov:null, halfHeight:null };

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
    get bounce() { return track.bounce; },
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
      // host's own add(depth): the pose in front of the frame's camera.
      w.add = (d) => track.add(d);
    }
    // The authoring pair is offered together: `camera: null` names a track the
    // sketch authors itself, so its panel shows neither + nor −. host's
    // remove() with no argument retracts the last keyframe.
    if (typeof track.remove === 'function') w.remove = (i) => track.remove(i);
  }

  return w;
}

// ── installPanel ──────────────────────────────────────────────────────────────

// Install fn.createPanel onto p5.
export function installPanel(p5, fn) {

  /**
   * Create a panel beside the canvas from what you hand it: playback
   * controls for a `PoseTrack` or `CameraTrack`, sliders and inputs for a plain schema
   * of parameters, or the 6-DOF profile and live meters of a `PoseHelm` (see the
   * three examples). Position and colour it through the options; `target` pushes
   * parameter values into a shader or a setter every frame, `camera` and `reset` tune
   * a track panel's buttons, and `frame` adds the helm frame selector. Dragging a
   * slider never orbits the camera. Needs a canvas to mount beside (or a parent
   * element) and the object to control.
   *
   * @details
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
   * **Helm panel** (a PoseHelm's 6-DOF profile + live activity):
   * ```js
   * const helm = createPoseHelm()
   * helm.bind(obj)
   * // signed per-DOF sliders + lane buttons + activity meters + deadzone;
   * // { frame: true } adds an EYE|WORLD|SELF selector (pose helms only)
   * createPanel(helm, { frame: true, x: 10, y: 10, color: 'white' })
   * ```
   *
   * @function createPanel
   * @memberof p5
   * @param {PoseTrack|CameraTrack|PoseHelm|Object} trackOrSchema
   *   A track (`PoseTrack` / `CameraTrack`), a helm (`PoseHelm`), or a plain schema object.
   * @param {Object} [opt]
   *   Layout and behaviour options.
   * @param {p5.Camera|null} [opt.camera]
   *   Track panels only. The `p5.Camera` a `CameraTrack`'s + button captures a keyframe from;
   *   null suppresses the + button. Defaults to the track's camera for a `CameraTrack`. A
   *   `PoseTrack`'s + places against the camera the frame draws with — the renderer's, whose
   *   projection the placement needs — so any value but null merely offers the button.
   * @param {boolean} [opt.add=true]
   *   Track panels only. Set false to suppress the + button.
   * @param {boolean} [opt.remove=true]
   *   Track panels only. Set false to suppress the − button (remove the last keyframe).
   *   A panel given `camera: null` — a track the sketch authors itself — has neither + nor −.
   * @param {boolean} [opt.reset=true]
   *   Track panels only. Set false to suppress the reset button.
   * @param {boolean} [opt.frame=false]
   *   Helm panels only. Show the EYE|WORLD|SELF frame selector.
   * @param {Object|Function} [opt.target]
   *   Param panels only. Where values go each frame: a `p5.Shader`, a `(name, value) => ...`
   *   function, or an object with a `set` method.
   * @param {(HTMLElement|p5.Element)} [opt.parent]
   *   Element to place the panel in. Defaults to the canvas parent element.
   * @returns {Object} The `Panel`, with `.el`, `.tick()` and `.dispose()`.
   * @example
   * <caption>A parameter panel: sliders, a checkbox and a colour driving scene state through target</caption>
   * const params = { speed: 0.02, size: 60, spin: true, tint: '#ff4fd8' }
   * let angle = 0
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   createPanel({
   *     speed: { min: 0, max: 0.1, value: params.speed, step: 0.005 },
   *     size:  { min: 20, max: 120, value: params.size, step: 1, type: 'int' },
   *     spin:  { value: params.spin },
   *     tint:  { value: params.tint }
   *   }, {
   *     x: 10, y: 10, labels: true, title: 'box', color: 'white',
   *     target: (name, value) => { params[name] = value }
   *   })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   if (params.spin) angle += params.speed
   *   rotateY(angle)
   *   stroke('white')
   *   fill(params.tint)
   *   box(params.size)
   * }
   * @example
   * <caption>A transport panel for a PoseTrack: play, seek, rate and loop, plus + to add a keyframe</caption>
   * let track
   * const pose = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scl: [1, 1, 1] }
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   track = createPoseTrack()
   *   track.add({ pos: [-120, 60, 0] })
   *   track.add({ pos: [0, -60, 80] })
   *   track.add({ pos: [120, 60, 0] })
   *   createPanel(track, { x: 10, y: 10, width: 150, info: true, color: 'white' })
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
   * <caption>A helm panel: the 6-DOF profile edited live, its meters reading a scripted probe</caption>
   * let helm
   * const obj = { pos: [80, 0, 0], rot: [0, 0, 0, 1] }
   * const lin = [0, 0, 0], ang = [0, 0, 0]
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   helm = createPoseHelm({ from: p5.Tree.WORLD }).bind(obj)
   *   createPanel(helm, { frame: true, x: 10, y: 10, width: 100, color: 'white' })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   // a probe in place of a device: lane 1 (Tz) and lane 2 (Ry) at the default mapping
   *   const s = sin(millis() / 1000)
   *   lin[1] = 250 * s
   *   ang[2] = 250 * s
   *   helm.feed(lin, ang)
   *   push()
   *   applyPose(obj)
   *   stroke('white')
   *   fill('#ff4fd8')
   *   box(40)
   *   pop()
   * }
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

      // The + button's camera. null suppresses the button for either kind; a
      // CameraTrack captures this one, a PoseTrack places against the frame's
      // own (host's add reads the view bag the predraw just filled).
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

      const panel = _createPanel(_wrapTrack(track, cam, isCameraTrack, showReset), opt);
      registerPlayer(pInst, { tick() { panel.tick(); return true; } });
      return _shield(panel);
    }

    // ── Helm panel path ────────────────────────────────────────────
    // A helm (recognised by feed()) gets the profile / config surface. The
    // profile is plain data and the ui builder owns the widgets, so there is
    // nothing p5-specific to resolve — the bridge is a thin pass-through plus the
    // per-frame tick that drives the activity meters.
    if (typeof trackOrSchema?.feed === 'function') {
      const panel = _createPanel(trackOrSchema, opt);
      registerPlayer(pInst, { tick() { panel.tick(); return true; } });
      return _shield(panel);
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
    return _shield(panel);
  };
}
