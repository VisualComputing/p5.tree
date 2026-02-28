/**
 * @file Matrix queries, space transforms, and HUD.
 * @module matrix
 * @license GPL-3.0-only
 *
 * Core math layer: everything that drawing.js, track.js, and user sketches
 * depend on, but nothing that draws geometry or does picking/visibility.
 *
 * Sections (in source order):
 *   - _invert, _transpose (private immutable matrix ops)
 *   - p5.Matrix.prototype.mult4 / _mult4
 *   - fn.tMatrix, fn.iMatrix, fn.axbMatrix, fn.createMatrix
 *   - p5.Camera.prototype.eMatrix (+ Renderer3D + fn)
 *   - pMatrix, vMatrix, mMatrix (Renderer3D + fn)
 *   - lMatrix, dMatrix (Renderer3D + fn)
 *   - mvMatrix, nMatrix, pmvMatrix, pvMatrix, ipvMatrix (Renderer3D + fn)
 *   - p5.Matrix.prototype: isOrtho, nPlane..bPlane, fov, hfov
 *   - Renderer3D plane/fov wrappers + fn wrappers
 *   - fn.pixelRatio, fn.texOffset
 *   - fn.mousePosition, fn.pointerPosition, fn.resolution (+ Renderer3D)
 *   - beginHUD / endHUD (Renderer3D + fn)
 *   - _parseTransformArgs
 *   - mapLocation  / _location  (+ _screenToWorldLocation, _worldToScreenLocation, etc.)
 *   - mapDirection / _direction (+ _worldToScreenDirection, _screenToWorldDirection, etc.)
 *   - pixelRatio, texOffset  (Utilities section)
 *   - mousePosition, pointerPosition, resolution  (Renderer3D + fn)
 */

'use strict';

/**
 * Install matrix queries, space transforms, and HUD.
 * @param {p5} p5  The p5 constructor.
 * @param {Object} fn  p5 prototype.
 */
