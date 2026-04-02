/**
 * @file Picking — GPU color-ID picking and CPU proximity tests.
 * @module p5.tree/picking
 * @license AGPL-3.0-only
 *
 * ── GPU color-ID picking ──────────────────────────────────────────────────
 *
 * Technique: render the scene into a 1×1 FBO with a pick-matrix projection
 * aligned to the query pixel, read back RGBA via gl.readPixels, decode the
 * 24-bit integer id from RGB (R = LSB).
 *
 * id 0 is reserved for background / miss.
 * Valid user ids: 1 – 16 777 215 (2²⁴ − 1).
 *
 * Encoding: tag(id) → '#rrggbb'   e.g. tag(1) === '#010000'
 * Decoding: R | (G << 8) | (B << 16)
 *
 * ── CPU proximity picking ─────────────────────────────────────────────────
 *
 * Tests whether a pointer position falls within a radius of the projected
 * screen-space origin of the current model matrix. Zero GPU round-trip.
 * Call inside push()/pop() for each pickable object.
 *
 * ── API symmetry ──────────────────────────────────────────────────────────
 *
 *   colorPick(x, y, drawFn)   GPU — base form
 *   mousePick(drawFn)         GPU — shorthand for colorPick(mouseX, mouseY, fn)
 *
 *   pointerHit(x, y, opts)    CPU — base form (renderer method)
 *   mouseHit(opts)            CPU — shorthand for pointerHit(mouseX, mouseY, opts)
 */

'use strict';

import { mat4Pick } from '@nakednous/tree';

// ═══════════════════════════════════════════════════════════════════════════
// Module-level zero-alloc buffers
// ═══════════════════════════════════════════════════════════════════════════

/** gl.readPixels target — reused every call. */
const _pickBuf = new Uint8Array(4);

/**
 * Saves the main-canvas projection before fbo.begin() overwrites it.
 * fbo.begin() calls renderer.push() then sets uPMatrix to the FBO's own
 * default-camera projection — we capture the original first.
 */
const _pickProjSave = new Float32Array(16);

/**
 * Saves the main-canvas view matrix before fbo.begin() overwrites it.
 * fbo.begin() also resets uViewMatrix to the FBO's default camera — which
 * has no knowledge of orbitControl() or any user camera transform.
 */
const _pickViewSave = new Float32Array(16);

/**
 * Viewport passed to mat4Pick: [0, canvasH, canvasW, −canvasH].
 * Negative h encodes p5/DOM screen-y-down convention — rebuilt each pick call
 * since canvas dimensions may change.
 */
const _pickVp = new Float32Array(4);

/** Screen-location scratch for pointerHit. */
const _sl = new Float32Array(3);

/** World-location scratch for pointerHit pixelRatio scaling. */
const _wl = new Float32Array(3);

// ═══════════════════════════════════════════════════════════════════════════
// Local helpers — zero alloc
// ═══════════════════════════════════════════════════════════════════════════

const _rawMat4   = (m) => (m != null && m.mat4 != null) ? m.mat4 : m;
const _modelMat4 = (r) => r.states.uModelMatrix.mat4;

// ═══════════════════════════════════════════════════════════════════════════
// Install
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Install picking methods on fn and p5.Renderer3D.
 * @param {p5}    p5
 * @param {Object} fn  p5 prototype.
 */
