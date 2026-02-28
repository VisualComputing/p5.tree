/**
 * @file Drawing helpers, picking, view frustum display, and visibility queries.
 * @module drawing
 * @license GPL-3.0-only
 *
 * Depends on matrix.js (uses mapLocation, pixelRatio, beginHUD/endHUD,
 * isOrtho, plane queries, p5.Tree constants).
 *
 * Sections:
 *
 *   Drawing helpers (axes / grid)
 *   - fn.axes / Renderer3D.prototype.axes
 *   - fn.grid / Renderer3D.prototype.grid
 *
 *   Picking
 *   - fn.mousePicking  / Renderer3D.prototype.mousePicking
 *   - fn.pointerPicking / Renderer3D.prototype.pointerPicking
 *
 *   Drawing helpers (bullsEye / cross)
 *   - Renderer3D.prototype._circle  (private geometry primitive)
 *   - fn.cross     / Renderer3D.prototype.cross
 *   - fn.bullsEye  / Renderer3D.prototype.bullsEye
 *
 *   View frustum
 *   - fn.viewFrustum / Renderer3D.prototype.viewFrustum
 *
 *   Visibility (frustum culling)
 *   - fn.visibility      / Renderer3D.prototype.visibility
 *   - fn.bounds          / Renderer3D.prototype.bounds
 *   - fn.distanceToBound / Renderer3D.prototype.distanceToBound
 *   - Renderer3D.prototype._parseVisibilityArgs  (private)
 *   - Renderer3D.prototype._pointVisibility       (private)
 *   - Renderer3D.prototype._ballVisibility        (private)
 *   - Renderer3D.prototype._boxVisibility         (private)
 */

'use strict';

/**
 * Install drawing helpers, picking, viewFrustum, and visibility.
 * @param {p5} p5  The p5 constructor.
 * @param {Object} fn  p5 prototype.
 */
