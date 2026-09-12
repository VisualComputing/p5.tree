/**
 * @file Picking — GPU color-ID picking and CPU proximity tests.
 * @module p5.tree/picking
 * @license AGPL-3.0-only
 *
 * ### GPU color-ID picking
 *
 * Technique: render the scene into a 1×1 FBO with a pick-matrix projection
 * aligned to the query pixel, read back RGBA via gl.readPixels, decode the
 * 24-bit integer id from RGB with the core's id codec (R the low byte).
 *
 * id 0 is reserved for background / miss.
 * Valid user ids: 1 – 16 777 215 (2²⁴ − 1).
 *
 * ```
 * Encoding: tag(id) → '#rrggbb'   idToRgba as the CSS hex fill() wants; tag(1) === '#010000'
 * Decoding: rgbaToId(r, g, b)     on the readback bytes
 * ```
 *
 * ### CPU proximity picking
 *
 * The core's pointerHit: is the pointer within a radius of the projected
 * screen-space origin of the current model matrix? Zero GPU round-trip.
 * Call inside push()/pop() for each pickable object. The shape option is
 * p5.Tree.CIRCLE / SQUARE, mapped to the core's constants at the seam (p5
 * owns the SQUARE global).
 *
 * ### API symmetry
 *
 * ```js
 * colorPick(x, y, drawFn)   // GPU — base form
 * mousePick(drawFn)         // GPU — shorthand for colorPick(mouseX, mouseY, fn)
 *
 * pointerHit(x, y, opts)    // CPU — base form
 * mouseHit(opts)            // CPU — shorthand for pointerHit(mouseX, mouseY, opts)
 * ```
 */

'use strict';

import {
  mat4Pick, mat4ToTranslation, idToRgba, rgbaToId,
  pointerHit as corePointerHit, CIRCLE, SQUARE,
} from '@nakednous/tree';
import { pvBag, viewport, getNdcZ } from './matrix.js';

// ═══════════════════════════════════════════════════════════════════════════
// Module-level zero-alloc buffers
// ═══════════════════════════════════════════════════════════════════════════

const _pickBuf      = new Uint8Array(4);      // gl.readPixels target
const _pickProjSave = new Float32Array(16);   // saved projection before fbo.begin()
const _pickViewSave = new Float32Array(16);   // saved view before fbo.begin()
const _pickVp       = new Float32Array(4);    // viewport [0, h, w, −h] for mat4Pick
const _rgba         = [0, 0, 0, 0];           // idToRgba scratch for tag
const _wl           = new Float32Array(3);    // world location scratch for pointerHit

// ═══════════════════════════════════════════════════════════════════════════
// Local helpers
// ═══════════════════════════════════════════════════════════════════════════

const _rawMat4   = (m) => (m != null && m.mat4 != null) ? m.mat4 : m;
const _modelMat4 = (r) => r.states.uModelMatrix.mat4;
const _hex       = (v) => Math.round(v * 255).toString(16).padStart(2, '0');

// ═══════════════════════════════════════════════════════════════════════════
// Install
// ═══════════════════════════════════════════════════════════════════════════