export function installMatrix(p5, fn) {
  // ---------------------------------------------------------------------------
  // Matrix queries
  // Rely on p5-v2, minimal safeties, cache-friendly.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // p5.Matrix operations (immutable)
  // ---------------------------------------------------------------------------
  
  /**
   * @private
   * Returns the inverse of a matrix (immutable).
   * p5-v2: invert(a) inverts 'a' into 'this' (gl-matrix style).
   * @param {p5.Matrix} matrix
   * @returns {p5.Matrix}
   */
  const _invert = function (matrix) {
    const out = matrix.clone();
    out.invert(matrix);
    return out;
  };

  /**
   * @private
   * Returns the transpose of a matrix (immutable).
   * Fast-path for mat4 / mat3 to match treegl semantics.
   * @param {p5.Matrix} matrix
   * @returns {p5.Matrix}
   */
  const _transpose = function (matrix) {
    const m4 = matrix.mat4;
    if (m4) {
      return new p5.Matrix([
        m4[0], m4[4], m4[8],  m4[12],
        m4[1], m4[5], m4[9],  m4[13],
        m4[2], m4[6], m4[10], m4[14],
        m4[3], m4[7], m4[11], m4[15]
      ]);
    }
    const m3 = matrix.mat3;
    if (m3) {
      return new p5.Matrix([
        m3[0], m3[3], m3[6],
        m3[1], m3[4], m3[7],
        m3[2], m3[5], m3[8]
      ]);
    }
  };
  
  p5.Matrix.prototype.mult4 = function (vector) {
    return new p5.Vector(...this._mult4([vector.x, vector.y, vector.z, 1]));
  };
  
  p5.Matrix.prototype._mult4 = function (vec4) {
    if (this.mat4 === undefined) {
      console.error('_mult4 only works with mat4');
      return;
    }
    return [
      this.mat4[0] * vec4[0] + this.mat4[4] * vec4[1] + this.mat4[8]  * vec4[2] + this.mat4[12] * vec4[3],
      this.mat4[1] * vec4[0] + this.mat4[5] * vec4[1] + this.mat4[9]  * vec4[2] + this.mat4[13] * vec4[3],
      this.mat4[2] * vec4[0] + this.mat4[6] * vec4[1] + this.mat4[10] * vec4[2] + this.mat4[14] * vec4[3],
      this.mat4[3] * vec4[0] + this.mat4[7] * vec4[1] + this.mat4[11] * vec4[2] + this.mat4[15] * vec4[3]
    ];
  };

  /**
   * Returns the transpose of a matrix (immutable).
   * @param {p5.Matrix} matrix
   * @returns {p5.Matrix}
   */
  fn.tMatrix = function (matrix) {
    return _transpose(matrix);
  };

  /**
   * Returns the inverse of a matrix.
   * @param {p5.Matrix} matrix
   * @returns {p5.Matrix}
   */
  fn.iMatrix = function (matrix) {
    return _invert(matrix);
  };

  /**
   * Returns A * B without mutating A (immutable).
   * @param {p5.Matrix} a
   * @param {p5.Matrix} b
   * @returns {p5.Matrix}
   */
  fn.axbMatrix = function (a, b) {
    return a.clone().mult(b);
  };
  
  /**
   * Creates a new p5.Matrix.
   * (Wrapper for `new p5.Matrix(...args)`.)
   *
   * - `createMatrix()` → identity 4×4
   * - `createMatrix(n)` → identity n×n (typically 3 or 4)
   * - `createMatrix(coeffs)` → matrix from coefficients (length 9 or 16)
   *
   * @param {...(number|Array<number>)} [args] Arguments forwarded to the p5.Matrix constructor.
   * @returns {p5.Matrix}
   */
  fn.createMatrix = (...args) => new p5.Matrix(...args);

  // ---------------------------------------------------------------------------
  // Matrix queries (immutable, cache-friendly)
  // ---------------------------------------------------------------------------

  /**
   * Returns the current projection matrix (immutable copy).
   * @returns {p5.Matrix}
   */
  p5.Renderer3D.prototype.pMatrix = function () {
    return this.states.uPMatrix.clone();
  };

  /**
   * Returns the current projection matrix (immutable copy).
   * Requires 3D renderer.
   * @returns {p5.Matrix}
   */
  fn.pMatrix = function () {
    return this._renderer.pMatrix();
  };

  /**
   * Returns the current model matrix (immutable copy).
   * @returns {p5.Matrix}
   */
  p5.Renderer3D.prototype.mMatrix = function () {
    return this.states.uModelMatrix.clone();
  };

  /**
   * Returns the current model matrix (immutable copy).
   * Requires 3D renderer.
   * @returns {p5.Matrix}
   */
  fn.mMatrix = function () {
    return this._renderer.mMatrix();
  };

  /**
   * Returns the view matrix (world -> camera) for this camera (immutable copy).
   * @returns {p5.Matrix}
   */
  p5.Camera.prototype.vMatrix = function () {
    return this.cameraMatrix.clone();
  };

  /**
   * Returns the eye matrix (camera -> world) for this camera (immutable).
   * @returns {p5.Matrix}
   */
  p5.Camera.prototype.eMatrix = function () {
    return _invert(this.cameraMatrix);
  };

  /**
   * Returns the current view matrix (world → camera) as an immutable copy.
   * @returns {p5.Matrix}
   */
  p5.Renderer3D.prototype.vMatrix = function () {
    return this.states.curCamera.vMatrix();
  };

  /**
   * Returns the current view matrix (world -> camera) (immutable copy).
   * Requires 3D renderer.
   * @returns {p5.Matrix}
   */
  fn.vMatrix = function () {
    return this._renderer.vMatrix();
  };

  /**
   * Returns the current eye matrix (camera -> world) (immutable).
   * @returns {p5.Matrix}
   */
  p5.Renderer3D.prototype.eMatrix = function () {
    return this.states.curCamera.eMatrix();
  };

  /**
   * Returns the current eye matrix (camera -> world) (immutable).
   * Requires 3D renderer.
   * @returns {p5.Matrix}
   */
  fn.eMatrix = function () {
    return this._renderer.eMatrix();
  };

  /**
   * lMatrix({ from, to }):
   * Location transform (mat4) mapping points from `from` space to `to` space.
   * treegl semantics: to^-1 * from.
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.from=new p5.Matrix()] Source frame matrix.
   * @param {p5.Matrix} [opts.to=this.eMatrix()] Target frame matrix.
   * @returns {p5.Matrix}
   */
  p5.Renderer3D.prototype.lMatrix = function ({
    from = new p5.Matrix(4),
    to = this.eMatrix()
  } = {}) {
    return _invert(to).mult(from);
  };

  /**
   * lMatrix({ from, to }):
   * Location transform (mat4) mapping points from `from` space to `to` space.
   * Requires 3D renderer.
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.from]
   * @param {p5.Matrix} [opts.to]
   * @returns {p5.Matrix}
   */
  fn.lMatrix = function (opts = {}) {
    return this._renderer.lMatrix(opts);
  };

  /**
   * dMatrix({ from, to, matrix }):
   * Direction transform (mat3) mapping vectors from `from` space to `to` space.
   * Translation ignored. treegl semantics: linear_part(from^-1 * to).
   * If `matrix` (mat4) is provided, uses linear_part(matrix).
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.from=new p5.Matrix()] Source frame matrix.
   * @param {p5.Matrix} [opts.to=this.eMatrix()] Target frame matrix.
   * @param {p5.Matrix} [opts.matrix] Precomputed mat4 override.
   * @returns {p5.Matrix} mat3
   */
  p5.Renderer3D.prototype.dMatrix = function ({
    from = new p5.Matrix(4),
    to = this.eMatrix(),
    matrix
  } = {}) {
    const m = (matrix || _invert(from).mult(to));
    const a = m.mat4 || m.matrix; // v2: mat4 getter if 4x4, else fallback
    // Note: this is the same "mat4 -> mat3 transpose" as treegl (baked into indices)
    return new p5.Matrix([
      a[0], a[4], a[8],
      a[1], a[5], a[9],
      a[2], a[6], a[10]
    ]);
  };

  /**
   * dMatrix({ from, to, matrix }):
   * Direction transform (mat3) mapping vectors from `from` space to `to` space.
   * Requires 3D renderer.
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.from]
   * @param {p5.Matrix} [opts.to]
   * @param {p5.Matrix} [opts.matrix]
   * @returns {p5.Matrix} mat3
   */
  fn.dMatrix = function (opts = {}) {
    return this._renderer.dMatrix(opts);
  };
  
  /**
   * mvMatrix({ vMatrix, mMatrix }):
   * ModelView matrix (mat4) = M * V (p5-v2 convention).
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.vMatrix] View matrix override.
   * @param {p5.Matrix} [opts.mMatrix] Model matrix override.
   * @returns {p5.Matrix}
   */
  p5.Renderer3D.prototype.mvMatrix = function ({ vMatrix, mMatrix } = {}) {
    return (mMatrix || this.states.uModelMatrix).clone().mult(vMatrix || this.states.curCamera.cameraMatrix);
  };

  /**
   * mvMatrix({ vMatrix, mMatrix }):
   * ModelView matrix (mat4) = M * V (p5-v2 convention).
   * Requires 3D renderer.
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.vMatrix]
   * @param {p5.Matrix} [opts.mMatrix]
   * @returns {p5.Matrix}
   */
  fn.mvMatrix = function (opts = {}) {
    return this._renderer.mvMatrix(opts);
  };

  /**
   * nMatrix({ vMatrix, mMatrix, mvMatrix }):
   * Normal matrix (mat3) = inverseTranspose(linear_part(MV)).
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.vMatrix] Optional view matrix.
   * @param {p5.Matrix} [opts.mMatrix] Optional model matrix.
   * @param {p5.Matrix} [opts.mvMatrix=this.mvMatrix({ mMatrix, vMatrix })] Optional MV matrix override.
   * @returns {p5.Matrix} mat3
   */
  p5.Renderer3D.prototype.nMatrix = function ({
    vMatrix,
    mMatrix,
    mvMatrix = this.mvMatrix({ mMatrix, vMatrix })
  } = {}) {
    return _transpose(_invert(mvMatrix.createSubMatrix3x3()));
  };

  /**
   * nMatrix({ vMatrix, mMatrix, mvMatrix }):
   * Normal matrix (mat3) = inverseTranspose(linear_part(MV)).
   * Requires 3D renderer.
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.vMatrix]
   * @param {p5.Matrix} [opts.mMatrix]
   * @param {p5.Matrix} [opts.mvMatrix]
   * @returns {p5.Matrix} mat3
   */
  fn.nMatrix = function (opts = {}) {
    return this._renderer.nMatrix(opts);
  };

  /**
   * pmvMatrix({ pMatrix, vMatrix, mMatrix, mvMatrix }):
   * PMV (mat4) = M * V * P (p5-v2 convention).
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.pMatrix=this.pMatrix()] Projection matrix.
   * @param {p5.Matrix} [opts.vMatrix] Optional view matrix (used if mvMatrix is computed).
   * @param {p5.Matrix} [opts.mMatrix] Optional model matrix (used if mvMatrix is computed).
   * @param {p5.Matrix} [opts.mvMatrix=this.mvMatrix({ mMatrix, vMatrix })] Optional MV matrix override.
   * @returns {p5.Matrix}
   */
  p5.Renderer3D.prototype.pmvMatrix = function ({
    pMatrix = this.pMatrix(),
    vMatrix,
    mMatrix,
    mvMatrix
  } = {}) {
    return (mvMatrix ? mvMatrix.clone() : this.mvMatrix({ mMatrix, vMatrix })).mult(pMatrix);
  };

  /**
   * pmvMatrix({ pMatrix, vMatrix, mMatrix, mvMatrix }):
   * PMV (mat4) = M * V * P (p5-v2 convention).
   * Requires 3D renderer.
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.pMatrix]
   * @param {p5.Matrix} [opts.vMatrix]
   * @param {p5.Matrix} [opts.mMatrix]
   * @param {p5.Matrix} [opts.mvMatrix]
   * @returns {p5.Matrix}
   */
  fn.pmvMatrix = function (opts = {}) {
    return this._renderer.pmvMatrix(opts);
  };

  /**
   * pvMatrix({ pMatrix, vMatrix }):
   * PV (mat4) = V * P (p5-v2 convention).
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.pMatrix=this.pMatrix()] Projection matrix.
   * @param {p5.Matrix} [opts.vMatrix=this.vMatrix()] View matrix.
   * @returns {p5.Matrix}
   */
  p5.Renderer3D.prototype.pvMatrix = function ({
    pMatrix = this.pMatrix(),
    vMatrix
  } = {}) {
    return (vMatrix || (this.states.uViewMatrix || this.states.curCamera.cameraMatrix)).clone().mult(pMatrix);
  };

  /**
   * pvMatrix({ pMatrix, vMatrix }):
   * PV (mat4) = V * P (p5-v2 convention).
   * Requires 3D renderer.
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.pMatrix]
   * @param {p5.Matrix} [opts.vMatrix]
   * @returns {p5.Matrix}
   */
  fn.pvMatrix = function (opts = {}) {
    return this._renderer.pvMatrix(opts);
  };
  
  /**
   * ipvMatrix({ pMatrix, vMatrix, pvMatrix }):
   * Inverse(PV) (mat4).
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.pMatrix] Optional projection matrix (used if pvMatrix is computed).
   * @param {p5.Matrix} [opts.vMatrix] Optional view matrix (used if pvMatrix is computed).
   * @param {p5.Matrix} [opts.pvMatrix=this.pvMatrix({ pMatrix, vMatrix })] Optional PV matrix override.
   * @returns {p5.Matrix}
   */
  p5.Renderer3D.prototype.ipvMatrix = function ({
    pMatrix,
    vMatrix,
    pvMatrix = this.pvMatrix({ pMatrix, vMatrix })
  } = {}) {
    return _invert(pvMatrix);
  };
  
  /**
   * ipvMatrix({ pMatrix, vMatrix, pvMatrix }):
   * Inverse(PV) (mat4). Requires 3D renderer.
   * @param {object} [opts]
   * @returns {p5.Matrix}
   */
  fn.ipvMatrix = function (opts = {}) {
    return this._renderer.ipvMatrix(opts);
  };

  // ---------------------------------------------------------------------------
  // Projection matrix queries (isOrtho, planes, fov, hfov)
  // ---------------------------------------------------------------------------

  /**
   * Returns true if this projection matrix is orthographic.
   * @returns {boolean}
   */
  p5.Matrix.prototype.isOrtho = function () {
    return this.mat4[15] !== 0;
  };

  /**
   * Returns true if the current projection is orthographic.
   * @returns {boolean}
   */
  p5.Renderer3D.prototype.isOrtho = function () {
    return this.pMatrix().isOrtho();
  };

  /**
   * Returns true if the current projection is orthographic.
   * Requires 3D renderer.
   * @returns {boolean}
   */
  fn.isOrtho = function () {
    return this._renderer.isOrtho();
  };

  /**
   * Near plane distance.
   * @returns {number}
   */
  p5.Matrix.prototype.nPlane = function () {
    const m = this.mat4;
    return m[15] === 0 ? m[14] / (m[10] - 1) : (1 + m[14]) / m[10];
  };

  /**
   * Far plane distance.
   * @returns {number}
   */
  p5.Matrix.prototype.fPlane = function () {
    const m = this.mat4;
    return m[15] === 0 ? m[14] / (1 + m[10]) : (m[14] - 1) / m[10];
  };

  /**
   * Left plane at the near plane.
   * @returns {number}
   */
  p5.Matrix.prototype.lPlane = function () {
    const m = this.mat4;
    return m[15] === 1 ? -(1 + m[12]) / m[0] : this.nPlane() * (m[8] - 1) / m[0];
  };

  /**
   * Right plane at the near plane.
   * @returns {number}
   */
  p5.Matrix.prototype.rPlane = function () {
    const m = this.mat4;
    return m[15] === 1 ? (1 - m[12]) / m[0] : this.nPlane() * (1 + m[8]) / m[0];
  };

  /**
   * Top plane at the near plane.
   * @returns {number}
   */
  p5.Matrix.prototype.tPlane = function () {
    const m = this.mat4;
    return m[15] === 1 ? (m[13] - 1) / m[5] : this.nPlane() * (m[9] - 1) / m[5];
  };

  /**
   * Bottom plane at the near plane.
   * @returns {number}
   */
  p5.Matrix.prototype.bPlane = function () {
    const m = this.mat4;
    return m[15] === 1 ? (1 + m[13]) / m[5] : this.nPlane() * (1 + m[9]) / m[5];
  };

  /**
   * Near plane distance for the current projection.
   * @returns {number}
   */
  p5.Renderer3D.prototype.nPlane = function () {
    return this.states.uPMatrix.nPlane();
  };

  /**
   * Far plane distance for the current projection.
   * @returns {number}
   */
  p5.Renderer3D.prototype.fPlane = function () {
    return this.states.uPMatrix.fPlane();
  };

  /**
   * Left plane for the current projection.
   * @returns {number}
   */
  p5.Renderer3D.prototype.lPlane = function () {
    return this.states.uPMatrix.lPlane();
  };

  /**
   * Right plane for the current projection.
   * @returns {number}
   */
  p5.Renderer3D.prototype.rPlane = function () {
    return this.states.uPMatrix.rPlane();
  };

  /**
   * Top plane for the current projection.
   * @returns {number}
   */
  p5.Renderer3D.prototype.tPlane = function () {
    return this.states.uPMatrix.tPlane();
  };

  /**
   * Bottom plane for the current projection.
   * @returns {number}
   */
  p5.Renderer3D.prototype.bPlane = function () {
    return this.states.uPMatrix.bPlane();
  };

  /**
   * Near plane distance for the current projection.
   * Requires 3D renderer.
   * @returns {number}
   */
  fn.nPlane = function () {
    return this._renderer.nPlane();
  };

  /**
   * Far plane distance for the current projection.
   * Requires 3D renderer.
   * @returns {number}
   */
  fn.fPlane = function () {
    return this._renderer.fPlane();
  };

  /**
   * Left plane for the current projection.
   * Requires 3D renderer.
   * @returns {number}
   */
  fn.lPlane = function () {
    return this._renderer.lPlane();
  };

  /**
   * Right plane for the current projection.
   * Requires 3D renderer.
   * @returns {number}
   */
  fn.rPlane = function () {
    return this._renderer.rPlane();
  };

  /**
   * Top plane for the current projection.
   * Requires 3D renderer.
   * @returns {number}
   */
  fn.tPlane = function () {
    return this._renderer.tPlane();
  };

  /**
   * Bottom plane for the current projection.
   * Requires 3D renderer.
   * @returns {number}
   */
  fn.bPlane = function () {
    return this._renderer.bPlane();
  };

  /**
   * Vertical field of view (radians), perspective only.
   * @returns {number|undefined}
   */
  p5.Matrix.prototype.fov = function () {
    if (this.mat4[15] !== 0) {
      console.error('[tree.matrix] fov only works for a perspective projection.');
      return;
    }
    return Math.abs(2 * Math.atan(1 / this.mat4[5]));
  };

  /**
   * Horizontal field of view (radians), perspective only.
   * @returns {number|undefined}
   */
  p5.Matrix.prototype.hfov = function () {
    if (this.mat4[15] !== 0) {
      console.error('[tree.matrix] hfov only works for a perspective projection.');
      return;
    }
    return Math.abs(2 * Math.atan(1 / this.mat4[0]));
  };

  /**
   * Vertical field of view (radians) of the current projection.
   * @returns {number|undefined}
   */
  p5.Renderer3D.prototype.fov = function () {
    return this.states.uPMatrix.fov();
  };

  /**
   * Horizontal field of view (radians) of the current projection.
   * @returns {number|undefined}
   */
  p5.Renderer3D.prototype.hfov = function () {
    return this.states.uPMatrix.hfov();
  };

  /**
   * Vertical field of view (radians) of the current projection.
   * Requires 3D renderer.
   * @returns {number|undefined}
   */
  fn.fov = function () {
    return this._renderer.fov();
  };

  /**
   * Horizontal field of view (radians) of the current projection.
   * Requires 3D renderer.
   * @returns {number|undefined}
   */
  fn.hfov = function () {
    return this._renderer.hfov();
  };
  
  fn.beginHUD = function (...args) {
    this._renderer?.beginHUD?.(...args);
    return this;
  };

  fn.endHUD = function (...args) {
    this._renderer?.endHUD?.(...args);
    return this;
  };
  
  /*
  // treegl approach:
  p5.Renderer3D.prototype.beginHUD = function () {
    if (this._hudActive === true) return;
    const p = this._pInst;
    const gl = this.drawingContext;
    const states = this.states;
    if (!p || !gl || !states) return;
    // ------------------------------------------------------------------
    // Save world state (treegl: m, v, p)
    // ------------------------------------------------------------------
    this._hudPrevCamera = states.curCamera;
    // push isolates renderer state (tree-style equivalent of treegl push)
    p.push();
    p.resetShader();
    // Ensure HUD does not inherit model transforms
    p.resetMatrix();
    // ------------------------------------------------------------------
    // Depth state
    // ------------------------------------------------------------------
    this._hudDepthWasEnabled = gl.isEnabled(gl.DEPTH_TEST);
    gl.flush();
    gl.disable(gl.DEPTH_TEST);
    // ------------------------------------------------------------------
    // HUD camera
    // ------------------------------------------------------------------
    if (this._hudCam === undefined) {
      this._hudCam = p.createCamera();
    }
    const z = Number.MAX_VALUE;
    // HUD coordinates:
    // x ∈ [0, width], y ∈ [0, height], origin at top-left
    this._hudCam.ortho(0, p.width, -p.height, 0, -z, z);
    // this._hudCam.ortho(0, p.width, 0, -p.height, -z, z); // flipped variant
    this._hudCam.camera(0, 0, 1, 0, 0, 0, 0, 1, 0);
    p.setCamera(this._hudCam);
    this._hudActive = true;
  };
  
  p5.Renderer3D.prototype.endHUD = function () {
    if (this._hudActive !== true) return;
    const p = this._pInst;
    const gl = this.drawingContext;
    const states = this.states;
    if (!p || !gl || !states) return;
    gl.flush();
    // Restore depth test
    this._hudDepthWasEnabled ? gl.enable(gl.DEPTH_TEST) : gl.disable(gl.DEPTH_TEST);
    // Restore renderer state
    p.pop();
    // Restore camera (tree equivalent of restoring u* matrices)
    if (this._hudPrevCamera !== undefined) {
      p.setCamera(this._hudPrevCamera);
    }
    this._hudPrevCamera = undefined;
    this._hudDepthWasEnabled = undefined;
    this._hudActive = false;
  };
  */
  
  p5.Renderer3D.prototype.beginHUD = function () {
    if (this._hudActive === true) return;
    const p = this._pInst;
    const states = this.states;
    if (!p || !states) return;
    p.push();
    p.resetShader();
    p.resetMatrix();
    this._hudPrevCam = states.curCamera;
    this._hudDepthMode = undefined;
    this._hudDepthWasEnabled = undefined;
    if (typeof this.clearDepth === 'function') {
      this.flushDraw?.();
      this.clearDepth(1);
      this._hudDepthMode = 'clearDepth';
    } else {
      const gl = this.drawingContext;
      if (gl && typeof gl.isEnabled === 'function' && gl.DEPTH_TEST !== undefined) {
        this._hudDepthWasEnabled = gl.isEnabled(gl.DEPTH_TEST);
        gl.flush?.();
        gl.disable(gl.DEPTH_TEST);
        this._hudDepthMode = 'depthTestToggle';
      }
    }
    if (this._hudCam === undefined) this._hudCam = p.createCamera();
    const z = 1e6;
    this._hudCam.ortho(0, p.width, -p.height, 0, -z, z);
    this._hudCam.camera(0, 0, 1, 0, 0, 0, 0, 1, 0);
    p.setCamera(this._hudCam);
    this._hudActive = true;
  }
  
  p5.Renderer3D.prototype.endHUD = function () {
    if (this._hudActive !== true) return;
    const p = this._pInst;
    if (!p) return;
    if (this._hudDepthMode === 'depthTestToggle') {
      const gl = this.drawingContext;
      if (gl && gl.DEPTH_TEST !== undefined) {
        gl.flush?.();
        this._hudDepthWasEnabled ? gl.enable(gl.DEPTH_TEST) : gl.disable(gl.DEPTH_TEST);
      }
    }
    p.pop();
    this._hudPrevCam !== undefined && p.setCamera(this._hudPrevCam);
    this._hudPrevCam = undefined;
    this._hudDepthWasEnabled = undefined;
    this._hudDepthMode = undefined;
    this._hudActive = false;
  }
  
  // ---------------------------------------------------------------------------
  // Space transforms: mapLocation / mapDirection
  // ---------------------------------------------------------------------------
  
  p5.Renderer3D.prototype._parseTransformArgs = function (defaultMainArg, ...args) {
    let mainArg = defaultMainArg;
    const options = {};
    for (const arg of args) {
      if (arg instanceof p5.Vector || Array.isArray(arg)) {
        mainArg = arg;
      } else if (arg && typeof arg === 'object') {
        Object.assign(options, arg);
      }
    }
    return { mainArg, options };
  };

  // ---------------------------------------------------------------------------
  // Points (positions)
  // ---------------------------------------------------------------------------
  
  fn.mapLocation = function (...args) {
    return this._renderer.mapLocation(...args);
  };
  
  /**
   * Converts a point (location) from one space into another.
   *
   * @param {p5.Vector|number[]} [point=p5.Tree.ORIGIN]
   * @param {Object} [opts]
   * @param {p5.Matrix|string} [opts.from=p5.Tree.EYE]
   * @param {p5.Matrix|string} [opts.to=p5.Tree.WORLD]
   * @param {p5.Matrix} [opts.pMatrix]
   * @param {p5.Matrix} [opts.vMatrix]
   * @param {p5.Matrix} [opts.eMatrix]
   * @param {p5.Matrix} [opts.pvMatrix]
   * @param {p5.Matrix} [opts.ipvMatrix]
   * @returns {p5.Vector}
   */
  p5.Renderer3D.prototype.mapLocation = function (...args) {
    const { mainArg, options } = this._parseTransformArgs(p5.Tree.ORIGIN, ...args);
    return this._location(mainArg, options);
  };
  
  p5.Renderer3D.prototype._location = function (
    point = p5.Tree.ORIGIN,
    {
      from = p5.Tree.EYE,
      to = p5.Tree.WORLD,
      pMatrix,
      vMatrix,
      eMatrix,
      pvMatrix,
      ipvMatrix
    } = {}
  ) {
    if (Array.isArray(point)) {
      point = new p5.Vector(point[0] ?? 0, point[1] ?? 0, point[2] ?? 0);
    }
    if (from == p5.Tree.MODEL) {
      from = this.mMatrix({ eMatrix });
    }
    if (to == p5.Tree.MODEL) {
      to = this.mMatrix({ eMatrix });
    }
    if ((from == p5.Tree.WORLD) && (to == p5.Tree.SCREEN)) {
      return this._worldToScreenLocation({ point, pMatrix, vMatrix, pvMatrix });
    }
    if ((from == p5.Tree.SCREEN) && (to == p5.Tree.WORLD)) {
      return this._screenToWorldLocation({ point, pMatrix, vMatrix, pvMatrix, ipvMatrix });
    }
    if (from == p5.Tree.SCREEN && to == p5.Tree.NDC) {
      return this._screenToNDCLocation(point);
    }
    if (from == p5.Tree.NDC && to == p5.Tree.SCREEN) {
      return this._ndcToScreenLocation(point);
    }
    if (from == p5.Tree.WORLD && to == p5.Tree.NDC) {
      return this._screenToNDCLocation(
        this._worldToScreenLocation({ point, pMatrix, vMatrix, pvMatrix })
      );
    }
    if (from == p5.Tree.NDC && to == p5.Tree.WORLD) {
      return this._screenToWorldLocation({
        point: this._ndcToScreenLocation(point),
        pMatrix,
        vMatrix,
        pvMatrix,
        ipvMatrix
      });
    }
    if (from == p5.Tree.NDC && (to instanceof p5.Matrix || to == p5.Tree.EYE)) {
      return (to == p5.Tree.EYE
        ? (vMatrix ?? this.vMatrix())
        : to.copy().invert(to)
      ).mult4(
        this._screenToWorldLocation({
          point: this._ndcToScreenLocation(point),
          pMatrix,
          vMatrix,
          pvMatrix,
          ipvMatrix
        })
      );
    }
    if ((from instanceof p5.Matrix || from == p5.Tree.EYE) && to == p5.Tree.NDC) {
      return this._screenToNDCLocation(
        this._worldToScreenLocation({
          point: (from == p5.Tree.EYE
            ? (eMatrix ?? this.eMatrix())
            : from
          ).mult4(point),
          pMatrix,
          vMatrix,
          pvMatrix
        })
      );
    }
    if (from == p5.Tree.WORLD && (to instanceof p5.Matrix || to == p5.Tree.EYE)) {
      return (to == p5.Tree.EYE
        ? (vMatrix ?? this.vMatrix())
        : to.copy().invert(to)
      ).mult4(point);
    }
    if ((from instanceof p5.Matrix || from == p5.Tree.EYE) && to == p5.Tree.WORLD) {
      return (from == p5.Tree.EYE
        ? (eMatrix ?? this.eMatrix())
        : from
      ).mult4(point);
    }
    if (from instanceof p5.Matrix && to instanceof p5.Matrix) {
      return this.lMatrix({ from: from, to: to }).mult4(point);
    }
    if (from == p5.Tree.SCREEN && (to instanceof p5.Matrix || to == p5.Tree.EYE)) {
      return (to == p5.Tree.EYE
        ? (vMatrix ?? this.vMatrix())
        : to.copy().invert(to)
      ).mult4(
        this._screenToWorldLocation({ point, pMatrix, vMatrix, pvMatrix, ipvMatrix })
      );
    }
    if ((from instanceof p5.Matrix || from == p5.Tree.EYE) && to == p5.Tree.SCREEN) {
      return this._worldToScreenLocation({
        point: (from == p5.Tree.EYE
          ? (eMatrix ?? this.eMatrix())
          : from
        ).mult4(point),
        pMatrix,
        vMatrix,
        pvMatrix
      });
    }
    if (from instanceof p5.Matrix && to == p5.Tree.EYE) {
      return (vMatrix ?? this.vMatrix()).mult4(from.mult4(point));
    }
    if (from == p5.Tree.EYE && to instanceof p5.Matrix) {
      return to.copy().invert(to).mult4((eMatrix ?? this.eMatrix()).mult4(point));
    }
    console.error('couldn\'t parse your mapLocation query!');
    return point;
  };
  
  p5.Renderer3D.prototype._ndcToScreenLocation = function (point) {
    const p = this._pInst;
    return p.createVector(
      p.map(point.x, -1, 1, 0, this.width),
      p.map(point.y, -1, 1, 0, this.height),
      p.map(point.z, -1, 1, 0, 1)
    );
  };
  
  p5.Renderer3D.prototype._screenToNDCLocation = function (point) {
    const p = this._pInst;
    return p.createVector(
      p.map(point.x, 0, this.width, -1, 1),
      p.map(point.y, 0, this.height, -1, 1),
      p.map(point.z, 0, 1, -1, 1)
    );
  };
  
  p5.Renderer3D.prototype._worldToScreenLocation = function ({
    point = new p5.Vector(0, 0, 0.5),
    pMatrix,
    vMatrix,
    pvMatrix = this.pvMatrix({ pMatrix, vMatrix })
  } = {}) {
    let target = pvMatrix._mult4([point.x, point.y, point.z, 1]);
    if (target[3] === 0) {
      console.error('[p5.tree] World->Screen broken: check pvMatrix.');
      return point.copy();
    }
    const viewport = [0, this.height, this.width, -this.height];
    target[0] /= target[3];
    target[1] /= target[3];
    target[2] /= target[3];
    target[0] = target[0] * 0.5 + 0.5;
    target[1] = target[1] * 0.5 + 0.5;
    target[2] = target[2] * 0.5 + 0.5;
    target[0] = target[0] * viewport[2] + viewport[0];
    target[1] = target[1] * viewport[3] + viewport[1];
    return new p5.Vector(target[0], target[1], target[2]);
  };
  
  p5.Renderer3D.prototype._screenToWorldLocation = function ({
    point = new p5.Vector(this.width / 2, this.height / 2, 0.5),
    pMatrix,
    vMatrix,
    pvMatrix,
    ipvMatrix = this.ipvMatrix({ pMatrix, vMatrix, pvMatrix })
  } = {}) {
    const viewport = [0, this.height, this.width, -this.height];
    const source = [point.x, point.y, point.z, 1];
    source[0] = (source[0] - viewport[0]) / viewport[2];
    source[1] = (source[1] - viewport[1]) / viewport[3];
    source[0] = source[0] * 2 - 1;
    source[1] = source[1] * 2 - 1;
    source[2] = source[2] * 2 - 1;
    let target = ipvMatrix._mult4(source);
    if (target[3] === 0) {
      console.error('[p5.tree] Screen->World broken: check ipvMatrix.');
      return point.copy();
    }
    target[0] /= target[3];
    target[1] /= target[3];
    target[2] /= target[3];
    return new p5.Vector(target[0], target[1], target[2]);
  };
  
  // ---------------------------------------------------------------------------
  // Directions (vector displacements)
  // ---------------------------------------------------------------------------
  
  fn.mapDirection = function (...args) {
    return this._renderer.mapDirection(...args);
  };
  
  /**
   * Converts a vector displacement from one space into another.
   *
   * @param {p5.Vector|number[]} [vector=p5.Tree._k]
   * @param {Object} [opts]
   * @param {p5.Matrix|string} [opts.from=p5.Tree.EYE]
   * @param {p5.Matrix|string} [opts.to=p5.Tree.WORLD]
   * @param {p5.Matrix} [opts.vMatrix]
   * @param {p5.Matrix} [opts.eMatrix]
   * @param {p5.Matrix} [opts.pMatrix]
   * @returns {p5.Vector}
   */
  p5.Renderer3D.prototype.mapDirection = function (...args) {
    const { mainArg, options } = this._parseTransformArgs(p5.Tree._k, ...args);
    return this._direction(mainArg, options);
  };
  
  p5.Renderer3D.prototype._direction = function (
    vector = p5.Tree._k,
    {
      from = p5.Tree.EYE,
      to = p5.Tree.WORLD,
      vMatrix,
      eMatrix,
      pMatrix
    } = {}
  ) {
    if (Array.isArray(vector)) {
      vector = new p5.Vector(vector[0] ?? 0, vector[1] ?? 0, vector[2] ?? 0);
    }
    if (from === p5.Tree.MODEL) from = this.mMatrix({ eMatrix });
    if (to === p5.Tree.MODEL) to = this.mMatrix({ eMatrix });
    if (from === p5.Tree.WORLD && to === p5.Tree.SCREEN) return this._worldToScreenDirection(vector, pMatrix);
    if (from === p5.Tree.SCREEN && to === p5.Tree.WORLD) return this._screenToWorldDirection(vector, pMatrix);
    if (from === p5.Tree.SCREEN && to === p5.Tree.NDC) return this._screenToNDCDirection(vector);
    if (from === p5.Tree.NDC && to === p5.Tree.SCREEN) return this._ndcToScreenDirection(vector);
    if (from === p5.Tree.WORLD && to === p5.Tree.NDC) {
      return this._screenToNDCDirection(this._worldToScreenDirection(vector, pMatrix));
    }
    if (from === p5.Tree.NDC && to === p5.Tree.WORLD) {
      return this._screenToWorldDirection(this._ndcToScreenDirection(vector), pMatrix);
    }
    if (from === p5.Tree.NDC && to === p5.Tree.EYE) {
      const m = this.dMatrix({ matrix: eMatrix ?? this.eMatrix() }); // mat3
      return m.multiplyVec3(
        this._screenToWorldDirection(this._ndcToScreenDirection(vector), pMatrix)
      );
    }
    if (from === p5.Tree.EYE && to === p5.Tree.NDC) {
      const m = this.dMatrix({ matrix: vMatrix ?? this.vMatrix() }); // mat3
      return this._screenToNDCDirection(
        this._worldToScreenDirection(m.multiplyVec3(vector), pMatrix)
      );
    }
    if (from === p5.Tree.SCREEN && to instanceof p5.Matrix) {
      const m = this.dMatrix({ matrix: to }); // mat3
      return m.multiplyVec3(this._screenToWorldDirection(vector, pMatrix));
    }
    if (from instanceof p5.Matrix && to === p5.Tree.SCREEN) {
      const m = this.dMatrix({ matrix: _invert(from) }); // mat3
      return this._worldToScreenDirection(m.multiplyVec3(vector), pMatrix);
    }
    if (from instanceof p5.Matrix && to instanceof p5.Matrix) {
      return this.dMatrix({ from, to }).multiplyVec3(vector); // mat3
    }
    if (from === p5.Tree.EYE && to === p5.Tree.WORLD) {
      return this.dMatrix({ matrix: vMatrix ?? this.vMatrix() }).multiplyVec3(vector); // mat3
    }
    if (from === p5.Tree.WORLD && to === p5.Tree.EYE) {
      return this.dMatrix({ matrix: eMatrix ?? this.eMatrix() }).multiplyVec3(vector); // mat3
    }
    if (from === p5.Tree.EYE && to === p5.Tree.SCREEN) {
      return this._worldToScreenDirection(
        this.dMatrix({ matrix: vMatrix ?? this.vMatrix() }).multiplyVec3(vector),
        pMatrix
      );
    }
    if (from === p5.Tree.SCREEN && to === p5.Tree.EYE) {
      return this.dMatrix({ matrix: eMatrix ?? this.eMatrix() }).multiplyVec3(
        this._screenToWorldDirection(vector, pMatrix)
      );
    }
    if (from === p5.Tree.EYE && to instanceof p5.Matrix) {
      const m = this.dMatrix({ matrix: (vMatrix ?? this.vMatrix()).apply(to) }); // mat3
      return m.multiplyVec3(vector);
    }
    if (from instanceof p5.Matrix && to === p5.Tree.EYE) {
      const m = this.dMatrix({ matrix: _invert(from).apply(eMatrix ?? this.eMatrix()) }); // mat3
      return m.multiplyVec3(vector);
    }
    if (from === p5.Tree.WORLD && to instanceof p5.Matrix) {
      return this.dMatrix({ matrix: to }).multiplyVec3(vector); // mat3
    }
    if (from instanceof p5.Matrix && to === p5.Tree.WORLD) {
      return this.dMatrix({ matrix: _invert(from) }).multiplyVec3(vector); // mat3
    }
  
    if (from instanceof p5.Matrix && to === p5.Tree.NDC) {
      const m = this.dMatrix({ matrix: _invert(from) }); // mat3
      return this._screenToNDCDirection(this._worldToScreenDirection(m.multiplyVec3(vector), pMatrix));
    }
    if (from === p5.Tree.NDC && to instanceof p5.Matrix) {
      const m = this.dMatrix({ matrix: to }); // mat3
      return m.multiplyVec3(
        this._screenToWorldDirection(this._ndcToScreenDirection(vector), pMatrix)
      );
    }
    console.error('[p5.tree] mapDirection: could not parse query.');
    return vector;
  };
  
  p5.Renderer3D.prototype._worldToScreenDirection = function (vector, pMatrix) {
    pMatrix = pMatrix ?? this.pMatrix();
    const eyeVector = this._direction(vector, { from: p5.Tree.WORLD, to: p5.Tree.EYE });
    let dx = eyeVector.x;
    let dy = eyeVector.y;
    const perspective = pMatrix.mat4[15] === 0;
    if (perspective) {
      const zEye = this._location(p5.Tree.ORIGIN, { from: p5.Tree.WORLD, to: p5.Tree.EYE }).z;
      const k = Math.abs(zEye * Math.tan(pMatrix.fov() / 2));
      dx /= 2 * k / this.height;
      dy /= 2 * k / this.height;
    }
    let dz = eyeVector.z;
    dz /= (pMatrix.nPlane() - pMatrix.fPlane()) / (
      perspective
        ? Math.tan(pMatrix.fov() / 2)
        : Math.abs(pMatrix.rPlane() - pMatrix.lPlane()) / this.width
    );
    return new p5.Vector(dx, dy, dz);
  };
  
  p5.Renderer3D.prototype._screenToWorldDirection = function (vector, pMatrix) {
    pMatrix = pMatrix ?? this.pMatrix();
  
    let dx = vector.x;
    let dy = vector.y;
  
    const perspective = pMatrix.mat4[15] === 0;
    if (perspective) {
      const zEye = this._location(p5.Tree.ORIGIN, { from: p5.Tree.WORLD, to: p5.Tree.EYE }).z;
      const k = Math.abs(zEye * Math.tan(pMatrix.fov() / 2));
      dx *= 2 * k / this.height;
      dy *= 2 * k / this.height;
    }
  
    let dz = vector.z;
    dz *= (pMatrix.nPlane() - pMatrix.fPlane()) / (
      perspective
        ? Math.tan(pMatrix.fov() / 2)
        : Math.abs(pMatrix.rPlane() - pMatrix.lPlane()) / this.width
    );
  
    return this._direction(new p5.Vector(dx, dy, dz), { from: p5.Tree.EYE, to: p5.Tree.WORLD });
  };
  
  p5.Renderer3D.prototype._ndcToScreenDirection = function (vector) {
    return new p5.Vector(this.width * vector.x / 2, this.height * vector.y / 2, vector.z / 2);
  };
  
  p5.Renderer3D.prototype._screenToNDCDirection = function (vector) {
    return new p5.Vector(2 * vector.x / this.width, 2 * vector.y / this.height, 2 * vector.z);
  };
  
  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  
  /**
   * Returns the world-to-pixel ratio units at a given world point position.
   *
   * A line of `n * pixelRatio(point)` world units will be projected with a
   * length of `n` pixels on screen (locally around that point).
   *
   * - In orthographic projection, the ratio is constant.
   * - In perspective projection, the ratio depends on eye-space depth.
   *
   * Requires 3D renderer.
   *
   * @param {p5.Vector|number[]} [point=p5.Tree.ORIGIN] World-space point.
   * @returns {number|undefined} World units per pixel at the given point.
   */
  fn.pixelRatio = function (point) {
    return this._renderer.pixelRatio(point);
  };
  
  /**
   * Returns the world-to-pixel ratio units at a given world point position.
   * @param {p5.Vector|number[]} [point=p5.Tree.ORIGIN]
   * @returns {number}
   */
  p5.Renderer3D.prototype.pixelRatio = function (point = p5.Tree.ORIGIN) {
    return this.isOrtho()
      ? Math.abs(this.tPlane() - this.bPlane()) / this.height
      : 2 * Math.abs(
        this.mapLocation(point, { from: p5.Tree.WORLD, to: p5.Tree.EYE }).z
      ) * Math.tan(this.fov() / 2) / this.height;
  };

  /**
   * Returns the normalized texel size for an image/texture.
   * Useful for offsetting UVs by exactly one pixel.
   *
   * @param {p5.Image|p5.Framebuffer|Object} image Any object exposing `width` and `height`.
   * @returns {number[]} `[1 / width, 1 / height]`
   */
  fn.texOffset = function (image) {
    return [1 / image.width, 1 / image.height];
  };

  /**
   * Returns the current mouse position in *pixel* coordinates.
   * By default the y-axis is flipped so y=0 is at the bottom (HUD-style).
   *
   * @param {boolean} [flip=true] Whether to flip the y coordinate.
   * @returns {number[]} `[x, y]` in pixels (includes pixelDensity scaling).
   */
  fn.mousePosition = function (flip = true) {
    const pd = this.pixelDensity();
    return [pd * this.mouseX, pd * (flip ? this.height - this.mouseY : this.mouseY)];
  };

  /**
   * Returns a pointer position in *pixel* coordinates from an arbitrary (x, y) pair.
   * Delegates to the active 3D renderer.
   *
   * Accepts parameters in any order:
   * - `number, number` → pointerX, pointerY
   * - optional `boolean` → `flip`
   *
   * @param  {...(number|boolean)} args
   * @returns {number[]|undefined} `[x, y]` in pixels, or undefined if no 3D renderer is active.
   */
  fn.pointerPosition = function (...args) {
    return this._renderer.pointerPosition(...args);
  };

  /**
   * Returns the canvas resolution in *pixel* coordinates.
   * Delegates to the active 3D renderer.
   *
   * @returns {number[]|undefined} `[width, height]` in pixels, or undefined if no 3D renderer is active.
   */
  fn.resolution = function () {
    return this._renderer.resolution();
  };

  /**
   * Returns a pointer position in *pixel* coordinates from an arbitrary (x, y) pair.
   *
   * Accepts parameters in any order:
   * - `number, number` → pointerX, pointerY
   * - optional `boolean` → `flip`
   *
   * @param  {...(number|boolean)} args
   * @returns {number[]} `[x, y]` in pixels (includes pixelDensity scaling).
   */
  p5.Renderer3D.prototype.pointerPosition = function (...args) {
    let pointerX;
    let pointerY;
    let flip = true;
    for (const arg of args) {
      if (typeof arg === 'number') {
        // First number is x, second is y.
        pointerX === undefined ? (pointerX = arg) : (pointerY = arg);
      } else if (typeof arg === 'boolean') {
        flip = arg;
      }
    }
    const pd = this.pixelDensity();
    return [pd * pointerX, pd * (flip ? this.height - pointerY : pointerY)];
  };

  /**
   * Returns the canvas resolution in *pixel* coordinates.
   * @returns {number[]} `[width, height]` in pixels (includes pixelDensity scaling).
   */
  p5.Renderer3D.prototype.resolution = function () {
    const pd = this.pixelDensity();
    return [pd * this.width, pd * this.height];
  };
}
