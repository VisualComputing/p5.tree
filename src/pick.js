/**
 * @file Color-ID picking — 1×1 frustum render into a cached p5.Framebuffer.
 * @module p5.tree/pick
 * @license GPL-3.0-only
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
 */

'use strict';

// ── Module-level zero-alloc buffers ──────────────────────────────────────────

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

// ── Pick-matrix helper ────────────────────────────────────────────────────────

/**
 * Apply the pick-matrix in-place:  proj ← M_pick · proj
 *
 * Zooms the frustum so pixel (px, py) maps to the full NDC square.
 * Convention-independent — works for both perspective and ortho.
 *
 * M_pick (column-major):
 *   [ sx   0   0   tx ]
 *   [  0  sy   0   ty ]
 *   [  0   0   1    0 ]
 *   [  0   0   0    1 ]
 *
 * where:
 *   sx = W,  sy = H
 *   cx = pixel-centre NDC X =  2*(px+0.5)/W − 1
 *   cy = pixel-centre NDC Y =  1 − 2*(py+0.5)/H   (Y flip: screen-down → NDC-up)
 *   tx = −cx·W = W − 2*(px+0.5)
 *   ty = −cy·H = 2*(py+0.5) − H
 *
 * @param {Float32Array} proj  uPMatrix.mat4 inside FBO context — mutated in place.
 * @param {number} px  Query X (CSS pixels).
 * @param {number} py  Query Y (CSS pixels).
 * @param {number} W   Canvas width  (CSS pixels).
 * @param {number} H   Canvas height (CSS pixels).
 */
function _applyPickMatrix(proj, px, py, W, H) {
  const cx =  2 * (px + 0.5) / W - 1;
  const cy = -2 * (py + 0.5) / H + 1;
  const sx = W;
  const sy = H;
  const tx = -cx * W;
  const ty = -cy * H;

  // P_pick = M_pick * P_orig  (rows 2 and 3 are unchanged)
  for (let j = 0; j < 4; j++) {
    const a = proj[j * 4];
    const b = proj[j * 4 + 1];
    const d = proj[j * 4 + 3];
    proj[j * 4]     = sx * a + tx * d;
    proj[j * 4 + 1] = sy * b + ty * d;
  }
}

// ── Install ───────────────────────────────────────────────────────────────────

/**
 * Install colorPick() and tag() on fn.
 * @param {p5}    p5
 * @param {Object} fn  p5 prototype.
 */
export function installPick(p5, fn) {

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

  /**
   * Render `drawFn` into a cached 1×1 framebuffer using a pick-matrix
   * projection aligned to pixel (px, py), then read back and decode the
   * integer id under that pixel.
   *
   * Before `drawFn` is called the library unconditionally calls:
   * `noLights()`, `noStroke()`, `resetShader()`.
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

    // ── 1. Save main-canvas projection and view BEFORE fbo.begin() ─────────
    //       fbo.begin() calls renderer.push() then overwrites both uPMatrix
    //       and uViewMatrix with the FBO's own default-camera matrices.
    //       The view save is critical — without it, any camera move (e.g.
    //       orbitControl) is invisible to the pick pass.
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
    //       fbo.begin() saves the full renderer state via renderer.push(),
    //       then resets both uPMatrix and uViewMatrix to FBO defaults.
    //       fbo.end() calls renderer.pop(), restoring everything automatically.
    fbo.begin();

    // ── 4. Restore view and install pick projection ─────────────────────────
    const view = states.uViewMatrix.mat4;
    for (let i = 0; i < 16; i++) view[i] = _pickViewSave[i];

    const proj = states.uPMatrix.mat4;
    for (let i = 0; i < 16; i++) proj[i] = _pickProjSave[i];
    _applyPickMatrix(proj, px, py, p.width, p.height);

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
}

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
