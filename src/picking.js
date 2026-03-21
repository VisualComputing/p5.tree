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

import { applyPickMatrix } from '@nakednous/tree';

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
 * Without restoring this, picking fails as soon as the camera is moved.
 */
const _pickViewSave = new Float32Array(16);

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
   *
   * ```js
   * fill(tag(1)); box(60)
   * fill(tag(2)); sphere(40)
   * ```
   *
   * id `0` is reserved — it decodes as background / miss.
   * Hex strings are parsed by p5 independently of `colorMode()`.
   *
   * @method tag
   * @for p5
   * @param {number} id  Integer in [1, 16_777_215].
   * @returns {string}   CSS hex string, e.g. `'#010000'` for id `1`.
   */
  fn.tag = function (id) {
    const r =  id        & 0xff;
    const g = (id >>  8) & 0xff;
    const b = (id >> 16) & 0xff;
    return '#' +
      r.toString(16).padStart(2, '0') +
      g.toString(16).padStart(2, '0') +
      b.toString(16).padStart(2, '0');
  };

  // ── colorPick ─────────────────────────────────────────────────────────────

  /**
   * Render `drawFn` into a cached 1×1 framebuffer using a pick-matrix
   * projection aligned to pixel (px, py), then read back and decode the
   * integer id under that pixel.
   *
   * Before `drawFn` is called the library unconditionally calls:
   * `noLights()`, `noStroke()`, `resetShader()`.
   * Stroke is excluded from the pick buffer by default — call
   * `stroke(tag(id))` inside `drawFn` to include it. When stroke is
   * included, both `fill` and `stroke` must carry the same `tag(id)`.
   *
   * The FBO is lazily allocated on first use and released in `lifecycles.remove`.
   *
   * @example
   * ```js
   * const hit = colorPick(mouseX, mouseY, () => {
   *   push(); fill(tag(1)); box(60);    pop()
   *   push(); fill(tag(2)); sphere(40); pop()
   * })
   * if (hit === 1) console.log('box!')
   * if (hit === 2) console.log('sphere!')
   * ```
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
      depth: true,       // required: depth test selects nearest hit, not draw order
      antialias: false,  // required: blending would corrupt encoded integer colors
    });
    const fbo = p._tree._pickFbo;

    // ── 3. Enter FBO ────────────────────────────────────────────────────────
    //       fbo.begin() saves full renderer state via renderer.push(), then
    //       resets uPMatrix and uViewMatrix to FBO defaults.
    //       fbo.end() calls renderer.pop(), restoring everything automatically.
    fbo.begin();

    // ── 4. Restore view and install pick projection ─────────────────────────
    const view = states.uViewMatrix.mat4;
    for (let i = 0; i < 16; i++) view[i] = _pickViewSave[i];

    const proj = states.uPMatrix.mat4;
    for (let i = 0; i < 16; i++) proj[i] = _pickProjSave[i];
    // ── WORKAROUND: p5 bug — remove block and uncomment restore line ──────
    // p5 v2 sets mouseX/mouseY as (clientX - rect.left) / scrollWidth * width.
    // scrollWidth is unaffected by parent CSS transform: scale(), so mouseX/mouseY
    // land in visual CSS-pixel space rather than logical canvas space when a parent
    // (e.g. Slidev) applies CSS scaling. Both px/py and rect dimensions share the
    // same visual space, so passing rect.width/height keeps the ratio correct.
    // Fix in p5: src/events/pointer.js _updatePointerCoords — replace
    //   canvas.scrollWidth / this.width   with  rect.width  / this.width
    //   canvas.scrollHeight / this.height with  rect.height / this.height
    const _pickRect = renderer.canvas.getBoundingClientRect();
    applyPickMatrix(proj, px, py,
      _pickRect.width  || p.width,
      _pickRect.height || p.height);
    // applyPickMatrix(proj, px, py, p.width, p.height); // ← restore on removal
    // ── END WORKAROUND ────────────────────────────────────────────────────

    // ── 5. Pick render state ────────────────────────────────────────────────
    p.background(0);   // clear to id 0 (background / miss)
    p.noLights();
    p.noStroke();
    p.resetShader();   // clear any bound texture / custom shader

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
      fbo.end();  // renderer.pop() restores uPMatrix + uViewMatrix + full state
    }

    return hit;
  };

  // ── mousePick ─────────────────────────────────────────────────────────────

  /**
   * Shorthand for `colorPick(mouseX, mouseY, drawFn)`.
   *
   * @method mousePick
   * @for p5
   * @param {function} drawFn  Scene draw callback — tag objects with fill(tag(id)).
   * @returns {number}         Decoded id (0 = background / miss).
   */
  fn.mousePick = function (drawFn) {
    return this.colorPick(this.mouseX, this.mouseY, drawFn);
  };

  // ── pointerHit ────────────────────────────────────────────────────────────

  fn.pointerHit = function (...args) { return this._renderer.pointerHit(...args); };

  /**
   * Test whether an arbitrary pointer position falls within a radius of the
   * current model's screen-space origin. CPU — zero GPU round-trip.
   *
   * Call inside `push()`/`pop()` for each pickable object.
   *
   * @method pointerHit
   * @for p5
   * @param {number}  [pointerX]
   * @param {number}  [pointerY]
   * @param {{
   *   mMatrix?:  Float32Array | ArrayLike | p5.Matrix,
   *   x?, y?,
   *   size?:     number,
   *   shape?:    number,
   *   eMatrix?:  Float32Array | ArrayLike | p5.Matrix,
   *   pMatrix?:  Float32Array | ArrayLike | p5.Matrix,
   *   vMatrix?:  Float32Array | ArrayLike | p5.Matrix,
   *   pvMatrix?: Float32Array | ArrayLike | p5.Matrix,
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

    let { mMatrix, x, y, size = 50, shape = p5.Tree.CIRCLE,
          eMatrix, pMatrix, vMatrix, pvMatrix } = config;
    const mm = _rawMat4(mMatrix) ?? _modelMat4(this);

    if (x == null || y == null) {
      this.mapLocation(_sl, p5.Tree.ORIGIN, { from: mm, to: p5.Tree.SCREEN, pMatrix, vMatrix, pvMatrix });
      // ── WORKAROUND: p5 bug — remove block and uncomment restore line ────
      // mapLocation → SCREEN returns logical canvas coordinates.
      // pointerX/pointerY from p5.mouseX/mouseY are in visual CSS-pixel space
      // (same bug as colorPick above). Scale logical → visual so the comparison
      // is in the same space. See colorPick comment for p5 fix location.
      const _hitRect = this.canvas.getBoundingClientRect();
      const _hsx = (_hitRect.width  || this.width)  / this.width;
      const _hsy = (_hitRect.height || this.height) / this.height;
      x = _sl[0] * _hsx; y = _sl[1] * _hsy;
      // x = _sl[0]; y = _sl[1]; // ← restore on removal
      // ── END WORKAROUND ──────────────────────────────────────────────────
      this.mapLocation(_wl, p5.Tree.ORIGIN, { from: mm, to: p5.Tree.WORLD, eMatrix });
      size = size / this.pixelRatio(_wl);
    }
    const r = size / 2.0, dx = x - pointerX, dy = y - pointerY;
    return shape === p5.Tree.CIRCLE
      ? Math.sqrt(dx * dx + dy * dy) < r
      : (Math.abs(dx) < r && Math.abs(dy) < r);
  };

  // ── mouseHit ──────────────────────────────────────────────────────────────

  /**
   * Shorthand for `pointerHit(mouseX, mouseY, opts)`.
   *
   * @method mouseHit
   * @for p5
   * @param {{
   *   mMatrix?:  Float32Array | ArrayLike | p5.Matrix,
   *   x?, y?,
   *   size?:     number,
   *   shape?:    number,
   *   eMatrix?:  Float32Array | ArrayLike | p5.Matrix,
   *   pMatrix?:  Float32Array | ArrayLike | p5.Matrix,
   *   vMatrix?:  Float32Array | ArrayLike | p5.Matrix,
   *   pvMatrix?: Float32Array | ArrayLike | p5.Matrix,
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
  if (fbo) {
    fbo.remove();
    delete pInst._tree._pickFbo;
  }
}
