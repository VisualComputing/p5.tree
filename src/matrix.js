/**
 * @file Reading the camera's matrices, and mapping points and directions between world, eye and screen.
 * @module p5.tree/matrix
 * @license AGPL-3.0-only
 *
 * Read the current camera's matrices with `mat4Proj`, `mat4View`, `mat4Eye`
 * and `mat4Model`, or their products `mat4PV`, `mat4MV` and `mat4PMV`; each is
 * written into the buffer you pass. Reach for them when a custom shader needs
 * a uniform, when you draw from a second `p5.Camera`, or when you want to know
 * where `p5.translate`, `p5.rotate` and `p5.scale` have put you. `projNear`,
 * `projFar` and `projFov` read the current projection's numbers directly.
 *
 * `mapLocation` and `mapDirection` carry a point or a direction between world,
 * eye, screen space and the model transform stack. `pixelRatio`, `drawingBufferSize`,
 * `fragCoord` and `texelSize` answer the pixel-level questions that usually follow.
 *
 * @details
 * ### Two distinct contracts
 *
 * Matrix-fill methods (mat4Proj, mat4View, mat4PV, …):
 * - out-first, mandatory, zero-allocation.
 * - `out` is a caller-owned buffer (Float32Array | ArrayLike | p5.Matrix).
 * - The function writes into it and returns it.
 *
 * Space-query methods (mapLocation, mapDirection):
 * - point/dir is positional; everything else is in opts.
 * - opts.out is optional — if absent a fresh p5.Vector is allocated.
 * - Return type matches opts.out: Float32Array, ArrayLike, or p5.Vector.
 * - Hot paths pass opts.out = buf (zero-alloc); non-hot paths omit it.
 *
 * ### Viewport convention
 * The bridge always builds vp = [0, canvasH, canvasW, −canvasH].
 * Negative h encodes DOM/p5 screen-y-down. See query.js for full details.
 */

'use strict';

import {
  EYE, NDC, SCREEN, MATRIX, WEBGL, WEBGPU,
  mat4Mul, mat4Invert, mat3NormalFromMat4,
  mat4Location, mat3Direction,
  mapLocation as _mapLocation,
  mapDirection as _mapDirection,
  projIsOrtho, projNear, projFar, projFov, projHfov,
  projLeft, projRight, projTop, projBottom,
  pixelRatio as corePixelRatio,
  mat4View  as _mat4View,
  mat4Eye   as _mat4Eye,
  mat4Persp as _mat4Persp,
  mat4Ortho as _mat4Ortho,
  mat4ToTranslation,
  mat4ToScale,
  mat4ToRotation,
} from '@nakednous/tree';
import { createHost } from '@nakednous/host';

// ═══════════════════════════════════════════════════════════════════════════
// Module-level working buffers — internal intermediates, never returned
// ═══════════════════════════════════════════════════════════════════════════

const _pv   = new Float32Array(16);  // mat4PV intermediate
const _ipv  = new Float32Array(16);  // mat4PVInv intermediate
const _wa   = new Float32Array(16);  // single-step intermediate (mat4Eye, MV, …)
const _wb   = new Float32Array(16);  // toFrameInv for custom MATRIX space
const _vp   = new Float32Array(4);   // viewport [0, h, w, −h]
const _tmp3 = new Float32Array(3);   // p5.Vector write-back scratch

// ═══════════════════════════════════════════════════════════════════════════
// Unified type normalisers — zero alloc
// ═══════════════════════════════════════════════════════════════════════════

const _rawMat4 = (m) => (m != null && m.mat4 != null) ? m.mat4 : m;
const _rawMat3 = (m) => (m != null && m.mat3 != null) ? m.mat3 : m;

// ═══════════════════════════════════════════════════════════════════════════
// NDC convention — detected once in postsetup
// ═══════════════════════════════════════════════════════════════════════════

let _ndcZ = WEBGL;

// Detect NDC Z convention from renderer context. Called from postsetup.
export function detectNDC(renderer) {
  _ndcZ = (renderer.drawingContext &&
           typeof WebGL2RenderingContext !== 'undefined' &&
           renderer.drawingContext instanceof WebGL2RenderingContext) ? WEBGL : WEBGPU;
}

export const getNdcZ = () => _ndcZ;

// ═══════════════════════════════════════════════════════════════════════════
// The host — one per p5 instance, external-tick mode on the sketch canvas
// ═══════════════════════════════════════════════════════════════════════════
//
// Created on first need (a handle or a track built inside setup() asks for
// it) rather than at postsetup, with ndcZMin read off the renderer once.
// predraw fills its view bag from renderer state and ticks its players;
// postdraw flushes its pointer source; remove disposes it.

const _canvasOf = (r) => (r && (r.canvas || (r.drawingContext && r.drawingContext.canvas))) || null;

// The p5 instance's host, created on the sketch canvas if absent. Null
// before createCanvas().
export function ensureHost(pInst) {
  const t = (pInst._tree ||= {});
  if (t.host) return t.host;
  const canvas = _canvasOf(pInst._renderer);
  if (!canvas) return null;
  detectNDC(pInst._renderer);
  t.host = createHost(canvas, { ndcZMin: _ndcZ });
  return t.host;
}

// The p5 instance's host, or null.
export const hostOf = (pInst) => (pInst && pInst._tree && pInst._tree.host) || null;

// predraw: the host's view bag from the renderer's projection and camera,
// its viewport from the sketch's logical size. Returns the host.
export function syncHostView(pInst) {
  const h = ensureHost(pInst);
  if (!h) return null;
  const r = pInst._renderer;
  h.view.resize(pInst.width, pInst.height);
  h.view.set(_projMat4(r), _viewMat4(r));
  return h;
}

// postdraw: end the pointer source's frame.
export function flushHostPointer(pInst) {
  const h = hostOf(pInst);
  if (h) h.pointer.flush();
}

// postdraw: project the label layer through the camera the frame was drawn
// with — the bag is re-read from the renderer, since draw() may have moved
// the camera after predraw's sync. Nothing happens for a sketch that never
// asked for labels.
export function tickHostLabels(pInst) {
  const h = hostOf(pInst);
  if (!h || !h.hasLabels) return;
  syncHostView(pInst);
  h.labels.tick();
}

// remove: dispose the host and forget it.
export function disposeHost(pInst) {
  const h = hostOf(pInst);
  if (!h) return;
  h.dispose();
  delete pInst._tree.host;
}

// ═══════════════════════════════════════════════════════════════════════════
// Raw p5 state access — direct Float32Array refs, no copies
// ═══════════════════════════════════════════════════════════════════════════

const _projMat4  = (r) => r.states.uPMatrix.mat4;
const _viewMat4  = (r) => r.states.curCamera.cameraMatrix.mat4;
const _modelMat4 = (r) => r.states.uModelMatrix.mat4;

// ═══════════════════════════════════════════════════════════════════════════
// Screen-ray bag — lib-space, for the core's unproject / pointerHit
// ═══════════════════════════════════════════════════════════════════════════
//
// The matrices bag those endpoints read (mat4Proj, mat4View, mat4PV and, on
// request, mat4PVInv) plus the bridge viewport [0, h, w, −h]. One module-level
// bag, refilled per call; never returned to a sketch.

const _rayBag = { mat4Proj: null, mat4View: null, mat4PV: null, mat4PVInv: null };
const _rayPV  = new Float32Array(16);
const _rayIPV = new Float32Array(16);
const _rayVp  = new Float32Array(4);

// Fill the bag from the renderer, honouring the mat4Proj / mat4View / mat4PV /
// mat4PVInv overrides a sketch may pass. `inv` requests the inverse; a
// singular P · V leaves mat4PVInv null, which the core reports as no ray.
export function pvBag(renderer, opts, inv) {
  const o = opts || {};
  _rayBag.mat4Proj = _rawMat4(o.mat4Proj) ?? _projMat4(renderer);
  _rayBag.mat4View = _rawMat4(o.mat4View) ?? _viewMat4(renderer);
  _rayBag.mat4PV   = _rawMat4(o.mat4PV) ??
    (mat4Mul(_rayPV, _rayBag.mat4Proj, _rayBag.mat4View), _rayPV);
  _rayBag.mat4PVInv = inv
    ? (_rawMat4(o.mat4PVInv) ?? (mat4Invert(_rayIPV, _rayBag.mat4PV) && _rayIPV))
    : null;
  return _rayBag;
}

// The signed viewport the bridge hands the core: negative h is p5's screen y-down.
export function viewport(renderer) {
  _rayVp[0] = 0; _rayVp[1] = renderer.height; _rayVp[2] = renderer.width; _rayVp[3] = -renderer.height;
  return _rayVp;
}

// ═══════════════════════════════════════════════════════════════════════════
// Install
// ═══════════════════════════════════════════════════════════════════════════