export function installPicking(p5, fn) {

  // ── tag ───────────────────────────────────────────────────────────────────

  /**
   * Encode an integer id as a CSS hex color string for use with `p5.fill()`.
   * id `0` is reserved — decodes as background / miss.
   *
   * @function tag
   * @memberof p5
   * @param {number} id  Integer in [1, 16_777_215].
   * @returns {string}   CSS hex string, e.g. `'#010000'` for id `1`.
   * @example
   * <caption>What the pick buffer sees: ids as near-black fills</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   noStroke()
   *   push()
   *   translate(-70, 0, 0)
   *   fill(tag(1))
   *   box(50)
   *   pop()
   *   push()
   *   translate(70, 0, 0)
   *   fill(tag(2))
   *   sphere(35)
   *   pop()
   * }
   */
  fn.tag = function (id) {
    idToRgba(_rgba, id);
    return '#' + _hex(_rgba[0]) + _hex(_rgba[1]) + _hex(_rgba[2]);
  };

  // ── colorPick ─────────────────────────────────────────────────────────────

  /**
   * Pick the object under a canvas pixel: `drawFn` renders the scene off-screen
   * with each object filled by its tag colour, and the id found at that pixel is
   * returned — 0 when nothing is there (see the example). Needs a `p5.WEBGL` canvas;
   * lights, strokes and shaders are switched off for the pick pass.
   *
   * @details
   * Render `drawFn` into a cached 1×1 framebuffer aligned to pixel (px, py),
   * then read back and decode the integer id under that pixel.
   *
   * Before `drawFn` is called the library unconditionally sets
   * `noLights()`, `noStroke()`, `resetShader()`.
   * The FBO is lazily allocated on first use and released in `lifecycles.remove`.
   *
   * @function colorPick
   * @memberof p5
   * @param {number}   px      X coordinate in canvas CSS pixels.
   * @param {number}   py      Y coordinate in canvas CSS pixels.
   * @param {function} drawFn  Scene draw callback — tag objects with `fill(tag(id))`.
   * @returns {number}         Decoded id (0 = background / miss).
   * @example
   * <caption>Pick at the canvas centre; orbit to bring an object under the cross</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   const hit = colorPick(width / 2, height / 2, () => scene(tag))
   *   axes()
   *   stroke('white')
   *   scene(id => hit === id ? '#ff4fd8' : 'white')
   *   cross({ x: width / 2, y: height / 2, size: 20 })
   * }
   *
   * // one geometry serves both passes; paint(id) decides the fill
   * function scene(paint) {
   *   push()
   *   translate(-70, 0, 0)
   *   fill(paint(1))
   *   box(50)
   *   pop()
   *   push()
   *   translate(70, 0, 0)
   *   fill(paint(2))
   *   sphere(35)
   *   pop()
   * }
   */
  fn.colorPick = function (px, py, drawFn) {
    const p        = this;
    const renderer = p._renderer;
    const states   = renderer.states;

    // Save projection and view BEFORE fbo.begin() overwrites them.
    const mainProj = states.uPMatrix.mat4;
    for (let i = 0; i < 16; i++) _pickProjSave[i] = mainProj[i];
    const mainView = states.uViewMatrix.mat4;
    for (let i = 0; i < 16; i++) _pickViewSave[i] = mainView[i];

    // Lazy-allocate the 1×1 pick FBO.
    p._tree          ||= {};
    p._tree._pickFbo ??= p.createFramebuffer({
      width: 1, height: 1,
      depth: true,       // depth test selects nearest hit, not draw order
      antialias: false,  // blending would corrupt encoded integer colors
    });
    const fbo = p._tree._pickFbo;

    fbo.begin();

    // Restore view; install pick projection.
    const view = states.uViewMatrix.mat4;
    for (let i = 0; i < 16; i++) view[i] = _pickViewSave[i];
    const proj = states.uPMatrix.mat4;
    for (let i = 0; i < 16; i++) proj[i] = _pickProjSave[i];

    // Viewport [0, h, w, −h] — negative h encodes p5/DOM screen-y-down.
    _pickVp[0]=0; _pickVp[1]=p.height; _pickVp[2]=p.width; _pickVp[3]=-p.height;
    mat4Pick(proj, px, py, _pickVp);

    p.background(0);
    p.noLights();
    p.noStroke();
    p.resetShader();

    let hit = 0;
    try {
      drawFn();
      renderer.drawingContext.readPixels(
        0, 0, 1, 1,
        renderer.drawingContext.RGBA,
        renderer.drawingContext.UNSIGNED_BYTE,
        _pickBuf,
      );
      hit = rgbaToId(_pickBuf[0], _pickBuf[1], _pickBuf[2]);
    } finally {
      fbo.end();
    }

    return hit;
  };

  // ── mousePick ─────────────────────────────────────────────────────────────

  /**
   * Shorthand for `colorPick(mouseX, mouseY, drawFn)`.
   * @function mousePick
   * @memberof p5
   * @param {function} drawFn  Scene draw callback — tag objects with `fill(tag(id))`.
   * @returns {number}  Decoded id (0 = background / miss).
   * @example
   * <caption>Hover to highlight</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   const hit = mousePick(() => scene(tag))
   *   axes()
   *   stroke('white')
   *   scene(id => hit === id ? '#ff4fd8' : 'white')
   * }
   *
   * // one geometry serves both passes; paint(id) decides the fill
   * function scene(paint) {
   *   push()
   *   translate(-70, 0, 0)
   *   fill(paint(1))
   *   box(50)
   *   pop()
   *   push()
   *   translate(70, 0, 0)
   *   fill(paint(2))
   *   sphere(35)
   *   pop()
   * }
   */
  fn.mousePick = function (drawFn) {
    return this.colorPick(this.mouseX, this.mouseY, drawFn);
  };

  // ── pointerHit ────────────────────────────────────────────────────────────

  fn.pointerHit = function (...args) { return this._renderer.pointerHit(...args); };

  /**
   * Test whether the pointer is over the current model's origin, within a hit
   * zone `size` wide in world units at that depth — a cheap proximity test with
   * no GPU readback (see the hover example). With explicit `x`, `y` in the options
   * the test is made in screen space and the size is in pixels (see the
   * sweeping-point example). Needs a `p5.WEBGL` canvas; call it inside `p5.push()`/`p5.pop()` for
   * each pickable object.
   *
   * @details
   * Test whether a pointer position falls within a radius of the current
   * model's screen-space origin. CPU — zero GPU round-trip.
   * Call inside `push()`/`pop()` for each pickable object. `size` is the hit
   * diameter in world units at the origin's depth; a point behind the camera
   * or outside the clip range never hits, and the boundary hits. With
   * explicit `x`, `y` the test is a screen-space one and `size` is in px.
   *
   * @function pointerHit
   * @memberof p5
   * @param {number}  [pointerX]  Defaults to `p5.mouseX`.
   * @param {number}  [pointerY]  Defaults to `p5.mouseY`.
   * @param {{
   *   mat4Model?:  Float32Array | ArrayLike | p5.Matrix,
   *   x?, y?,
   *   size?:       number,
   *   shape?:      number,
   *   mat4Eye?:    Float32Array | ArrayLike | p5.Matrix,
   *   mat4Proj?:   Float32Array | ArrayLike | p5.Matrix,
   *   mat4View?:   Float32Array | ArrayLike | p5.Matrix,
   *   mat4PV?:     Float32Array | ArrayLike | p5.Matrix,
   * }} [opts]
   * @returns {boolean}
   * @example
   * <caption>Proximity test at an explicit, sweeping screen point</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   const x = width / 2 + 120 * sin(frameCount * 0.02)
   *   const y = height / 2
   *   stroke('white')
   *   push()
   *   translate(-70, 0, 0)
   *   fill(pointerHit(x, y, { size: 60 }) ? '#ff4fd8' : 'white')
   *   box(50)
   *   pop()
   *   push()
   *   translate(70, 0, 0)
   *   fill(pointerHit(x, y, { size: 70 }) ? '#ff4fd8' : 'white')
   *   sphere(35)
   *   pop()
   *   cross({ x, y, size: 20 })
   * }
   */
  p5.Renderer3D.prototype.pointerHit = function (...args) {
    let pointerX, pointerY;
    const config = {};
    for (const arg of args) {
      if (typeof arg === 'number' && Number.isFinite(arg)) {
        pointerX == null ? pointerX = arg : pointerY = arg;
      } else if (arg && typeof arg === 'object') { Object.assign(config, arg); }
    }
    const p = this._pInst;
    if (pointerX == null) pointerX = p ? p.mouseX : this.width  / 2;
    if (pointerY == null) pointerY = p ? p.mouseY : this.height / 2;

    const { mat4Model, x, y, size = 50, shape = p5.Tree.CIRCLE, mat4Proj, mat4View } = config;
    // The seam: p5.Tree's shape constants → the core's (p5 owns the SQUARE global).
    const kind = shape === p5.Tree.SQUARE ? SQUARE : CIRCLE;

    if (x != null && y != null) {
      // An explicit screen point carries no world depth: a px-sized test.
      const r = size / 2, dx = x - pointerX, dy = y - pointerY;
      return kind === SQUARE
        ? Math.abs(dx) <= r && Math.abs(dy) <= r
        : dx*dx + dy*dy <= r*r;
    }
    // The model origin in WORLD; the hit radius from world units to px at its depth.
    mat4ToTranslation(_wl, _rawMat4(mat4Model) ?? _modelMat4(this));
    const radius = size / (2 * this.pixelRatio(_wl, { mat4Proj, mat4View }));
    return corePointerHit(pointerX, pointerY, _wl[0], _wl[1], _wl[2], radius,
                          pvBag(this, config, false), viewport(this), getNdcZ(), kind);
  };

  // ── mouseHit ──────────────────────────────────────────────────────────────

  /**
   * Shorthand for `pointerHit(mouseX, mouseY, opts)`.
   * @function mouseHit
   * @memberof p5
   * @param {{
   *   mat4Model?:  Float32Array | ArrayLike | p5.Matrix,
   *   x?, y?,
   *   size?:       number,
   *   shape?:      number,
   *   mat4Eye?:    Float32Array | ArrayLike | p5.Matrix,
   *   mat4Proj?:   Float32Array | ArrayLike | p5.Matrix,
   *   mat4View?:   Float32Array | ArrayLike | p5.Matrix,
   *   mat4PV?:     Float32Array | ArrayLike | p5.Matrix,
   * }} [opts]
   * @returns {boolean}
   * @example
   * <caption>Hover test per object; the hit zone drawn as a bulls-eye</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   push()
   *   translate(-70, 0, 0)
   *   fill(mouseHit({ size: 60 }) ? '#ff4fd8' : 'white')
   *   box(50)
   *   bullsEye({ size: 60 })
   *   pop()
   *   push()
   *   translate(70, 0, 0)
   *   fill(mouseHit({ size: 80, shape: p5.Tree.SQUARE }) ? '#ff4fd8' : 'white')
   *   sphere(35)
   *   bullsEye({ size: 80, shape: p5.Tree.SQUARE })
   *   pop()
   * }
   */
  fn.mouseHit = function (opts) {
    return this._renderer.pointerHit(this.mouseX, this.mouseY, opts);
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FBO lifecycle
// ═══════════════════════════════════════════════════════════════════════════

// Release the cached pick FBO. Called from lifecycles.remove.
export function releasePickFbo(pInst) {
  const fbo = pInst._tree?._pickFbo;
  if (fbo) { fbo.remove(); delete pInst._tree._pickFbo; }
}