export function installDrawing(p5, fn) {
  // -------------------------------------------------------------------------
  // Drawing helpers (axes / grid)
  // -------------------------------------------------------------------------
  
  fn.axes = function (opts) {
    this._renderer.axes(opts);
    return this;
  };
  
  /**
   * Draws 3D reference axes (X, Y, Z) centered at the origin in model space,
   * using the current stroke settings.
   *
   * Each axis can be enabled independently using bitwise flags, and optional
   * axis labels (X, Y, Z) can be rendered near the positive ends.
   *
   * @method axes
   * @for p5.Renderer3D
   * @param {Object} [opts] Axes options.
   * @param {Number} [opts.size=100] Length of each axis in world units.
   * @param {Array<String>} [opts.colors=['Red','Lime','DodgerBlue']]
   *        Stroke colors for X, Y, and Z axes respectively.
   * @param {Number} [opts.bits=p5.Tree.LABELS | p5.Tree.X | p5.Tree.Y | p5.Tree.Z]
   *        Bitmask controlling which axes and labels are drawn.
   *
   * @example
   * function draw() {
   *   background(30);
   *   orbitControl();
   *   axes({ size: 300 });
   * }
   *
   * @example
   * // Draw only X and Z axes, no labels
   * axes({
   *   size: 200,
   *   bits: p5.Tree.X | p5.Tree.Z
   * });
   *
   * @example
   * // Draw full axes in both positive and negative directions
   * axes({
   *   size: 150,
   *   bits: p5.Tree.X | p5.Tree._X |
   *         p5.Tree.Y | p5.Tree._Y |
   *         p5.Tree.Z | p5.Tree._Z |
   *         p5.Tree.LABELS
   * });
   */
  p5.Renderer3D.prototype.axes = function ({
    size = 100,
    colors = ['Red', 'Lime', 'DodgerBlue'],
    bits = p5.Tree.LABELS | p5.Tree.X | p5.Tree.Y | p5.Tree.Z
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    p.push();
    if ((bits & p5.Tree.LABELS) !== 0) {
      const charWidth = size / 40.0;
      const charHeight = size / 30.0;
      const charShift = 1.04 * size;
      // The X
      p.stroke(colors[0 % colors.length]);
      p.line(charShift, charWidth, -charHeight, charShift, -charWidth, charHeight);
      p.line(charShift, -charWidth, -charHeight, charShift, charWidth, charHeight);
      // The Y
      p.stroke(colors[1 % colors.length]);
      p.line(charWidth, charShift, charHeight, 0.0, charShift, 0.0);
      p.line(0.0, charShift, 0.0, -charWidth, charShift, charHeight);
      p.line(-charWidth, charShift, charHeight, 0.0, charShift, 0.0);
      p.line(0.0, charShift, 0.0, 0.0, charShift, -charHeight);
      // The Z
      p.stroke(colors[2 % colors.length]);
      p.line(-charWidth, -charHeight, charShift, charWidth, -charHeight, charShift);
      p.line(charWidth, -charHeight, charShift, -charWidth, charHeight, charShift);
      p.line(-charWidth, charHeight, charShift, charWidth, charHeight, charShift);
    }
    // X Axis
    p.stroke(colors[0 % colors.length]);
    (bits & p5.Tree.X) !== 0 && p.line(0, 0, 0, size, 0, 0);
    (bits & p5.Tree._X) !== 0 && p.line(0, 0, 0, -size, 0, 0);
    // Y Axis
    p.stroke(colors[1 % colors.length]);
    (bits & p5.Tree.Y) !== 0 && p.line(0, 0, 0, 0, size, 0);
    (bits & p5.Tree._Y) !== 0 && p.line(0, 0, 0, 0, -size, 0);
    // Z Axis
    p.stroke(colors[2 % colors.length]);
    (bits & p5.Tree.Z) !== 0 && p.line(0, 0, 0, 0, 0, size);
    (bits & p5.Tree._Z) !== 0 && p.line(0, 0, 0, 0, 0, -size);
  
    p.pop();
  };
  
  fn.grid = function (opts) {
    this._renderer.grid(opts);
    return this;
  };
  
  /**
   * Draws a simple X/Y reference grid on the Z=0 plane in the current model space.
   *
   * The grid is centered at the origin and spans from `-size` to `+size` on both X and Y.
   * It draws `subdivisions + 1` lines in each direction (including the borders).
   *
   * @method grid
   * @for p5.Renderer3D
   * @param {Object} [opts] Grid options.
   * @param {Number} [opts.size=100] Half-extent of the grid in world units.
   * @param {Number} [opts.subdivisions=10] Number of subdivisions per side (must be >= 1).
   * @example
   * function draw() {
   *   background(30);
   *   orbitControl();
   *   grid({ size: 300, subdivisions: 20 });
   * }
   */
  p5.Renderer3D.prototype.grid = function ({
    size = 100,
    subdivisions = 10
  } = {}) {
    const p = this._pInst;
    if (!p) return;  
    subdivisions = Math.max(1, subdivisions);
    p.push();
    for (let i = 0; i <= subdivisions; ++i) {
      const pos = size * (2.0 * i / subdivisions - 1.0);
      p.line(pos, -size, 0, pos, +size, 0);
      p.line(-size, pos, 0, +size, pos, 0);
    }
    p.pop();
  };
  
  // ---------------------------------------------------------------------------
  // Picking
  // ---------------------------------------------------------------------------
  
  /**
   * Returns `true` if the mouse is close enough to a target screen position.
   *
   * If `x`/`y` are not provided, they are derived by projecting `mMatrix` to
   * `p5.Tree.SCREEN`. In that case, `size` is interpreted in *world units* and
   * converted to pixels using `pixelRatio()` at the corresponding world point.
   *
   * Requires 3D renderer.
   *
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.mMatrix] Model-space matrix origin to compute (x, y) from.
   * @param {number} [opts.x] Screen x coordinate in HUD space (pixels).
   * @param {number} [opts.y] Screen y coordinate in HUD space (pixels).
   * @param {number} [opts.size=50] Picking diameter (pixels in HUD space, or world units when deriving x/y).
   * @param {number} [opts.shape=p5.Tree.CIRCLE] Either `p5.Tree.CIRCLE` or `p5.Tree.SQUARE`.
   * @param {p5.Matrix} [opts.eMatrix] Eye matrix override.
   * @param {p5.Matrix} [opts.pMatrix] Projection matrix override.
   * @param {p5.Matrix} [opts.vMatrix] View (camera) matrix override.
   * @param {p5.Matrix} [opts.pvMatrix] Projection-view matrix override.
   * @returns {boolean|undefined}
   */
  fn.mousePicking = function (opts) {
    return this._renderer.mousePicking(opts);
  };
  
  /**
   * Returns `true` if a pointer is close enough to a target screen position.
   *
   * If `x`/`y` are not provided, they are derived by projecting `mMatrix` to
   * `p5.Tree.SCREEN`. In that case, `size` is interpreted in *world units* and
   * converted to pixels using `pixelRatio()` at the corresponding world point.
   *
   * Requires 3D renderer.
   *
   * @param {...any} args
   * @returns {boolean|undefined}
   */
  fn.pointerPicking = function (...args) {
    return this._renderer.pointerPicking(...args);
  };
  
  p5.Renderer3D.prototype.mousePicking = function ({
    mMatrix = this.mMatrix(),
    x,
    y,
    size = 50,
    shape = p5.Tree.CIRCLE,
    eMatrix,
    pMatrix,
    vMatrix,
    pvMatrix
  } = {}) {
    const p = this._pInst;
    if (!p) return false;
    return this.pointerPicking(p.mouseX, p.mouseY, { mMatrix, x, y, size, shape, eMatrix, pMatrix, vMatrix, pvMatrix });
  };
  
  /**
   * Returns `true` if pointer is close enough to a target screen position.
   *
   * Supported call patterns:
   * - `pointerPicking(pointerX, pointerY, opts)`
   * - `pointerPicking(opts)` (pointer defaults to current mouse if available)
   *
   * @param {...any} args
   * @returns {boolean}
   */
  p5.Renderer3D.prototype.pointerPicking = function (...args) {
    let pointerX;
    let pointerY;
    const config = {};
    for (const arg of args) {
      if (typeof arg === 'number' && Number.isFinite(arg)) {
        pointerX == null ? pointerX = arg : pointerY = arg;
      } else if (arg && typeof arg === 'object') {
        Object.assign(config, arg);
      }
    }
    const p = this._pInst;
    if (pointerX == null) pointerX = p ? p.mouseX : this.width / 2;
    if (pointerY == null) pointerY = p ? p.mouseY : this.height / 2;
    let {
      mMatrix = this.mMatrix(),
      x,
      y,
      size = 50,
      shape = p5.Tree.CIRCLE,
      eMatrix,
      pMatrix,
      vMatrix,
      pvMatrix
    } = config;
    // If target screen position not provided, derive it from mMatrix.
    // In that case, treat `size` as world units and convert to pixels locally.
    if (x == null || y == null) {
      const screen = this.mapLocation({ from: mMatrix, to: p5.Tree.SCREEN, pMatrix, vMatrix, pvMatrix });
      x = screen.x;
      y = screen.y;
      const world = this.mapLocation({ from: mMatrix, to: p5.Tree.WORLD, eMatrix });
      size = size / this.pixelRatio(world);
    }
    const r = size / 2.0;
    const dx = x - pointerX;
    const dy = y - pointerY;
    return shape === p5.Tree.CIRCLE
      ? Math.sqrt(dx * dx + dy * dy) < r
      : (Math.abs(dx) < r && Math.abs(dy) < r);
  };
  
  // -------------------------------------------------------------------------
  // Drawing helpers (bullsEye / cross)
  // -------------------------------------------------------------------------
  
  /**
   * @private
   * Draws a circle primitive in the *current* renderer space.
   *
   * This is a geometry primitive (lines / triangles in the XY plane at z=0),
   * so it can be used in 3D *or* in HUD/screen space depending on the caller:
   * - Call inside `beginHUD()/endHUD()` to interpret `x,y,radius` in screen pixels.
   * - Call outside HUD to interpret them in the current 3D space units.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.filled=false] Whether to fill the circle.
   * @param {number} [opts.x=width/2] Center x in current space.
   * @param {number} [opts.y=height/2] Center y in current space.
   * @param {number} [opts.radius=100] Radius in current space.
   * @param {number} [opts.detail=50] Segment count.
   */
  p5.Renderer3D.prototype._circle = function ({
    filled = false,
    x = this.width / 2,
    y = this.height / 2,
    radius = 100,
    detail = 50
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    p.push();
    p.translate(x, y);
    if (filled) {
      p.beginShape(p.TRIANGLE_STRIP);
      for (let t = 0; t <= detail; t++) {
        const cx = Math.cos(t * (2 * Math.PI) / detail);
        const cy = Math.sin(t * (2 * Math.PI) / detail);
        p.vertex(0, 0, 0, 0.5, 0.5);
        p.vertex(radius * cx, radius * cy, 0, (cx * 0.5) + 0.5, (cy * 0.5) + 0.5);
      }
      p.endShape();
    } else {
      const angle = (2 * Math.PI) / detail;
      let last = { x: radius, y: 0 };
      for (let i = 1; i <= detail; i++) {
        const pos = { x: Math.cos(i * angle) * radius, y: Math.sin(i * angle) * radius };
        p.line(last.x, last.y, pos.x, pos.y);
        last = pos;
      }
    }
    p.pop();
  };
  
  /**
   * Draws a cross in HUD space (`x,y` in screen coordinates).
   *
   * If `x` and `y` are not provided, the cross is placed at the screen position
   * corresponding to the origin of `mMatrix`.
   *
   * If `mMatrix` is used (x/y omitted), `size` is interpreted in world units
   * and converted to pixels using `pixelRatio()` at the corresponding world point.
   *
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.mMatrix] Model-space matrix origin to compute (x, y) from.
   * @param {number} [opts.x] Screen x coordinate in HUD space (pixels).
   * @param {number} [opts.y] Screen y coordinate in HUD space (pixels).
   * @param {number} [opts.size=50] Cross size (pixels in HUD space, or world units when deriving x/y).
   * @param {p5.Matrix} [opts.eMatrix] Eye matrix override.
   * @param {p5.Matrix} [opts.pMatrix] Projection matrix override.
   * @param {p5.Matrix} [opts.vMatrix] View (camera) matrix override.
   * @param {p5.Matrix} [opts.pvMatrix] Projection-view matrix override.
   */
  fn.cross = function (opts) {
    this._renderer.cross(opts);
    return this;
  };
  
  p5.Renderer3D.prototype.cross = function ({
    mMatrix = this.mMatrix(),
    x,
    y,
    size = 50,
    eMatrix,
    pMatrix,
    vMatrix,
    pvMatrix
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    
    if (x == null || y == null) {
      const screen = this.mapLocation({ from: mMatrix, to: p5.Tree.SCREEN, pMatrix, vMatrix, pvMatrix });
      x = screen.x;
      y = screen.y;
      const world = this.mapLocation({ from: mMatrix, to: p5.Tree.WORLD, eMatrix });
      size = size / this.pixelRatio(world);
    }
    const half = size / 2.0;
    this.beginHUD();
    p.line(x - half, y, x + half, y);
    p.line(x, y - half, x, y + half);
    this.endHUD();
  };
  
  /**
   * Draws a bulls-eye on the screen (HUD space): either a circle or square-corners,
   * plus a center cross.
   *
   * If `x` and `y` are not provided, the bulls-eye is placed at the screen position
   * corresponding to the origin of `mMatrix`.
   *
   * If `mMatrix` is used (x/y omitted), `size` is interpreted in world units
   * and converted to pixels using `pixelRatio()` at the corresponding world point.
   *
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.mMatrix] Model-space matrix origin to compute (x, y) from.
   * @param {number} [opts.x] Screen x coordinate in HUD space (pixels).
   * @param {number} [opts.y] Screen y coordinate in HUD space (pixels).
   * @param {number} [opts.size=50] Bulls-eye diameter (pixels in HUD space, or world units when deriving x/y).
   * @param {number} [opts.shape=p5.Tree.CIRCLE] Either `p5.Tree.CIRCLE` or `p5.Tree.SQUARE`.
   * @param {p5.Matrix} [opts.eMatrix] Eye matrix override.
   * @param {p5.Matrix} [opts.pMatrix] Projection matrix override.
   * @param {p5.Matrix} [opts.vMatrix] View (camera) matrix override.
   * @param {p5.Matrix} [opts.pvMatrix] Projection-view matrix override.
   */
  fn.bullsEye = function (opts) {
    this._renderer.bullsEye(opts);
    return this;
  };
  
  p5.Renderer3D.prototype.bullsEye = function ({
    mMatrix = this.mMatrix(),
    x,
    y,
    size = 50,
    shape = p5.Tree.CIRCLE,
    eMatrix,
    pMatrix,
    vMatrix,
    pvMatrix
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    if (x == null || y == null) {
      const screen = this.mapLocation({ from: mMatrix, to: p5.Tree.SCREEN, pMatrix, vMatrix, pvMatrix });
      x = screen.x;
      y = screen.y;
      const world = this.mapLocation({ from: mMatrix, to: p5.Tree.WORLD, eMatrix });
      size = size / this.pixelRatio(world);
    }
    const half = size / 2.0;
    const corner = 0.6 * half;
    this.beginHUD();
    if (shape === p5.Tree.CIRCLE) {
      this._circle({ x, y, radius: half });
    } else {
      p.line(x - half, y - half + corner, x - half, y - half);
      p.line(x - half, y - half, x - half + corner, y - half);
      p.line(x + half - corner, y - half, x + half, y - half);
      p.line(x + half, y - half, x + half, y - half + corner);
      p.line(x + half, y + half - corner, x + half, y + half);
      p.line(x + half, y + half, x + half - corner, y + half);
      p.line(x - half + corner, y + half, x - half, y + half);
      p.line(x - half, y + half, x - half, y + half - corner);
    }
    // Center cross (0.6 * size), in HUD space.
    const crossHalf = 0.6 * half;
    p.line(x - crossHalf, y, x + crossHalf, y);
    p.line(x, y - crossHalf, x, y + crossHalf);
    this.endHUD();
  };
  
  // ---------------------------------------------------------------------------
  // View frustum (pg frustum display)
  // ---------------------------------------------------------------------------
  
  fn.viewFrustum = function (opts) {
    this._renderer.viewFrustum(opts);
    return this;
  };
  
  /**
   * Displays a view frustum, either from a pg (p5.Graphics / p5.Renderer3D) or from eMatrix/pMatrix.
   *
   * @param {Object} [opts]
   * @param {p5.Matrix} [opts.vMatrix=this.vMatrix()] desired view matrix (world -> this eye) for drawing the frustum.
   * @param {p5.Renderer3D|p5.Graphics} [opts.pg] renderer/pg whose frustum is to be displayed.
   * @param {p5.Matrix} [opts.eMatrix=pg?.eMatrix()] eye matrix defining frustum pose (eye -> world).
   * @param {p5.Matrix} [opts.pMatrix=pg?.pMatrix()] projection matrix defining frustum projection.
   * @param {number} [opts.bits=p5.Tree.NEAR|p5.Tree.FAR] bitmask (NEAR/FAR/BODY/APEX).
   * @param {Function|false|null} [opts.viewer=...] callback drawn at the frustum origin (in frustum space).
   */
  p5.Renderer3D.prototype.viewFrustum = function ({
    vMatrix = this.vMatrix(),
    pg,
    eMatrix = pg?.eMatrix(),
    pMatrix = pg?.pMatrix(),
    bits = p5.Tree.NEAR | p5.Tree.FAR,
    viewer = () => this.axes({ size: 50, bits: p5.Tree.X | p5.Tree._X | p5.Tree.Y | p5.Tree._Y | p5.Tree.Z | p5.Tree._Z })
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    if (this === pg) {
      console.error('displaying viewFrustum requires a pg different than this');
      return;
    }
    if (!pMatrix || !eMatrix) {
      console.error('displaying viewFrustum requires either a pg or projection and eye matrices');
      return;
    }
    const states = this.states;
    const uView = states?.uViewMatrix;
    if (!uView) return;
    p.push();
    p.resetMatrix();
    // Override view matrix in-place (fast path: no inversion).
    // Save previous values so we can restore them after drawing.
    const prevView = uView.copy();
    uView.set(vMatrix);
    // Apply frustum camera pose (eye -> world) as a model transform.
    this.applyMatrix(...eMatrix.mat4);
    // Optional viewer at frustum origin
    typeof viewer === 'function' && viewer();
    const isOrtho = pMatrix.isOrtho();
    const apex = !isOrtho && ((bits & p5.Tree.APEX) !== 0);
    const n = -pMatrix.nPlane();
    const f = -pMatrix.fPlane();
    const l = pMatrix.lPlane();
    const r = pMatrix.rPlane();
    // hack preserved (sign handling for t/b differs in ortho vs persp)
    const t = isOrtho ? -pMatrix.tPlane() : pMatrix.tPlane();
    const b = isOrtho ? -pMatrix.bPlane() : pMatrix.bPlane();
    // far plane corners
    const ratio = isOrtho ? 1 : f / n;
    const _l = ratio * l;
    const _r = ratio * r;
    const _b = ratio * b;
    const _t = ratio * t;
    // FAR plane
    if ((bits & p5.Tree.FAR) !== 0) {
      this.beginShape();
      this.vertex(_l, _t, f);
      this.vertex(_r, _t, f);
      this.vertex(_r, _b, f);
      this.vertex(_l, _b, f);
      this.endShape(p.CLOSE);
    } else {
      this.line(_l, _t, f, _r, _t, f);
      this.line(_r, _t, f, _r, _b, f);
      this.line(_r, _b, f, _l, _b, f);
      this.line(_l, _b, f, _l, _t, f);
    }
    // BODY
    if ((bits & p5.Tree.BODY) !== 0) {
      this.beginShape();
      this.vertex(_l, _t, f);
      this.vertex(l, t, n);
      this.vertex(r, t, n);
      this.vertex(_r, _t, f);
      this.endShape();
      this.beginShape();
      this.vertex(_r, _t, f);
      this.vertex(r, t, n);
      this.vertex(r, b, n);
      this.vertex(_r, _b, f);
      this.endShape();
      this.beginShape();
      this.vertex(_r, _b, f);
      this.vertex(r, b, n);
      this.vertex(l, b, n);
      this.vertex(_l, _b, f);
      this.endShape();
      this.beginShape();
      this.vertex(l, t, n);
      this.vertex(_l, _t, f);
      this.vertex(_l, _b, f);
      this.vertex(l, b, n);
      this.endShape();
      if (apex) {
        this.line(0, 0, 0, r, t, n);
        this.line(0, 0, 0, l, t, n);
        this.line(0, 0, 0, l, b, n);
        this.line(0, 0, 0, r, b, n);
      }
    } else {
      this.line(apex ? 0 : r, apex ? 0 : t, apex ? 0 : n, _r, _t, f);
      this.line(apex ? 0 : l, apex ? 0 : t, apex ? 0 : n, _l, _t, f);
      this.line(apex ? 0 : l, apex ? 0 : b, apex ? 0 : n, _l, _b, f);
      this.line(apex ? 0 : r, apex ? 0 : b, apex ? 0 : n, _r, _b, f);
    }
    // NEAR plane
    if ((bits & p5.Tree.NEAR) !== 0) {
      this.beginShape();
      this.vertex(l, t, n);
      this.vertex(r, t, n);
      this.vertex(r, b, n);
      this.vertex(l, b, n);
      this.endShape(p.CLOSE);
    } else {
      this.line(l, t, n, r, t, n);
      this.line(r, t, n, r, b, n);
      this.line(r, b, n, l, b, n);
      this.line(l, b, n, l, t, n);
    }
    // Restore previous view matrix (no try/finally as requested).
    uView.set(prevView);
    p.pop();
  };
  
  // ---------------------------------------------------------------------------
  // Visibility (frustum culling queries)
  // ---------------------------------------------------------------------------
  
  /**
   * Returns object visibility with respect to the current view frustum.
   * Object may be either:
   * - a point (center),
   * - a sphere (center + radius),
   * - or an axis-aligned box (corner1 + corner2).
   *
   * @returns {number} One of p5.Tree.VISIBLE, p5.Tree.INVISIBLE, p5.Tree.SEMIVISIBLE.
   */
  fn.visibility = function (...args) {
    return this._renderer.visibility(...args);
  };
  
  /**
   * Returns the 6 plane equations of the view frustum in world space.
   * @returns {Object}
   */
  fn.bounds = function (opts = {}) {
    return this._renderer.bounds(opts);
  };
  
  /**
   * Returns signed distance from a point to a frustum plane.
   * @returns {number}
   */
  fn.distanceToBound = function (...args) {
    return this._renderer.distanceToBound(...args);
  };
  
  /**
   * Parses visibility query arguments.
   * Supports:
   * - visibility({ corner1, corner2, center, radius, bounds })
   * - visibility(center[, radius][, bounds])
   * - visibility(corner1, corner2[, bounds])
   *
   * @private
   */
  p5.Renderer3D.prototype._parseVisibilityArgs = function (...args) {
    let corner1;
    let corner2;
    let center;
    let radius;
    let pendingRadius;
    let bounds;
    const vecs = [];
    const isPlainObject = v => {
      if (!v || typeof v !== 'object') return false;
      if (Array.isArray(v)) return false;
      if (ArrayBuffer.isView(v)) return false;
      return Object.getPrototypeOf(v) === Object.prototype;
    };
    for (const arg of args) {
      if (arg instanceof p5.Vector || Array.isArray(arg)) {
        vecs.push(arg);
        continue;
      }
      if (typeof arg === 'number' && Number.isFinite(arg) && radius === undefined) {
        // Only accept a radius if we already have (or will infer) a center.
        center ? (radius = arg) : (pendingRadius = arg);
        continue;
      }
      if (isPlainObject(arg)) {
        if ('corner1' in arg || 'corner2' in arg || 'center' in arg || 'radius' in arg || 'bounds' in arg) {
          corner1 = arg.corner1 ?? corner1;
          corner2 = arg.corner2 ?? corner2;
          center = arg.center ?? center;
          radius = arg.radius ?? radius;
          bounds = arg.bounds ?? bounds;
        } else {
          bounds = arg;
        }
      }
    }
    // Ordering rule: if 2 vectors are provided, first is corner1, second is corner2.
    if (!corner1 && !corner2) {
      if (!center && vecs.length === 1) {
        center = vecs[0];
      } else if (!corner1 && !corner2 && vecs.length >= 2) {
        corner1 = vecs[0];
        corner2 = vecs[1];
      }
    }
    // Commit leading radius only if we ended up with a center (supports visibility(radius, center[, bounds])).
    if (radius === undefined && pendingRadius !== undefined && center) {
      radius = pendingRadius;
    }
    return { corner1, corner2, center, radius, bounds };
  };
  
  /**
   * Returns object visibility with respect to the current view frustum.
   *
   * Supported forms:
   * - visibility(center[, radius][, bounds])
   * - visibility(radius, center[, bounds])
   * - visibility(corner1, corner2[, bounds])
   * - visibility({ corner1, corner2, center, radius, bounds })
   *
   * @param {Object} [opts]
   * @param {p5.Vector|number[]} [opts.corner1] First box corner (use with corner2).
   * @param {p5.Vector|number[]} [opts.corner2] Second box corner (use with corner1).
   * @param {p5.Vector|number[]} [opts.center] Sphere (or point) center.
   * @param {number} [opts.radius] Sphere radius (if omitted, center is treated as point).
   * @param {Object} [opts.bounds] Frustum plane equations (defaults to this.bounds()).
   * @returns {number} One of p5.Tree.VISIBLE, p5.Tree.INVISIBLE, p5.Tree.SEMIVISIBLE.
   */
  p5.Renderer3D.prototype.visibility = function (...args) {
    const { corner1, corner2, center, radius, bounds } = this._parseVisibilityArgs(...args);
    const b = bounds ?? this.bounds();
    return center ? (radius ? this._ballVisibility(center, radius, b) : this._pointVisibility(center, b))
      : (corner1 && corner2 ? this._boxVisibility(corner1, corner2, b)
        : (console.error('[p5.tree] visibility: could not parse query.'), p5.Tree.INVISIBLE));
  };
  
  p5.Renderer3D.prototype._pointVisibility = function (point, bounds = this.bounds()) {
    for (const key in bounds) {
      const d = this.distanceToBound(point, key, bounds);
      if (d > 0) return p5.Tree.INVISIBLE;
      if (d === 0) return p5.Tree.SEMIVISIBLE;
    }
    return p5.Tree.VISIBLE;
  };
  
  p5.Renderer3D.prototype._ballVisibility = function (center, radius, bounds = this.bounds()) {
    let allInForAllPlanes = true;
    for (const key in bounds) {
      const d = this.distanceToBound(center, key, bounds);
      if (d > radius) return p5.Tree.INVISIBLE;
      if (d > 0 || -d < radius) allInForAllPlanes = false;
    }
    return allInForAllPlanes ? p5.Tree.VISIBLE : p5.Tree.SEMIVISIBLE;
  };
  
  p5.Renderer3D.prototype._boxVisibility = function (corner1, corner2, bounds = this.bounds()) {
    const asVec3 = v =>
      v instanceof p5.Vector ? v : new p5.Vector(v?.[0] ?? 0, v?.[1] ?? 0, v?.[2] ?? 0);
    corner1 = asVec3(corner1);
    corner2 = asVec3(corner2);
    let allInForAllPlanes = true;
    for (const key in bounds) {
      let allOut = true;
      for (let c = 0; c < 8; ++c) {
        const pos = new p5.Vector(
          (c & 4) !== 0 ? corner1.x : corner2.x,
          (c & 2) !== 0 ? corner1.y : corner2.y,
          (c & 1) !== 0 ? corner1.z : corner2.z
        );
        if (this.distanceToBound(pos, key, bounds) > 0) {
          allInForAllPlanes = false;
        } else {
          allOut = false;
        }
      }
      if (allOut) return p5.Tree.INVISIBLE;
    }
    return allInForAllPlanes ? p5.Tree.VISIBLE : p5.Tree.SEMIVISIBLE;
  };
  
  /**
   * Returns the 6 plane equations of the view frustum bounds defined in world space.
   * Each plane equation is of the form:
   *   a*x + b*y + c*z + d = 0
   *
   * @param {Object} [opts]
   * @param {p5.Matrix} [opts.vMatrix] View matrix (world -> eye).
   * @param {p5.Matrix} [opts.eMatrix] Eye matrix (eye -> world).
   * @returns {Object} Object keyed by p5.Tree.LEFT/RIGHT/NEAR/FAR/TOP/BOTTOM.
   */
  p5.Renderer3D.prototype.bounds = function ({
    vMatrix,
    eMatrix
  } = {}) {
    const n = this.nPlane();
    const f = this.fPlane();
    const l = this.lPlane();
    const r = this.rPlane();
    const b = this.bPlane();
    const t = this.tPlane();
    const normals = Array(6);
    const distances = Array(6);
    // Camera position and basis in world space.
    const pos = this._location([0, 0, 0], { from: p5.Tree.EYE, to: p5.Tree.WORLD, eMatrix });
    const viewDir = this._direction([0, 0, -1], { from: p5.Tree.EYE, to: p5.Tree.WORLD, vMatrix });
    const up = this._direction([0, 1, 0], { from: p5.Tree.EYE, to: p5.Tree.WORLD, vMatrix });
    const right = this._direction([1, 0, 0], { from: p5.Tree.EYE, to: p5.Tree.WORLD, vMatrix });
    const posViewDir = p5.Vector.dot(pos, viewDir);
    if (this.isOrtho()) {
      normals[0] = p5.Vector.mult(right, -1);
      normals[1] = right;
      normals[4] = up;
      normals[5] = p5.Vector.mult(up, -1);
      distances[0] = p5.Vector.dot(p5.Vector.sub(pos, p5.Vector.mult(right, -l)), normals[0]);
      distances[1] = p5.Vector.dot(p5.Vector.add(pos, p5.Vector.mult(right, r)), normals[1]);
      distances[4] = p5.Vector.dot(p5.Vector.add(pos, p5.Vector.mult(up, -b)), normals[4]);
      distances[5] = p5.Vector.dot(p5.Vector.sub(pos, p5.Vector.mult(up, t)), normals[5]);
    } else {
      const hfovr = Math.atan2(r, n);
      const shfovr = Math.sin(hfovr);
      const chfovr = Math.cos(hfovr);
      const hfovl = Math.atan2(l, n);
      const shfovl = Math.sin(hfovl);
      const chfovl = Math.cos(hfovl);
      normals[0] = p5.Vector.add(p5.Vector.mult(viewDir, shfovl), p5.Vector.mult(right, -chfovl));
      normals[1] = p5.Vector.add(p5.Vector.mult(viewDir, -shfovr), p5.Vector.mult(right, chfovr));
      const fovt = Math.atan2(t, n);
      const sfovt = Math.sin(fovt);
      const cfovt = Math.cos(fovt);
      const fovb = Math.atan2(b, n);
      const sfovb = Math.sin(fovb);
      const cfovb = Math.cos(fovb);
      normals[4] = p5.Vector.add(p5.Vector.mult(viewDir, -sfovt), p5.Vector.mult(up, cfovt));
      normals[5] = p5.Vector.add(p5.Vector.mult(viewDir, sfovb), p5.Vector.mult(up, -cfovb));
      distances[0] = shfovl * posViewDir - chfovl * p5.Vector.dot(pos, right);
      distances[1] = -shfovr * posViewDir + chfovr * p5.Vector.dot(pos, right);
      distances[4] = -sfovt * posViewDir + cfovt * p5.Vector.dot(pos, up);
      distances[5] = sfovb * posViewDir - cfovb * p5.Vector.dot(pos, up);
    }
    // Near/far planes (common to ortho and perspective).
    normals[2] = p5.Vector.mult(viewDir, -1);
    normals[3] = viewDir;
    distances[2] = -posViewDir - n;
    distances[3] = posViewDir + f;
    const bounds = {};
    bounds[p5.Tree.LEFT] = { a: normals[0].x, b: normals[0].y, c: normals[0].z, d: distances[0] };
    bounds[p5.Tree.RIGHT] = { a: normals[1].x, b: normals[1].y, c: normals[1].z, d: distances[1] };
    bounds[p5.Tree.NEAR] = { a: normals[2].x, b: normals[2].y, c: normals[2].z, d: distances[2] };
    bounds[p5.Tree.FAR] = { a: normals[3].x, b: normals[3].y, c: normals[3].z, d: distances[3] };
    bounds[p5.Tree.TOP] = { a: normals[4].x, b: normals[4].y, c: normals[4].z, d: distances[4] };
    bounds[p5.Tree.BOTTOM] = { a: normals[5].x, b: normals[5].y, c: normals[5].z, d: distances[5] };
    return bounds;
  };
  
  /**
   * Returns signed distance between a point and a frustum plane.
   *
   * @param {p5.Vector|number[]} point
   * @param {number|string} key One of p5.Tree.LEFT/RIGHT/BOTTOM/TOP/NEAR/FAR.
   * @param {Object} [bounds] Plane equations (defaults to this.bounds()).
   * @returns {number}
   */
  p5.Renderer3D.prototype.distanceToBound = function (...args) {
    let point;
    let key;
    let bounds = this.bounds();
    const asVec3 = v =>
      v instanceof p5.Vector ? v : new p5.Vector(v?.[0] ?? 0, v?.[1] ?? 0, v?.[2] ?? 0);
    for (const arg of args) {
      if (arg instanceof p5.Vector || Array.isArray(arg)) {
        point = asVec3(arg);
      } else if (typeof arg === 'string' || typeof arg === 'number') {
        key = arg;
      } else if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
        bounds = arg;
      }
    }
    if (!point || key === undefined) {
      console.error('[p5.tree] distanceToBound: could not parse query.');
      return 0;
    }
    const eq = bounds[key];
    return p5.Vector.dot(point, new p5.Vector(eq.a, eq.b, eq.c)) - eq.d;
  };
}