export function installPicking(p5, fn) {

  // ── tag ───────────────────────────────────────────────────────────────────

  /**
   * Encode an integer id as a CSS hex color string for use with `fill()`.
   * id `0` is reserved — decodes as background / miss.
   *
   * @method tag
   * @for p5
   * @param {number} id  Integer in [1, 16_777_215].
   * @returns {string}   CSS hex string, e.g. `'#010000'` for id `1`.
   */
  fn.tag = function (id) {
    const r= id        & 0xff;
    const g=(id >>  8) & 0xff;
    const b=(id >> 16) & 0xff;
    return '#'+r.toString(16).padStart(2,'0')+g.toString(16).padStart(2,'0')+b.toString(16).padStart(2,'0');
  };

  // ── colorPick ─────────────────────────────────────────────────────────────

  /**
   * Render `drawFn` into a cached 1×1 framebuffer aligned to pixel (px, py),
   * then read back and decode the integer id under that pixel.
   *
   * Before `drawFn` is called the library unconditionally sets
   * `noLights()`, `noStroke()`, `resetShader()`.
   * The FBO is lazily allocated on first use and released in `lifecycles.remove`.
   *
   * @method colorPick
   * @for p5
   * @param {number}   px      X coordinate in canvas CSS pixels.
   * @param {number}   py      Y coordinate in canvas CSS pixels.
   * @param {function} drawFn  Scene draw callback — tag objects with fill(tag(id)).
   * @returns {number}         Decoded id (0 = background / miss).
   */
  fn.colorPick = function (px, py, drawFn) {
    const p        = this;
    const renderer = p._renderer;
    const states   = renderer.states;

    // ── 1. Save projection and view BEFORE fbo.begin() ─────────────────────
    //       fbo.begin() calls renderer.push() then overwrites both uPMatrix
    //       and uViewMatrix with the FBO's own default-camera matrices.
    const mainProj = states.uPMatrix.mat4;
    for (let i = 0; i < 16; i++) _pickProjSave[i] = mainProj[i];

    const mainView = states.uViewMatrix.mat4;
    for (let i = 0; i < 16; i++) _pickViewSave[i] = mainView[i];

    // ── 2. Lazy-allocate the 1×1 pick FBO ──────────────────────────────────
    p._tree          ||= {};
    p._tree._pickFbo ??= p.createFramebuffer({
      width: 1, height: 1,
      depth: true,       // depth test selects nearest hit, not draw order
      antialias: false,  // blending would corrupt encoded integer colors
    });
    const fbo = p._tree._pickFbo;

    // ── 3. Enter FBO ────────────────────────────────────────────────────────
    fbo.begin();

    // ── 4. Restore view and install pick projection ─────────────────────────
    const view = states.uViewMatrix.mat4;
    for (let i = 0; i < 16; i++) view[i] = _pickViewSave[i];

    const proj = states.uPMatrix.mat4;
    for (let i = 0; i < 16; i++) proj[i] = _pickProjSave[i];

    // Viewport: [0, canvasH, canvasW, −canvasH] — negative h = p5/DOM y-down.
    _pickVp[0]=0; _pickVp[1]=p.height; _pickVp[2]=p.width; _pickVp[3]=-p.height;
    mat4Pick(proj, px, py, _pickVp);

    // ── 5. Pick render state ────────────────────────────────────────────────
    p.background(0);
    p.noLights();
    p.noStroke();
    p.resetShader();

    // ── 6. Draw, read, restore ──────────────────────────────────────────────
    let hit = 0;
    try {
      drawFn();
      renderer.drawingContext.readPixels(
        0, 0, 1, 1,
        renderer.drawingContext.RGBA,
        renderer.drawingContext.UNSIGNED_BYTE,
        _pickBuf,
      );
      hit = _pickBuf[0] | (_pickBuf[1] << 8) | (_pickBuf[2] << 16);
    } finally {
      fbo.end();
    }

    return hit;
  };

  // ── mousePick ─────────────────────────────────────────────────────────────

  /**
   * Shorthand for `colorPick(mouseX, mouseY, drawFn)`.
   *
   * @method mousePick
   * @for p5
   * @param {function} drawFn  Scene draw callback.
   * @returns {number}         Decoded id (0 = background / miss).
   */
  fn.mousePick = function (drawFn) {
    return this.colorPick(this.mouseX, this.mouseY, drawFn);
  };

  // ── pointerHit ────────────────────────────────────────────────────────────

  fn.pointerHit = function (...args) { return this._renderer.pointerHit(...args); };

  /**
   * Test whether a pointer position falls within a radius of the current
   * model's screen-space origin. CPU — zero GPU round-trip.
   * Call inside `push()`/`pop()` for each pickable object.
   *
   * @method pointerHit
   * @for p5
   * @param {number}  [pointerX]
   * @param {number}  [pointerY]
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

    let { mat4Model, x, y, size=50, shape=p5.Tree.CIRCLE,
          mat4Eye, mat4Proj, mat4View, mat4PV } = config;
    const mm = _rawMat4(mat4Model) ?? _modelMat4(this);

    if (x == null || y == null) {
      this.mapLocation(_sl, p5.Tree.ORIGIN, { from: mm, to: p5.Tree.SCREEN, mat4Proj, mat4View, mat4PV });
      x = _sl[0]; y = _sl[1];
      this.mapLocation(_wl, p5.Tree.ORIGIN, { from: mm, to: p5.Tree.WORLD, mat4Eye });
      size = size / this.pixelRatio(_wl);
    }
    const r=size/2, dx=x-pointerX, dy=y-pointerY;
    return shape===p5.Tree.CIRCLE
      ? Math.sqrt(dx*dx+dy*dy) < r
      : (Math.abs(dx) < r && Math.abs(dy) < r);
  };

  // ── mouseHit ──────────────────────────────────────────────────────────────

  /**
   * Shorthand for `pointerHit(mouseX, mouseY, opts)`.
   *
   * @method mouseHit
   * @for p5
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
   */
  fn.mouseHit = function (opts) {
    return this._renderer.pointerHit(this.mouseX, this.mouseY, opts);
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FBO lifecycle
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Release the cached pick FBO. Called from lifecycles.remove.
 * @param {p5} pInst
 */
export function releasePickFbo(pInst) {
  const fbo = pInst._tree?._pickFbo;
  if (fbo) { fbo.remove(); delete pInst._tree._pickFbo; }
}