export function installMatrix(p5, fn) {

  // True for Float32Array, plain Array, or p5.Vector — the three accepted
  // point/direction types. Plain opts objects do not match.
  const _isVec = (v) => v != null &&
    (Array.isArray(v) || ArrayBuffer.isView(v) || v instanceof p5.Vector);

  // ── fn.treeHost ────────────────────────────────────────────────────────────

  /**
   * The sketch's host context — the `@nakednous/host` object behind every
   * handle, track, helm and stream p5.tree creates, one per canvas. Reach for
   * it when you want a host construct p5.tree has no verb for: `labels`, the
   * DOM text layer over the canvas, or `orbit`, the camera gesture that
   * replaces `orbitControl` on a camera state. Null before `createCanvas()`.
   *
   * @details
   * The host is created on first need and ticked by p5.tree's lifecycle:
   * predraw ticks its players and fills its view bag from the renderer,
   * postdraw re-syncs the bag and ticks the label layer if one exists, then
   * flushes the pointer source; `remove()` disposes it. A construct made
   * here registers with it, so it is released with the sketch.
   *
   * @function treeHost
   * @memberof p5
   * @returns {Object} The host, or null.
   * @example
   * <caption>Labels through the host: DOM text at a world anchor and in the HUD corner, no font needed</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   camera(200, -150, 300, 0, 0, 0, 0, 1, 0)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   const t = millis() / 1000
   *   const x = 100 * cos(t), z = 100 * sin(t)
   *   push()
   *   translate(x, -30, z)
   *   noStroke()
   *   fill('#ff4fd8')
   *   sphere(12)
   *   pop()
   *   const labels = treeHost().labels
   *   labels.set('ball', 'x ' + x.toFixed(0) + '  z ' + z.toFixed(0), x, -30, z, { dy: -20 })
   *   labels.setScreen('hud', 'orbit with the mouse', 10, 16, { anchor: 'left' })
   * }
   */
  fn.treeHost = function () { return ensureHost(this); };

  // Resolve opts.out for mapLocation / mapDirection.
  // Returns opts.out if provided, otherwise allocates a fresh p5.Vector.
  const _resolveOut = (opts) => opts?.out ?? new p5.Vector(0, 0, 0);

  // ── p5.Matrix utility ─────────────────────────────────────────────────────

  fn.createMatrix = (...args) => new p5.Matrix(...args);

  // ── Simple matrix queries ─────────────────────────────────────────────────
  //   out: Float32Array | ArrayLike | p5.Matrix — 16-element destination.

  /**
   * The current projection matrix, copied into your buffer. It follows the latest `p5.perspective()` or `p5.ortho()` call; needs a `p5.WEBGL` canvas.
   *
   * @details
   * Projection matrix (eye → clip) — reads live renderer state (perspective or ortho).
   *
   * @function mat4Proj
   * @memberof p5
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @returns {Float32Array|ArrayLike|p5.Matrix} out
   * @example
   * <caption>The live projection, dumped; press the mouse for ortho</caption>
   * const m = new Float32Array(16)
   *
   * async function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   textFont(await loadFont('fonts/noto_sans.ttf'))
   *   textSize(12)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   if (mouseIsPressed) ortho()
   *   else perspective()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   mat4Proj(m)
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   show(m, 10, 20)
   *   endHUD()
   * }
   *
   * // the four rows of a column-major mat4
   * function show(m, x, y) {
   *   for (let r = 0; r < 4; r++) {
   *     const row = [m[r], m[r + 4], m[r + 8], m[r + 12]]
   *     text(row.map(v => v.toFixed(2)).join('  '), x, y + r * 16)
   *   }
   * }
   */
  p5.Renderer3D.prototype.mat4Proj = function (out) {
    const buf = _rawMat4(out), s = _projMat4(this);
    for (let i = 0; i < 16; i++) buf[i] = s[i];
    return out;
  };
  fn.mat4Proj = function (out) { return this._renderer.mat4Proj(out); };

  /**
   * A second camera's own projection matrix, copied into your buffer. It follows whatever `p5.Camera.perspective`, `p5.Camera.ortho` or `p5.Camera.frustum` call that camera received; needs a `p5.WEBGL` canvas and a camera made with `p5.createCamera()`.
   *
   * @details
   * Projection matrix (eye → clip) of a specific p5.Camera.
   *
   * Reads from the camera's own `projMatrix` field, populated when
   * `cam.perspective()`, `cam.ortho()`, or `cam.frustum()` is called.
   * Symmetric with `cam.mat4View` / `cam.mat4Eye` which read from
   * `cam.cameraMatrix`.
   *
   * @function mat4Proj
   * @memberof p5.Camera
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @returns {Float32Array|ArrayLike|p5.Matrix} out
   * @example
   * <caption>A second camera's frustum from its own eye and projection matrices</caption>
   * let cam
   * const eye = new Float32Array(16)
   * const proj = new Float32Array(16)
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   camera(300, -200, 500, 0, 0, 0, 0, 1, 0)
   *   cam = createCamera()
   *   cam.camera(0, -80, 250, 0, 0, 0, 0, 1, 0)
   *   cam.perspective(PI / 4, width / height, 50, 350)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   stroke('#ffd166')
   *   viewFrustum({ mat4Eye: cam.mat4Eye(eye), mat4Proj: cam.mat4Proj(proj) })
   * }
   */
  p5.Camera.prototype.mat4Proj = function (out) {
    const buf = _rawMat4(out), s = this.projMatrix.mat4;
    for (let i = 0; i < 16; i++) buf[i] = s[i];
    return out;
  };

  /**
   * Builds a perspective projection matrix from six frustum bounds, without touching the camera. Pair it with `mat4Eye` to draw or use a virtual camera, as the example does; the optional depth-range arguments default to those of the current canvas.
   *
   * @details
   * Perspective projection matrix (standalone constructor, general frustum).
   * Symmetric: `left = -right`, `bottom = -top` — derive from fov + aspect in
   * user space. `ndcZMin` defaults to the renderer's backend convention.
   *
   * @function mat4Persp
   * @memberof p5
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @param {number} left
   * @param {number} right
   * @param {number} bottom
   * @param {number} top
   * @param {number} near
   * @param {number} far
   * @param {number} [ndcZMin]  {@link WEBGL} (−1) or {@link WEBGPU} (0).
   * @param {number} [ndcYSign]  Sign of the NDC y axis.
   * @returns {Float32Array|ArrayLike|p5.Matrix} out
   * @example
   * <caption>A frustum from numbers alone: a lookat eye plus a perspective projection</caption>
   * const eye = new Float32Array(16)
   * const proj = new Float32Array(16)
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   camera(300, -200, 500, 0, 0, 0, 0, 1, 0)
   *   mat4Eye(eye, 0, -80, 250, 0, 0, 0, 0, 1, 0)
   *   const near = 50, far = 350
   *   const top = near * tan(PI / 8), right = top * width / height
   *   mat4Persp(proj, -right, right, -top, top, near, far)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   stroke('#ffd166')
   *   viewFrustum({ mat4Eye: eye, mat4Proj: proj })
   * }
   */
  fn.mat4Persp = function (out, ...args) {
    if (args[6] == null) args[6] = _ndcZ;
    _mat4Persp(_rawMat4(out), ...args);
    return out;
  };

  /**
   * Builds an orthographic projection matrix from six box bounds, without touching the camera. Pair it with `mat4Eye` for a virtual camera, as the example does; the optional depth-range arguments default to those of the current canvas.
   *
   * @details
   * Orthographic projection matrix (standalone constructor). `ndcZMin`
   * defaults to the renderer's backend convention.
   *
   * @function mat4Ortho
   * @memberof p5
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @param {number} left
   * @param {number} right
   * @param {number} bottom
   * @param {number} top
   * @param {number} near
   * @param {number} far
   * @param {number} [ndcZMin]  {@link WEBGL} (−1) or {@link WEBGPU} (0).
   * @param {number} [ndcYSign]  Sign of the NDC y axis.
   * @returns {Float32Array|ArrayLike|p5.Matrix} out
   * @example
   * <caption>An orthographic box from numbers alone</caption>
   * const eye = new Float32Array(16)
   * const proj = new Float32Array(16)
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   camera(300, -200, 500, 0, 0, 0, 0, 1, 0)
   *   mat4Eye(eye, 0, -80, 250, 0, 0, 0, 0, 1, 0)
   *   mat4Ortho(proj, -80, 80, -60, 60, 50, 350)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   stroke('#ffd166')
   *   viewFrustum({ mat4Eye: eye, mat4Proj: proj })
   * }
   */
  fn.mat4Ortho = function (out, ...args) {
    if (args[6] == null) args[6] = _ndcZ;
    _mat4Ortho(_rawMat4(out), ...args);
    return out;
  };

  /**
   * The current transform stack as a matrix, copied into your buffer. Call it between `p5.push` and `p5.pop` to capture where `p5.translate`, `p5.rotate` and `p5.scale` have put you; needs a `p5.WEBGL` canvas.
   *
   * @details
   * Model matrix (local → world) — the current transform stack.
   *
   * @function mat4Model
   * @memberof p5
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @returns {Float32Array|ArrayLike|p5.Matrix} out
   * @example
   * <caption>The transform stack, read from inside push/pop</caption>
   * const m = new Float32Array(16)
   *
   * async function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   textFont(await loadFont('fonts/noto_sans.ttf'))
   *   textSize(12)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   push()
   *   translate(100 * sin(frameCount * 0.02), 0, 0)
   *   rotateY(frameCount * 0.01)
   *   mat4Model(m)
   *   stroke('#ff4fd8')
   *   noFill()
   *   box(40)
   *   pop()
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   show(m, 10, 20)
   *   endHUD()
   * }
   *
   * // the four rows of a column-major mat4
   * function show(m, x, y) {
   *   for (let r = 0; r < 4; r++) {
   *     const row = [m[r], m[r + 4], m[r + 8], m[r + 12]]
   *     text(row.map(v => v.toFixed(2)).join('  '), x, y + r * 16)
   *   }
   * }
   */
  p5.Renderer3D.prototype.mat4Model = function (out) {
    const buf = _rawMat4(out), s = _modelMat4(this);
    for (let i = 0; i < 16; i++) buf[i] = s[i];
    return out;
  };
  fn.mat4Model = function (out) { return this._renderer.mat4Model(out); };

  /**
   * A second camera's view matrix, copied into your buffer. Hand it to `mapLocation` to measure points as that camera sees them, as the example does; needs a `p5.WEBGL` canvas and a second camera.
   *
   * @details
   * View matrix (world → eye) of a specific p5.Camera.
   *
   * @function mat4View
   * @memberof p5.Camera
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @returns {Float32Array|ArrayLike|p5.Matrix} out
   * @example
   * <caption>Depth of a point as seen by a second camera</caption>
   * let cam
   * const view = new Float32Array(16)
   * const p = new Float32Array(3)
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
   *   noStroke()
   *   fill('#ff4fd8')
   *   push()
   *   translate(80, 0, 0)
   *   sphere(15)
   *   pop()
   *   stroke('#ffd166')
   *   noFill()
   *   viewFrustum({ camera: cam })
   *   // eye space looks down -z, so depth is the negated z
   *   mapLocation([80, 0, 0], {
   *     from: p5.Tree.WORLD, to: p5.Tree.EYE,
   *     out: p, mat4View: cam.mat4View(view)
   *   })
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   text('depth from cam ' + (-p[2]).toFixed(0), 10, 20)
   *   endHUD()
   * }
   */
  p5.Camera.prototype.mat4View = function (out) {
    const buf = _rawMat4(out), s = this.cameraMatrix.mat4;
    for (let i = 0; i < 16; i++) buf[i] = s[i];
    return out;
  };
  p5.Renderer3D.prototype.mat4View = function (out) { return this.states.curCamera.mat4View(out); };
  /**
   * The current camera's view matrix, copied into your buffer. Pass nine numbers after the buffer (eye, center, up) to build a standalone lookat instead, without touching the camera; needs a `p5.WEBGL` canvas.
   *
   * @details
   * View matrix (world → eye) — the current camera's, or a standalone lookat
   * built from nine scalars with no camera state involved.
   *
   * ```js
   * mat4View(out)                                // current camera
   * mat4View(out, ex,ey,ez, cx,cy,cz, ux,uy,uz)  // standalone lookat
   * ```
   *
   * @function mat4View
   * @memberof p5
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @param {...number} [lookat]  `ex, ey, ez, cx, cy, cz, ux, uy, uz`.
   * @returns {Float32Array|ArrayLike|p5.Matrix} out
   * @example
   * <caption>The live view matrix, dumped; orbit to watch it change</caption>
   * const v = new Float32Array(16)
   *
   * async function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   textFont(await loadFont('fonts/noto_sans.ttf'))
   *   textSize(12)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   mat4View(v)
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   show(v, 10, 20)
   *   endHUD()
   * }
   *
   * // the four rows of a column-major mat4
   * function show(m, x, y) {
   *   for (let r = 0; r < 4; r++) {
   *     const row = [m[r], m[r + 4], m[r + 8], m[r + 12]]
   *     text(row.map(v => v.toFixed(2)).join('  '), x, y + r * 16)
   *   }
   * }
   * @example
   * <caption>Standalone lookat: depth from a virtual camera, no camera state touched</caption>
   * const v = new Float32Array(16)
   * const p = new Float32Array(3)
   *
   * async function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   textFont(await loadFont('fonts/noto_sans.ttf'))
   *   textSize(14)
   *   mat4View(v, 200, -100, 300, 0, 0, 0, 0, 1, 0)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   const q = [120 * cos(frameCount * 0.02), 0, 120 * sin(frameCount * 0.02)]
   *   noStroke()
   *   fill('#ff4fd8')
   *   push()
   *   translate(q[0], q[1], q[2])
   *   sphere(12)
   *   pop()
   *   fill('#ffd166')
   *   push()
   *   translate(200, -100, 300)
   *   sphere(8)
   *   pop()
   *   stroke('#ffd166')
   *   line(200, -100, 300, 0, 0, 0)
   *   mapLocation(q, { from: p5.Tree.WORLD, to: p5.Tree.EYE, out: p, mat4View: v })
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   text('depth from the virtual eye ' + (-p[2]).toFixed(0), 10, 20)
   *   endHUD()
   * }
   */
  fn.mat4View = function (out, ...args) {
    if (args.length === 0) return this._renderer.mat4View(out);
    _mat4View(_rawMat4(out), ...args);
    return out;
  };

  /**
   * A second camera's placement in the world as a matrix, copied into your buffer. Apply it with `p5.applyMatrix` to draw something at that camera, as the example does; needs a `p5.WEBGL` canvas and a second camera.
   *
   * @details
   * Eye matrix (eye → world, the inverse view) of a specific p5.Camera.
   *
   * @function mat4Eye
   * @memberof p5.Camera
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @returns {Float32Array|ArrayLike|p5.Matrix|null} out, or null if singular.
   * @example
   * <caption>The camera body drawn from its own eye matrix</caption>
   * let cam
   * const eye = new Float32Array(16)
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
   *   const t = frameCount * 0.01
   *   cam.camera(250 * sin(t), -80, 250 * cos(t), 0, 0, 0, 0, 1, 0)
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   push()
   *   applyMatrix(...cam.mat4Eye(eye))
   *   axes({ size: 40, bits: p5.Tree.X | p5.Tree.Y | p5.Tree._Z })
   *   stroke('#ffd166')
   *   box(20, 20, 30)
   *   pop()
   * }
   */
  p5.Camera.prototype.mat4Eye = function (out) {
    const buf = _rawMat4(out);
    return mat4Invert(buf, this.cameraMatrix.mat4) === null ? null : out;
  };
  p5.Renderer3D.prototype.mat4Eye = function (out) { return this.states.curCamera.mat4Eye(out); };
  /**
   * The current camera's placement in the world as a matrix, copied into your buffer; its last column is the camera position. Pass nine numbers after the buffer (eye, center, up) to build a standalone lookat instead, without touching the camera; needs a `p5.WEBGL` canvas.
   *
   * @details
   * Eye matrix (eye → world, the inverse view) — the current camera's, or a
   * standalone lookat built from nine scalars with no camera state involved.
   *
   * ```js
   * mat4Eye(out)                                // current camera
   * mat4Eye(out, ex,ey,ez, cx,cy,cz, ux,uy,uz)  // standalone lookat
   * ```
   *
   * @function mat4Eye
   * @memberof p5
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @param {...number} [lookat]  `ex, ey, ez, cx, cy, cz, ux, uy, uz`.
   * @returns {Float32Array|ArrayLike|p5.Matrix|null} out, or null if singular.
   * @example
   * <caption>Current camera: the last column is the camera position</caption>
   * const e = new Float32Array(16)
   *
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
   *   mat4Eye(e)
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   text('eye ' + [e[12], e[13], e[14]].map(v => v.toFixed(0)).join('  '), 10, 20)
   *   endHUD()
   * }
   * @example
   * <caption>Standalone lookat: a virtual camera's frustum, no camera state touched</caption>
   * const eye = new Float32Array(16)
   * const proj = new Float32Array(16)
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   camera(300, -200, 500, 0, 0, 0, 0, 1, 0)
   *   mat4Eye(eye, 0, -80, 250, 0, 0, 0, 0, 1, 0)
   *   const near = 50, far = 350
   *   const top = near * tan(PI / 8), right = top * width / height
   *   mat4Persp(proj, -right, right, -top, top, near, far)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   stroke('#ffd166')
   *   viewFrustum({ mat4Eye: eye, mat4Proj: proj })
   * }
   */
  fn.mat4Eye = function (out, ...args) {
    if (args.length === 0) return this._renderer.mat4Eye(out);
    _mat4Eye(_rawMat4(out), ...args);
    return out;
  };

  // ── Composite matrix queries ──────────────────────────────────────────────
  //   opts may supply precomputed matrices to skip redundant multiplications.

  /**
   * The projection and view matrices combined, copied into your buffer. Compute it once per frame and pass it as `mat4PV` to `mapLocation` to project many points cheaply, as the example does; needs a `p5.WEBGL` canvas.
   *
   * @details
   * Projection-view matrix: P · V.
   *
   * @function mat4PV
   * @memberof p5
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @param {{ mat4Proj?, mat4View? }} [opts]  Precomputed matrices to skip redundant work.
   * @returns {Float32Array|ArrayLike|p5.Matrix} out
   * @example
   * <caption>One PV per frame projects every corner: HUD dots pinned to a box</caption>
   * const pv = new Float32Array(16)
   * const pts = new Float32Array(24)
   * const s = new Float32Array(3)
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(80)
   *   mat4PV(pv)
   *   for (let i = 0; i < 8; i++) {
   *     const c = [i & 1 ? 40 : -40, i & 2 ? 40 : -40, i & 4 ? 40 : -40]
   *     mapLocation(c, { from: p5.Tree.WORLD, to: p5.Tree.SCREEN, out: s, mat4PV: pv })
   *     pts.set(s, i * 3)
   *   }
   *   beginHUD()
   *   noStroke()
   *   fill('#ff4fd8')
   *   for (let i = 0; i < 8; i++) circle(pts[i * 3], pts[i * 3 + 1], 8)
   *   endHUD()
   * }
   */
  p5.Renderer3D.prototype.mat4PV = function (out, { mat4Proj, mat4View } = {}) {
    mat4Mul(_rawMat4(out), _rawMat4(mat4Proj) ?? _projMat4(this), _rawMat4(mat4View) ?? _viewMat4(this));
    return out;
  };
  fn.mat4PV = function (out, opts) { return this._renderer.mat4PV(out, opts); };

  /**
   * The inverse of the combined projection and view matrices, copied into your buffer; returns null when it cannot be inverted. Pass a precomputed `mat4PV` in the options to skip that multiplication, then hand both to `mapLocation` for screen-to-world work, as the example does; needs a `p5.WEBGL` canvas.
   *
   * @details
   * Inverse projection-view matrix: inv(P · V).
   * Pass mat4PV to skip recomputing P · V.
   *
   * @function mat4PVInv
   * @memberof p5
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @param {{ mat4Proj?, mat4View?, mat4PV? }} [opts]  Precomputed matrices to skip redundant work.
   * @returns {Float32Array|ArrayLike|p5.Matrix|null} out, or null if singular.
   * @example
   * <caption>Unproject the mouse at the depth of the origin, PV and its inverse precomputed</caption>
   * const pv = new Float32Array(16)
   * const ipv = new Float32Array(16)
   * const s = new Float32Array(3)
   * const w = new Float32Array(3)
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   mat4PV(pv)
   *   mat4PVInv(ipv, { mat4PV: pv })
   *   // the origin's screen depth, then the mouse pushed to that depth
   *   mapLocation({ from: p5.Tree.WORLD, to: p5.Tree.SCREEN, out: s, mat4PV: pv })
   *   mapLocation([mouseX, mouseY, s[2]], {
   *     from: p5.Tree.SCREEN, to: p5.Tree.WORLD,
   *     out: w, mat4PV: pv, mat4PVInv: ipv
   *   })
   *   noStroke()
   *   fill('#ff4fd8')
   *   push()
   *   translate(w[0], w[1], w[2])
   *   sphere(10)
   *   pop()
   *   stroke('white')
   *   line(0, 0, 0, w[0], w[1], w[2])
   * }
   */
  p5.Renderer3D.prototype.mat4PVInv = function (out, { mat4Proj, mat4View, mat4PV } = {}) {
    const pv = _rawMat4(mat4PV) ??
      (mat4Mul(_pv, _rawMat4(mat4Proj) ?? _projMat4(this), _rawMat4(mat4View) ?? _viewMat4(this)), _pv);
    return mat4Invert(_rawMat4(out), pv) === null ? null : out;
  };
  fn.mat4PVInv = function (out, opts) { return this._renderer.mat4PVInv(out, opts); };

  /**
   * The transform stack as seen from the current camera, copied into your buffer. Its last column gives the eye-space position of the local origin, which the example uses as a depth; needs a `p5.WEBGL` canvas.
   *
   * @details
   * Model-view matrix: V · M.
   *
   * @function mat4MV
   * @memberof p5
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @param {{ mat4Model?, mat4View? }} [opts]  Precomputed matrices to skip redundant work.
   * @returns {Float32Array|ArrayLike|p5.Matrix} out
   * @example
   * <caption>Eye-space depth from the modelview's last column: the nearer sphere lights up</caption>
   * const mv = new Float32Array(16)
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   noStroke()
   *   const t = frameCount * 0.02
   *   const a = [80 * cos(t), 0, 80 * sin(t)]
   *   const b = [-a[0], 0, -a[2]]
   *   const da = depth(a), db = depth(b)
   *   ball(a, da < db)
   *   ball(b, db < da)
   * }
   *
   * function depth(p) {
   *   push()
   *   translate(p[0], p[1], p[2])
   *   mat4MV(mv)
   *   pop()
   *   return -mv[14]   // eye space looks down -z
   * }
   *
   * function ball(p, near) {
   *   push()
   *   translate(p[0], p[1], p[2])
   *   fill(near ? '#ff4fd8' : 'white')
   *   sphere(20)
   *   pop()
   * }
   */
  p5.Renderer3D.prototype.mat4MV = function (out, { mat4Model, mat4View } = {}) {
    mat4Mul(_rawMat4(out), _rawMat4(mat4View) ?? _viewMat4(this), _rawMat4(mat4Model) ?? _modelMat4(this));
    return out;
  };
  fn.mat4MV = function (out, opts) { return this._renderer.mat4MV(out, opts); };

  /**
   * The full clip-space transform for what you are about to draw, copied into your buffer. Feed it to a custom vertex shader as a uniform, as the example does; needs a `p5.WEBGL` canvas.
   *
   * @details
   * Projection-model-view matrix: P · V · M.
   *
   * @function mat4PMV
   * @memberof p5
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @param {{ mat4Proj?, mat4Model?, mat4View? }} [opts]  Precomputed matrices to skip redundant work.
   * @returns {Float32Array|ArrayLike|p5.Matrix} out
   * @example
   * <caption>Your own clip transform, fed to a custom vertex shader</caption>
   * let sh
   * const pmv = new Float32Array(16)
   *
   * const vert = `#version 300 es
   * precision highp float;
   * in vec4 aPosition;
   * uniform mat4 uPMV;
   * void main() {
   *   gl_Position = uPMV * aPosition;
   * }`
   *
   * const frag = `#version 300 es
   * precision highp float;
   * out vec4 outColor;
   * void main() {
   *   outColor = vec4(1.0, 0.31, 0.85, 1.0);
   * }`
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   sh = createShader(vert, frag)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   push()
   *   rotateY(frameCount * 0.01)
   *   rotateX(frameCount * 0.007)
   *   shader(sh)
   *   sh.setUniform('uPMV', mat4PMV(pmv))
   *   noStroke()
   *   torus(50, 20)
   *   pop()
   * }
   */
  p5.Renderer3D.prototype.mat4PMV = function (out, { mat4Proj, mat4Model, mat4View } = {}) {
    mat4Mul(_wa, _rawMat4(mat4View) ?? _viewMat4(this), _rawMat4(mat4Model) ?? _modelMat4(this));
    mat4Mul(_rawMat4(out), _rawMat4(mat4Proj) ?? _projMat4(this), _wa);
    return out;
  };
  fn.mat4PMV = function (out, opts) { return this._renderer.mat4PMV(out, opts); };

  /**
   * The 3×3 matrix that carries surface normals into eye space for lighting, copied into your buffer. Pass a precomputed `mat4MV` in the options to skip redundant work, and feed the result to a custom shader as the example does; needs a `p5.WEBGL` canvas.
   *
   * @details
   * Normal matrix: inverseTranspose(upper 3×3 of V · M).
   * Pass mat4MV to skip recomputing V · M.
   *
   * @function mat3Normal
   * @memberof p5
   * @param {Float32Array|ArrayLike|p5.Matrix} out  9-element destination.
   * @param {{ mat4Model?, mat4View?, mat4MV? }} [opts]  Precomputed matrices to skip redundant work.
   * @returns {Float32Array|ArrayLike|p5.Matrix} out
   * @example
   * <caption>Lambert shading with your own normal matrix</caption>
   * let sh
   * const pmv = new Float32Array(16)
   * const n = new Float32Array(9)
   *
   * const vert = `#version 300 es
   * precision highp float;
   * in vec4 aPosition;
   * in vec3 aNormal;
   * uniform mat4 uPMV;
   * uniform mat3 uN;
   * out vec3 vN;
   * void main() {
   *   vN = normalize(uN * aNormal);
   *   gl_Position = uPMV * aPosition;
   * }`
   *
   * const frag = `#version 300 es
   * precision highp float;
   * in vec3 vN;
   * out vec4 outColor;
   * void main() {
   *   float d = max(0.0, dot(vN, normalize(vec3(0.4, -0.6, 1.0))));
   *   outColor = vec4(vec3(1.0, 0.31, 0.85) * (0.3 + 0.7 * d), 1.0);
   * }`
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   sh = createShader(vert, frag)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   push()
   *   rotateY(frameCount * 0.01)
   *   rotateX(frameCount * 0.007)
   *   shader(sh)
   *   sh.setUniform('uPMV', mat4PMV(pmv))
   *   sh.setUniform('uN', mat3Normal(n))
   *   noStroke()
   *   torus(50, 20)
   *   pop()
   * }
   */
  p5.Renderer3D.prototype.mat3Normal = function (out, { mat4Model, mat4View, mat4MV } = {}) {
    const mv = _rawMat4(mat4MV) ??
      (mat4Mul(_wa, _rawMat4(mat4View) ?? _viewMat4(this), _rawMat4(mat4Model) ?? _modelMat4(this)), _wa);
    mat3NormalFromMat4(_rawMat3(out), mv);
    return out;
  };
  fn.mat3Normal = function (out, opts) { return this._renderer.mat3Normal(out, opts); };

  /**
   * The matrix that takes points expressed in one frame into another frame's coordinates, copied into your buffer. Both frames are model matrices such as those captured with `mat4Model`; returns null when the target frame cannot be inverted.
   *
   * @details
   * Location transform between frames: out = inv(to) · from.
   *
   * @function mat4Location
   * @memberof p5
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @param {Float32Array|ArrayLike|p5.Matrix} from
   * @param {Float32Array|ArrayLike|p5.Matrix} to
   * @returns {Float32Array|ArrayLike|p5.Matrix|null} out, or null if `to` is singular.
   * @example
   * <caption>Frame A's origin in frame B's coordinates: a line drawn inside B lands on A</caption>
   * const a = new Float32Array(16)
   * const b = new Float32Array(16)
   * const L = new Float32Array(16)
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   noFill()
   *   // frame A orbits the origin
   *   push()
   *   rotateY(frameCount * 0.01)
   *   translate(120, 0, 0)
   *   mat4Model(a)
   *   stroke('#ff4fd8')
   *   box(30)
   *   pop()
   *   // frame B spins in place
   *   push()
   *   translate(0, -60, 0)
   *   rotateX(frameCount * 0.02)
   *   mat4Model(b)
   *   stroke('#ffd166')
   *   box(30)
   *   // A's origin in B's coordinates is the last column of L
   *   mat4Location(L, a, b)
   *   stroke('white')
   *   line(0, 0, 0, L[12], L[13], L[14])
   *   pop()
   * }
   */
  p5.Renderer3D.prototype.mat4Location = function (out, from, to) {
    return mat4Location(_rawMat4(out), _rawMat4(from), _rawMat4(to)) === null ? null : out;
  };
  fn.mat4Location = function (out, from, to) { return this._renderer.mat4Location(out, from, to); };

  /**
   * The 3×3 matrix that converts a direction's coordinates from one frame to another, ignoring translation, copied into your buffer. Both frames are model matrices such as those captured with `mat4Model`; the same conversion `mapDirection` does between frames. Returns null when the destination frame cannot be inverted.
   *
   * @details
   * Direction transform between frames: out = inv(to₃) · from₃, the upper-left
   * 3×3 blocks only — the direction counterpart of `mat4Location`.
   *
   * @function mat3Direction
   * @memberof p5
   * @param {Float32Array|ArrayLike|p5.Matrix} out  9-element destination.
   * @param {Float32Array|ArrayLike|p5.Matrix} from
   * @param {Float32Array|ArrayLike|p5.Matrix} to
   * @returns {Float32Array|ArrayLike|p5.Matrix|null} out, or null if `to` is singular.
   * @example
   * <caption>A direction given in frame A, expressed in frame B: drawn inside each frame, the two lines stay parallel</caption>
   * const a = new Float32Array(16)
   * const b = new Float32Array(16)
   * const D = new Float32Array(9)
   * const d = [0.6, -0.8, 0]   // a direction in frame A's coordinates
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   noFill()
   *   // frame A spins about y; the direction is drawn in A's own coordinates
   *   push()
   *   translate(-90, 0, 0)
   *   rotateY(frameCount * 0.01)
   *   mat4Model(a)
   *   stroke('#ff4fd8')
   *   box(30)
   *   axes({ size: 40 })
   *   stroke('white')
   *   line(0, 0, 0, 60 * d[0], 60 * d[1], 60 * d[2])
   *   pop()
   *   // frame B spins about x; the same direction, converted to B's coordinates
   *   push()
   *   translate(90, 0, 0)
   *   rotateX(frameCount * 0.02)
   *   mat4Model(b)
   *   stroke('#ffd166')
   *   box(30)
   *   axes({ size: 40 })
   *   mat3Direction(D, a, b)
   *   const e = mul3(D, d)
   *   stroke('white')
   *   line(0, 0, 0, 60 * e[0], 60 * e[1], 60 * e[2])
   *   pop()
   * }
   *
   * // column-major mat3 times vec3
   * function mul3(m, v) {
   *   return [
   *     m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
   *     m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
   *     m[2] * v[0] + m[5] * v[1] + m[8] * v[2]
   *   ]
   * }
   */
  p5.Renderer3D.prototype.mat3Direction = function (out, from, to) {
    return mat3Direction(_rawMat3(out), _rawMat4(from), _rawMat4(to)) === null ? null : out;
  };
  fn.mat3Direction = function (out, from, to) { return this._renderer.mat3Direction(out, from, to); };

  // ── Raw math forwarders ───────────────────────────────────────────────────
  //   For sketches that need custom matrix arithmetic (e.g. bias·lightPV for
  //   shadow mapping) without importing @nakednous/tree directly.

  /**
   * Multiplies two matrices into your buffer. Applying the product places the second matrix's frame inside the first one's, as the example shows.
   *
   * @details
   * Matrix product: out = A · B (column-major).
   *
   * @function mat4Mul
   * @memberof p5
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @param {Float32Array|ArrayLike|p5.Matrix} A
   * @param {Float32Array|ArrayLike|p5.Matrix} B
   * @returns {Float32Array|ArrayLike|p5.Matrix} out
   * @example
   * <caption>A · B places B inside A's frame</caption>
   * const a = new Float32Array(16)
   * const b = new Float32Array(16)
   * const c = new Float32Array(16)
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   noFill()
   *   push()
   *   rotateY(frameCount * 0.01)
   *   translate(100, 0, 0)
   *   mat4Model(a)
   *   stroke('#ff4fd8')
   *   box(30)
   *   pop()
   *   push()
   *   rotateZ(frameCount * 0.03)
   *   translate(0, 50, 0)
   *   mat4Model(b)
   *   stroke('#ffd166')
   *   box(30)
   *   pop()
   *   mat4Mul(c, a, b)
   *   push()
   *   applyMatrix(...c)
   *   stroke('white')
   *   box(30)
   *   pop()
   * }
   */
  p5.Renderer3D.prototype.mat4Mul = function (out, A, B) {
    mat4Mul(_rawMat4(out), _rawMat4(A), _rawMat4(B));
    return out;
  };
  fn.mat4Mul = function (out, A, B) { return this._renderer.mat4Mul(out, A, B); };

  /**
   * Inverts a matrix into your buffer, or returns null when it cannot be inverted. Applying a transform and then its inverse lands you back where you started, as the example shows.
   *
   * @details
   * Matrix inverse: out = inv(src).
   *
   * @function mat4Invert
   * @memberof p5
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @param {Float32Array|ArrayLike|p5.Matrix} src
   * @returns {Float32Array|ArrayLike|p5.Matrix|null} out, or null if singular.
   * @example
   * <caption>M · inv(M) = I: undo the stack from inside it</caption>
   * const m = new Float32Array(16)
   * const inv = new Float32Array(16)
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   noFill()
   *   push()
   *   rotateY(frameCount * 0.01)
   *   translate(100, 0, 0)
   *   rotateX(frameCount * 0.02)
   *   mat4Model(m)
   *   stroke('#ff4fd8')
   *   box(30)
   *   applyMatrix(...mat4Invert(inv, m))
   *   stroke('white')
   *   box(30)   // back at the world origin, unrotated
   *   pop()
   * }
   */
  p5.Renderer3D.prototype.mat4Invert = function (out, src) {
    return mat4Invert(_rawMat4(out), _rawMat4(src)) === null ? null : out;
  };
  fn.mat4Invert = function (out, src) { return this._renderer.mat4Invert(out, src); };

  // ── Decomposition ─────────────────────────────────────────────────────────────────────────────
  //   Extract components from an existing mat4 — matrix → information.
  //   m is normalised via _rawMat4 (handles Float32Array | ArrayLike | p5.Matrix).
  //   out3: Float32Array | number[] | p5.Vector — p5.Vector written back via _tmp3.
  //   out4: Float32Array | number[] only — quaternion is 4-component, no p5.Vector.

  /**
   * Reads the position part of a matrix into a 3-element buffer or `p5.Vector`. Handy for finding where a nested transform stack ended up, as the example shows.
   *
   * @details
   * Extract the translation (column 3) of a mat4.
   *
   * @function mat4ToTranslation
   * @memberof p5
   * @param {Float32Array|number[]|p5.Vector} out3  3-element destination.
   * @param {Float32Array|ArrayLike|p5.Matrix} m
   * @returns {Float32Array|number[]|p5.Vector} out3
   * @example
   * <caption>Where a nested transform stack ends up</caption>
   * const m = new Float32Array(16)
   * const t = new Float32Array(3)
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   push()
   *   rotateY(frameCount * 0.01)
   *   translate(120, 0, 0)
   *   rotateZ(frameCount * 0.03)
   *   translate(0, 40, 0)
   *   mat4Model(m)
   *   noFill()
   *   stroke('#ff4fd8')
   *   box(20)
   *   pop()
   *   mat4ToTranslation(t, m)
   *   stroke('white')
   *   line(0, 0, 0, t[0], t[1], t[2])
   * }
   */
  fn.mat4ToTranslation = function (out3, m) {
    const isVec = out3 instanceof p5.Vector;
    const buf = isVec ? _tmp3 : out3;
    mat4ToTranslation(buf, _rawMat4(m));
    if (isVec) { out3.x = buf[0]; out3.y = buf[1]; out3.z = buf[2]; }
    return out3;
  };

  /**
   * Reads the scale part of a matrix into a 3-element buffer or `p5.Vector`. Works for transforms built from `p5.translate`, `p5.rotate` and `p5.scale`, as in the example.
   *
   * @details
   * Extract the scale (column vector lengths) of a mat4. Assumes no shear.
   *
   * @function mat4ToScale
   * @memberof p5
   * @param {Float32Array|number[]|p5.Vector} out3  3-element destination.
   * @param {Float32Array|ArrayLike|p5.Matrix} m
   * @returns {Float32Array|number[]|p5.Vector} out3
   * @example
   * <caption>Scale recovered from a transform, re-applied to a clone</caption>
   * const m = new Float32Array(16)
   * const s = new Float32Array(3)
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   noFill()
   *   push()
   *   translate(-80, 0, 0)
   *   rotateY(frameCount * 0.02)
   *   scale(1 + 0.5 * sin(frameCount * 0.03), 1, 1 + 0.5 * cos(frameCount * 0.03))
   *   mat4Model(m)
   *   stroke('#ff4fd8')
   *   box(40)
   *   pop()
   *   mat4ToScale(s, m)
   *   push()
   *   translate(80, 0, 0)
   *   scale(s[0], s[1], s[2])
   *   stroke('#ffd166')
   *   box(40)
   *   pop()
   * }
   */
  fn.mat4ToScale = function (out3, m) {
    const isVec = out3 instanceof p5.Vector;
    const buf = isVec ? _tmp3 : out3;
    mat4ToScale(buf, _rawMat4(m));
    if (isVec) { out3.x = buf[0]; out3.y = buf[1]; out3.z = buf[2]; }
    return out3;
  };

  /**
   * Reads the rotation part of a matrix into a 4-element quaternion buffer. Re-apply it with `rotateQuat` to give another object the same orientation, as the example does.
   *
   * @details
   * Extract the rotation of a mat4 as a unit quaternion [x,y,z,w]. Assumes no shear.
   *
   * @function mat4ToRotation
   * @memberof p5
   * @param {Float32Array|number[]} out4  4-element destination.
   * @param {Float32Array|ArrayLike|p5.Matrix} m
   * @returns {Float32Array|number[]} out4
   * @example
   * <caption>Orientation recovered as a quaternion, re-applied to a clone</caption>
   * const m = new Float32Array(16)
   * const q = [0, 0, 0, 1]
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   noFill()
   *   push()
   *   translate(-80, 0, 0)
   *   rotateY(frameCount * 0.02)
   *   rotateX(frameCount * 0.013)
   *   mat4Model(m)
   *   stroke('#ff4fd8')
   *   box(40)
   *   pop()
   *   mat4ToRotation(q, m)
   *   push()
   *   translate(80, 0, 0)
   *   rotateQuat(q)
   *   axes({ size: 40 })
   *   stroke('#ffd166')
   *   box(40)
   *   pop()
   * }
   */
  fn.mat4ToRotation = function (out4, m) {
    mat4ToRotation(out4, _rawMat4(m));
    return out4;
  };

  // ── Projection scalar queries ─────────────────────────────────────────────
  //   Read scalars from the current projection matrix — no buffer needed.

  p5.Renderer3D.prototype.projIsOrtho = function () { return projIsOrtho(_projMat4(this)); };
  p5.Renderer3D.prototype.projNear    = function () { return projNear   (_projMat4(this), _ndcZ); };
  p5.Renderer3D.prototype.projFar     = function () { return projFar    (_projMat4(this)); };
  p5.Renderer3D.prototype.projLeft    = function () { return projLeft   (_projMat4(this), _ndcZ); };
  p5.Renderer3D.prototype.projRight   = function () { return projRight  (_projMat4(this), _ndcZ); };
  p5.Renderer3D.prototype.projTop     = function () { return projTop    (_projMat4(this), _ndcZ); };
  p5.Renderer3D.prototype.projBottom  = function () { return projBottom (_projMat4(this), _ndcZ); };
  p5.Renderer3D.prototype.projFov     = function () { return projFov    (_projMat4(this)); };
  p5.Renderer3D.prototype.projHfov    = function () { return projHfov   (_projMat4(this)); };

  /** Whether the current projection is orthographic.
   * @function projIsOrtho
   * @memberof p5
   * @returns {boolean}
   * @example
   * <caption>Perspective, or orthographic while the mouse is pressed</caption>
   * async function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   textFont(await loadFont('fonts/noto_sans.ttf'))
   *   textSize(14)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   if (mouseIsPressed) ortho()
   *   else perspective()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   text(projIsOrtho() ? 'ortho' : 'perspective', 10, 20)
   *   endHUD()
   * }
   */
  fn.projIsOrtho = function () { return this._renderer.projIsOrtho(); };
  /** Near clip distance of the current projection (positive).
   * @function projNear
   * @memberof p5
   * @returns {number}
   * @example
   * <caption>Near and far read back; the mouse drives near through the box</caption>
   * async function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   textFont(await loadFont('fonts/noto_sans.ttf'))
   *   textSize(14)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   perspective(PI / 3, width / height, map(mouseX, 0, width, 500, 1000), 2000)   // the box sits 800 from the eye
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   text('near ' + projNear().toFixed(0) + '   far ' + projFar().toFixed(0), 10, 20)
   *   endHUD()
   * }
   */
  fn.projNear    = function () { return this._renderer.projNear();    };
  /** Far clip distance of the current projection (positive).
   * @function projFar
   * @memberof p5
   * @returns {number}
   * @example
   * <caption>Near and far read back; the mouse drives far through the box</caption>
   * async function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   textFont(await loadFont('fonts/noto_sans.ttf'))
   *   textSize(14)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   perspective(PI / 3, width / height, 50, map(mouseX, 0, width, 600, 1200))   // the box sits 800 from the eye
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   text('near ' + projNear().toFixed(0) + '   far ' + projFar().toFixed(0), 10, 20)
   *   endHUD()
   * }
   */
  fn.projFar     = function () { return this._renderer.projFar();     };
  /** Left extent of the current projection's near plane (camera space; negative).
   * @function projLeft
   * @memberof p5
   * @returns {number}
   * @example
   * <caption>Near-plane extents of a perspective whose fov follows the mouse</caption>
   * async function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   textFont(await loadFont('fonts/noto_sans.ttf'))
   *   textSize(14)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   perspective(map(mouseX, 0, width, PI / 6, PI / 2), width / height, 50, 1000)
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   text('left ' + projLeft().toFixed(1) + '   right ' + projRight().toFixed(1), 10, 20)
   *   text('bottom ' + projBottom().toFixed(1) + '   top ' + projTop().toFixed(1), 10, 40)
   *   endHUD()
   * }
   */
  fn.projLeft    = function () { return this._renderer.projLeft();    };
  /** Right extent of the current projection's near plane (camera space).
   * @function projRight
   * @memberof p5
   * @returns {number}
   * @example
   * <caption>Near-plane extents of a perspective whose fov follows the mouse</caption>
   * async function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   textFont(await loadFont('fonts/noto_sans.ttf'))
   *   textSize(14)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   perspective(map(mouseX, 0, width, PI / 6, PI / 2), width / height, 50, 1000)
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   text('left ' + projLeft().toFixed(1) + '   right ' + projRight().toFixed(1), 10, 20)
   *   text('bottom ' + projBottom().toFixed(1) + '   top ' + projTop().toFixed(1), 10, 40)
   *   endHUD()
   * }
   */
  fn.projRight   = function () { return this._renderer.projRight();   };
  /** Top extent of the current projection's near plane (camera space).
   * @function projTop
   * @memberof p5
   * @returns {number}
   * @example
   * <caption>Near-plane extents of a perspective whose fov follows the mouse</caption>
   * async function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   textFont(await loadFont('fonts/noto_sans.ttf'))
   *   textSize(14)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   perspective(map(mouseX, 0, width, PI / 6, PI / 2), width / height, 50, 1000)
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   text('left ' + projLeft().toFixed(1) + '   right ' + projRight().toFixed(1), 10, 20)
   *   text('bottom ' + projBottom().toFixed(1) + '   top ' + projTop().toFixed(1), 10, 40)
   *   endHUD()
   * }
   */
  fn.projTop     = function () { return this._renderer.projTop();     };
  /** Bottom extent of the current projection's near plane (camera space; negative).
   * @function projBottom
   * @memberof p5
   * @returns {number}
   * @example
   * <caption>Near-plane extents of a perspective whose fov follows the mouse</caption>
   * async function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   textFont(await loadFont('fonts/noto_sans.ttf'))
   *   textSize(14)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   perspective(map(mouseX, 0, width, PI / 6, PI / 2), width / height, 50, 1000)
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   text('left ' + projLeft().toFixed(1) + '   right ' + projRight().toFixed(1), 10, 20)
   *   text('bottom ' + projBottom().toFixed(1) + '   top ' + projTop().toFixed(1), 10, 40)
   *   endHUD()
   * }
   */
  fn.projBottom  = function () { return this._renderer.projBottom();  };
  /** Vertical field of view of the current projection, in radians.
   * @function projFov
   * @memberof p5
   * @returns {number}
   * @example
   * <caption>Vertical and horizontal fov, the vertical one driven by the mouse</caption>
   * async function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   textFont(await loadFont('fonts/noto_sans.ttf'))
   *   textSize(14)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   perspective(map(mouseX, 0, width, PI / 6, PI / 2), width / height, 50, 1000)
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   text('fov ' + degrees(projFov()).toFixed(0) + '   hfov ' + degrees(projHfov()).toFixed(0), 10, 20)
   *   endHUD()
   * }
   */
  fn.projFov     = function () { return this._renderer.projFov();     };
  /** Horizontal field of view of the current projection, in radians.
   * @function projHfov
   * @memberof p5
   * @returns {number}
   * @example
   * <caption>Vertical and horizontal fov, the vertical one driven by the mouse</caption>
   * async function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   textFont(await loadFont('fonts/noto_sans.ttf'))
   *   textSize(14)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   perspective(map(mouseX, 0, width, PI / 6, PI / 2), width / height, 50, 1000)
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   text('fov ' + degrees(projFov()).toFixed(0) + '   hfov ' + degrees(projHfov()).toFixed(0), 10, 20)
   *   endHUD()
   * }
   */
  fn.projHfov    = function () { return this._renderer.projHfov();    };

  // ── _buildBag ─────────────────────────────────────────────────────────────
  //   Builds the matrices bag for _mapLocation / _mapDirection.
  //   from / to: space-string constant or mat4 for a custom MATRIX frame.
  //   _wb holds toFrameInv; valid until coreMap* returns.

  function _buildBag(renderer, options, from, to) {
    const bag = {
      mat4Proj: _rawMat4(options.mat4Proj) ?? _projMat4(renderer),
      mat4View: _rawMat4(options.mat4View) ?? _viewMat4(renderer),
      mat4Eye: null, mat4PV: null, mat4PVInv: null,
    };
    let fromStr, toStr;
    if (from != null && typeof from !== 'string') {
      bag.fromFrame = _rawMat4(from); fromStr = MATRIX;
    } else { fromStr = from; }
    if (to != null && typeof to !== 'string') {
      const toRaw = _rawMat4(to);
      mat4Invert(_wb, toRaw);
      bag.toFrameInv = _wb; bag.toFrame = toRaw; toStr = MATRIX;
    } else { toStr = to; }
    return { bag, fromStr, toStr };
  }

  // ── mapLocation ───────────────────────────────────────────────────────────

  fn.mapLocation = function (...args) { return this._renderer.mapLocation(...args); };

  /**
   * Converts a point from one coordinate space to another: world, screen, eye, NDC, the model transform stack, or any matrix frame. Pick the spaces with the `from` and `to` options (eye to world by default); pass an `out` buffer to reuse it frame after frame, or omit it to get a fresh `p5.Vector` back. Needs a `p5.WEBGL` canvas.
   *
   * @details
   * Map a point between coordinate spaces.
   *
   * Hot path (zero-alloc):  pass `opts.out` as a caller-owned buffer.
   * Ergonomic path:         omit `opts.out`; a fresh p5.Vector is returned.
   *
   * @function mapLocation
   * @memberof p5
   * @param {Float32Array|number[]|p5.Vector} [point]  Input point. Default: `ORIGIN`.
   * @param {{
   *   out?:       Float32Array | number[] | p5.Vector,
   *   from?:      string | Float32Array | number[] | p5.Matrix,
   *   to?:        string | Float32Array | number[] | p5.Matrix,
   *   mat4Eye?:   Float32Array | number[] | p5.Matrix,
   *   mat4Proj?:  Float32Array | number[] | p5.Matrix,
   *   mat4View?:  Float32Array | number[] | p5.Matrix,
   *   mat4PV?:    Float32Array | number[] | p5.Matrix,
   *   mat4PVInv?: Float32Array | number[] | p5.Matrix,
   * }} [opts]
   * @returns {Float32Array|number[]|p5.Vector}  `opts.out` if provided, else a fresh `p5.Vector`.
   * @example
   * <caption>WORLD to SCREEN: a HUD label pinned to a 3D point</caption>
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
   *   const p = [100 * cos(frameCount * 0.02), -40, 100 * sin(frameCount * 0.02)]
   *   noStroke()
   *   fill('#ff4fd8')
   *   push()
   *   translate(p[0], p[1], p[2])
   *   sphere(10)
   *   pop()
   *   const s = mapLocation(p, { from: p5.Tree.WORLD, to: p5.Tree.SCREEN })
   *   beginHUD()
   *   fill('white')
   *   text('(' + p.map(v => v.toFixed(0)).join(', ') + ')', s.x + 12, s.y + 4)
   *   endHUD()
   * }
   * @example
   * <caption>SCREEN to WORLD: the mouse, pushed to the depth of the origin</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   const o = mapLocation({ from: p5.Tree.WORLD, to: p5.Tree.SCREEN })
   *   const w = mapLocation([mouseX, mouseY, o.z], { from: p5.Tree.SCREEN, to: p5.Tree.WORLD })
   *   noStroke()
   *   fill('#ff4fd8')
   *   push()
   *   translate(w.x, w.y, w.z)
   *   sphere(10)
   *   pop()
   *   stroke('white')
   *   line(0, 0, 0, w.x, w.y, w.z)
   * }
   * @example
   * <caption>MODEL to WORLD: where the transform stack put the origin</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   push()
   *   rotateY(frameCount * 0.01)
   *   translate(120, 0, 0)
   *   rotateZ(frameCount * 0.03)
   *   translate(0, 40, 0)
   *   const w = mapLocation({ from: p5.Tree.MODEL })
   *   noFill()
   *   stroke('#ff4fd8')
   *   box(20)
   *   pop()
   *   stroke('white')
   *   line(0, 0, 0, w.x, w.y, w.z)
   * }
   */
  p5.Renderer3D.prototype.mapLocation = function (...args) {
    const hasVec = _isVec(args[0]);
    const point  = hasVec ? args[0] : p5.Tree.ORIGIN;
    const opts   = (hasVec ? args[1] : args[0]) ?? {};

    const out = _resolveOut(opts);

    const px = point.x ?? point[0] ?? 0;
    const py = point.y ?? point[1] ?? 0;
    const pz = point.z ?? point[2] ?? 0;

    let from = opts.from ?? p5.Tree.EYE;
    let to   = opts.to   ?? p5.Tree.WORLD;
    if (from === p5.Tree.MODEL) from = _modelMat4(this);
    if (to   === p5.Tree.MODEL) to   = _modelMat4(this);

    const { bag, fromStr, toStr } = _buildBag(this, opts, from, to);

    if (fromStr === EYE || toStr === EYE ||
        fromStr === SCREEN || toStr === SCREEN ||
        fromStr === NDC    || toStr === NDC) {
      bag.mat4Eye = _rawMat4(opts.mat4Eye) ??
        (mat4Invert(_wa, bag.mat4View), _wa);
    }
    if (toStr === SCREEN || toStr === NDC || fromStr === SCREEN || fromStr === NDC) {
      bag.mat4PV = _rawMat4(opts.mat4PV) ??
        (mat4Mul(_pv, bag.mat4Proj, bag.mat4View), _pv);
      if (fromStr === SCREEN || fromStr === NDC) {
        bag.mat4PVInv = _rawMat4(opts.mat4PVInv) ??
          (mat4Invert(_ipv, bag.mat4PV), _ipv);
      }
    }

    _vp[0] = 0; _vp[1] = this.height; _vp[2] = this.width; _vp[3] = -this.height;

    const isVecOut = out instanceof p5.Vector;
    const buf = isVecOut ? _tmp3 : out;
    _mapLocation(buf, px, py, pz, fromStr, toStr, bag, _vp, _ndcZ);
    if (isVecOut) { out.x = buf[0]; out.y = buf[1]; out.z = buf[2]; }
    return out;
  };

  // ── mapDirection ──────────────────────────────────────────────────────────

  fn.mapDirection = function (...args) { return this._renderer.mapDirection(...args); };

  /**
   * Converts a direction from one coordinate space to another, ignoring translation. Pick the spaces with the `from` and `to` options (eye to world by default, so with no arguments it returns the camera's look direction); pass an `out` buffer to reuse it frame after frame, or omit it to get a fresh `p5.Vector` back. Needs a `p5.WEBGL` canvas.
   *
   * @details
   * Map a direction between coordinate spaces.
   *
   * Hot path (zero-alloc):  pass `opts.out` as a caller-owned buffer.
   * Ergonomic path:         omit `opts.out`; a fresh p5.Vector is returned.
   *
   * @function mapDirection
   * @memberof p5
   * @param {Float32Array|number[]|p5.Vector} [dir]  Input direction. Default: −Z (look direction).
   * @param {{
   *   out?:      Float32Array | number[] | p5.Vector,
   *   from?:     string | Float32Array | number[] | p5.Matrix,
   *   to?:       string | Float32Array | number[] | p5.Matrix,
   *   mat4Eye?:  Float32Array | number[] | p5.Matrix,
   *   mat4Proj?: Float32Array | number[] | p5.Matrix,
   *   mat4View?: Float32Array | number[] | p5.Matrix,
   * }} [opts]
   * @returns {Float32Array|number[]|p5.Vector}  `opts.out` if provided, else a fresh `p5.Vector`.
   * @example
   * <caption>EYE to WORLD, the default: the camera's look direction</caption>
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
   *   const d = mapDirection()
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   text('look ' + [d.x, d.y, d.z].map(v => v.toFixed(2)).join('  '), 10, 20)
   *   endHUD()
   * }
   * @example
   * <caption>MODEL to WORLD: a spinning object's local X, drawn at the world origin</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   push()
   *   translate(100, 0, 0)
   *   rotateY(frameCount * 0.01)
   *   rotateZ(frameCount * 0.02)
   *   const x = mapDirection([1, 0, 0], { from: p5.Tree.MODEL })
   *   noFill()
   *   stroke('#ff4fd8')
   *   box(30)
   *   axes({ size: 60 })
   *   pop()
   *   stroke('#ffd166')
   *   line(0, 0, 0, 60 * x.x, 60 * x.y, 60 * x.z)
   * }
   */
  p5.Renderer3D.prototype.mapDirection = function (...args) {
    const hasVec = _isVec(args[0]);
    const dir    = hasVec ? args[0] : p5.Tree._k;
    const opts   = (hasVec ? args[1] : args[0]) ?? {};

    const out = _resolveOut(opts);

    const dx = dir.x ?? dir[0] ?? 0;
    const dy = dir.y ?? dir[1] ?? 0;
    const dz = dir.z ?? dir[2] ?? 0;

    let from = opts.from ?? p5.Tree.EYE;
    let to   = opts.to   ?? p5.Tree.WORLD;
    if (from === p5.Tree.MODEL) from = _modelMat4(this);
    if (to   === p5.Tree.MODEL) to   = _modelMat4(this);

    const { bag, fromStr, toStr } = _buildBag(this, opts, from, to);

    bag.mat4Eye = _rawMat4(opts.mat4Eye) ??
      (mat4Invert(_wa, bag.mat4View), _wa);

    _vp[0] = 0; _vp[1] = this.height; _vp[2] = this.width; _vp[3] = -this.height;

    const isVecOut = out instanceof p5.Vector;
    const buf = isVecOut ? _tmp3 : out;
    _mapDirection(buf, dx, dy, dz, fromStr, toStr, bag, _vp, _ndcZ);
    if (isVecOut) { out.x = buf[0]; out.y = buf[1]; out.z = buf[2]; }
    return out;
  };

  // ── pixelRatio ────────────────────────────────────────────────────────────

  /**
   * How many world units one screen pixel covers at a given world position, so you can draw things at a constant on-screen size, as the example does. The position is optional; needs a `p5.WEBGL` canvas.
   *
   * @details
   * World-units-per-pixel at a world position (the world origin when omitted).
   *
   * @function pixelRatio
   * @memberof p5
   * @param {Float32Array|number[]|p5.Vector} [worldPos]
   * @param {{ mat4Proj?, mat4View? }} [opts]
   * @returns {number}
   * @example
   * <caption>A constant screen-size dot: world radius = pixels × pixelRatio</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   const p = [100, 0, 100 * sin(frameCount * 0.01)]
   *   noStroke()
   *   push()
   *   translate(p[0], p[1], p[2])
   *   fill('#ff4fd8')
   *   sphere(8 * pixelRatio(p))   // 8 px on screen at any zoom
   *   pop()
   *   push()
   *   translate(-100, 0, 0)
   *   fill('white')
   *   sphere(8)                   // 8 world units: shrinks and grows
   *   pop()
   * }
   */
  p5.Renderer3D.prototype.pixelRatio = function (worldPos, { mat4Proj, mat4View } = {}) {
    const proj = _rawMat4(mat4Proj) ?? _projMat4(this);
    const view = _rawMat4(mat4View) ?? _viewMat4(this);
    let eyeZ;
    if (worldPos) {
      const wx = worldPos.x ?? worldPos[0] ?? 0;
      const wy = worldPos.y ?? worldPos[1] ?? 0;
      const wz = worldPos.z ?? worldPos[2] ?? 0;
      eyeZ = view[2]*wx + view[6]*wy + view[10]*wz + view[14];
    } else {
      eyeZ = view[14];
    }
    return corePixelRatio(proj, this.height, eyeZ, _ndcZ);
  };
  fn.pixelRatio = function (worldPos, opts) { return this._renderer.pixelRatio(worldPos, opts); };

  // ── drawingBufferSize ────────────────────────────────────────────────────────────

  /**
   * The canvas size in window space — the drawing buffer's physical (device) pixels, accounting for pixel density. Pass it to a shader as its resolution uniform, as the example does; needs a `p5.WEBGL` canvas.
   *
   * @details
   * Window space's size in device pixels: [pixelDensity×width, pixelDensity×height].
   * Use as `u_resolution` for shaders that use `gl_FragCoord.xy`.
   *
   * @function drawingBufferSize
   * @memberof p5
   * @returns {number[]} [w, h]
   * @example
   * <caption>gl_FragCoord normalised by the physical canvas size</caption>
   * let sh
   *
   * const vert = `#version 300 es
   * precision highp float;
   * in vec4 aPosition;
   * uniform mat4 uProjectionMatrix;
   * uniform mat4 uModelViewMatrix;
   * void main() {
   *   gl_Position = uProjectionMatrix * uModelViewMatrix * aPosition;
   * }`
   *
   * const frag = `#version 300 es
   * precision highp float;
   * uniform vec2 u_resolution;
   * out vec4 outColor;
   * void main() {
   *   vec2 uv = gl_FragCoord.xy / u_resolution;
   *   vec3 c = mix(vec3(1.0), vec3(1.0, 0.31, 0.85), uv.x) * (0.5 + 0.5 * uv.y);
   *   outColor = vec4(c, 1.0);
   * }`
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   sh = createShader(vert, frag)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   shader(sh)
   *   sh.setUniform('u_resolution', drawingBufferSize())
   *   noStroke()
   *   plane(width / 2, height / 2)   // canvas coordinates: only the middle of the gradient shows
   * }
   */
  p5.Renderer3D.prototype.drawingBufferSize = function () {
    const pd = this._pInst.pixelDensity();
    return [pd * this.width, pd * this.height];
  };
  fn.drawingBufferSize = function () { return this._renderer.drawingBufferSize(); };

  // ── fragCoord ─────────────────────────────────────────────────────────────

  /**
   * The `gl_FragCoord` of a screen-space pixel, the mouse by default. Pass it to a shader as its pointer uniform beside `drawingBufferSize()`, as the example does; needs a `p5.WEBGL` canvas.
   *
   * @details
   * Screen space (logical pixels, top-left, y down, what `mouseX` / `mouseY` count) to
   * window space (the drawing buffer's device pixels, bottom-left, y up):
   * [x×pixelDensity, (height − y)×pixelDensity].
   * Also the coordinates a pixel readback takes.
   *
   * @function fragCoord
   * @memberof p5
   * @param {number} [x=mouseX]  Canvas x.
   * @param {number} [y=mouseY]  Canvas y, down.
   * @returns {number[]} [fx, fy]
   * @example
   * <caption>Move the mouse over the canvas: an amber disc 40 device pixels in radius follows it — the fragment shader compares its own gl_FragCoord with uMouse, the mouse's.</caption>
   * let sh
   *
   * const vert = `#version 300 es
   * precision highp float;
   * in vec4 aPosition;
   * uniform mat4 uProjectionMatrix;
   * uniform mat4 uModelViewMatrix;
   * void main() {
   *   gl_Position = uProjectionMatrix * uModelViewMatrix * aPosition;
   * }`
   *
   * const frag = `#version 300 es
   * precision highp float;
   * uniform vec2 uMouse;
   * out vec4 outColor;
   * void main() {
   *   float d = distance(gl_FragCoord.xy, uMouse);
   *   outColor = vec4(mix(vec3(1.0, 0.82, 0.4), vec3(0.075, 0.553, 0.459), smoothstep(38.0, 42.0, d)), 1.0);
   * }`
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   sh = createShader(vert, frag)
   * }
   *
   * function draw() {
   *   shader(sh)
   *   sh.setUniform('uMouse', fragCoord())
   *   noStroke()
   *   plane(width, height)
   * }
   */
  p5.Renderer3D.prototype.fragCoord = function (x, y) {
    const p = this._pInst, pd = p.pixelDensity();
    if (x == null) x = p.mouseX;
    if (y == null) y = p.mouseY;
    return [x * pd, (this.height - y) * pd];
  };
  fn.fragCoord = function (x, y) { return this._renderer.fragCoord(x, y); };

  // ── texelSize ─────────────────────────────────────────────────────────────

  /**
   * The size of one texel of an image, framebuffer or graphics, as a fraction of its width and height. Pass it to a shader to step between neighbouring pixels, as the example does.
   *
   * @details
   * Texel size of an image-like object over its pixel density: [1/(width×pd), 1/(height×pd)],
   * the size of one texel of the texture actually sampled — a framebuffer, a graphics or an
   * image on a dense display holds pd× more texels than its canvas size says. The density is
   * `img.pixelDensity()` when the object has it, `img.density` else, 1 for a plain `{ width, height }`.
   * Accepts p5.Image, p5.Framebuffer, p5.Graphics, or any `{ width, height }`.
   *
   * @function texelSize
   * @memberof p5
   * @param {{ width:number, height:number }} img
   * @returns {number[]} [1/(w×pd), 1/(h×pd)]
   * @example
   * <caption>Neighbour sampling in a custom shader, stepped by one texel</caption>
   * let img, sh
   *
   * const vert = `#version 300 es
   * precision highp float;
   * in vec4 aPosition;
   * in vec2 aTexCoord;
   * uniform mat4 uProjectionMatrix;
   * uniform mat4 uModelViewMatrix;
   * out vec2 vUv;
   * void main() {
   *   vUv = aTexCoord;
   *   gl_Position = uProjectionMatrix * uModelViewMatrix * aPosition;
   * }`
   *
   * const frag = `#version 300 es
   * precision highp float;
   * uniform sampler2D uTex;
   * uniform vec2 uTexel;
   * uniform float uRadius;
   * in vec2 vUv;
   * out vec4 outColor;
   * void main() {
   *   vec4 sum = vec4(0.0);
   *   for (int i = -1; i <= 1; i++) {
   *     for (int j = -1; j <= 1; j++) {
   *       sum += texture(uTex, vUv + vec2(i, j) * uTexel * uRadius);
   *     }
   *   }
   *   outColor = sum / 9.0;
   * }`
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   // a procedural checker
   *   img = createImage(64, 64)
   *   const a = color('#ff4fd8'), b = color('white')
   *   img.loadPixels()
   *   for (let y = 0; y < 64; y++) {
   *     for (let x = 0; x < 64; x++) img.set(x, y, ((x >> 3) + (y >> 3)) & 1 ? a : b)
   *   }
   *   img.updatePixels()
   *   sh = createShader(vert, frag)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   shader(sh)
   *   sh.setUniform('uTex', img)
   *   sh.setUniform('uTexel', texelSize(img))
   *   sh.setUniform('uRadius', map(mouseX, 0, width, 0, 3))   // blur in texel steps
   *   noStroke()
   *   plane(240, 240)
   * }
   */
  fn.texelSize = function (img) {
    const pd = (typeof img.pixelDensity === 'function' ? img.pixelDensity() : img.density) || 1;
    return [1 / (img.width * pd), 1 / (img.height * pd)];
  };
}
