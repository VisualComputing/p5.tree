/**
 * @file Adds Tree rendering functions to the p5 prototype.
 * @version 0.0.11
 * @author JP Charalambos
 * @license GPL-3.0-only
 *
 * @description
 * A p5.js 3D addon for matrix queries, shader workflows, and space transformations.
 * 
 * Camera path recording/playback section.
 *
 * Requires 3D renderer (p5.Camera).
 *
 * Camera API:
 *   camera.path : p5.Camera[]
 *   camera.addPath(...)
 *   camera.playPath(...)
 *   camera.stopPath(...)
 *   camera.resetPath(...)
 *   camera.seekPath(...)
 *
 * p5 wrappers (same names) forward to current active camera.
 *
 * Uses p5 lifecicle predraw hook to tick playback automatically.
 *
 * Projection safety:
 *   p5.Camera.slerp requires that all cameras use the same projection.
 *   We enforce this by comparing projMatrix.mat4 signatures.
 */

/*
 TODO's
 i.   beginHUD / endHUD text() issue (seems like an upstream matter)
 ii.  mapLocation & mapDirection stress test
 iii. Port p5.treegl parseGeometry?
 iii. Shader & effects handling
 iv.  p5.strands interface
 */

'use strict';

import p5 from 'p5';

p5.registerAddon((p5, fn, lifecycles) => {
  // --- namespace (module shelf) ---
  p5.Tree ||= {};
  
  const CONST = value => ({ value, writable: false, enumerable: true, configurable: false });
  
  Object.defineProperties(p5.Tree, {
    VERSION: CONST('0.0.11'),
                          
    NONE: CONST(0),
  
    // Spaces
    WORLD: CONST('WORLD'),
    EYE: CONST('EYE'),
    NDC: CONST('NDC'),
    SCREEN: CONST('SCREEN'),
    MODEL: CONST('MODEL'),
    OBJECT: CONST('MODEL'), // alias of MODEL (shader terminology)
  
    // Points and vectors
    ORIGIN: CONST(Object.freeze([0, 0, 0])),
  
    i: CONST(Object.freeze([1, 0, 0])),
    j: CONST(Object.freeze([0, 1, 0])),
    k: CONST(Object.freeze([0, 0, 1])),
  
    _i: CONST(Object.freeze([-1, 0, 0])),
    _j: CONST(Object.freeze([0, -1, 0])),
    _k: CONST(Object.freeze([0, 0, -1])),
                          
    // Axes / grid bits & styles
    X: CONST(1 << 0),
    _X: CONST(1 << 1),
    Y: CONST(1 << 2),
    _Y: CONST(1 << 3),
    Z: CONST(1 << 4),
    _Z: CONST(1 << 5),
    LABELS: CONST(1 << 6),
                          
    // bullsEye
    CIRCLE: CONST(0),
    SQUARE: CONST(1),
                          
    // View frustum bits
    NEAR:   CONST(1 << 0),
    FAR:    CONST(1 << 1),
    LEFT:   CONST(1 << 2),
    RIGHT:  CONST(1 << 3),
    BOTTOM: CONST(1 << 4),
    TOP:    CONST(1 << 5),
    BODY:   CONST(1 << 6),
    APEX:   CONST(1 << 7),
                          
    // Visibility
    INVISIBLE: CONST(0),
    VISIBLE: CONST(1),
    SEMIVISIBLE: CONST(2),
  });
  
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

  // --- private storage (WeakMap avoids mutating p5/p5.Camera instances) ---
  const PATH_STATE = new WeakMap();
  const PATH_PLAYERS = new WeakMap();

  const clamp01 = function (x) {
    return x < 0 ? 0 : (x > 1 ? 1 : x);
  };

  const isFiniteNumber = function (x) {
    return typeof x === 'number' && Number.isFinite(x);
  };

  const warn = function (msg) {
    console.warn('[tree.camera.path] ' + msg);
  };

  const ensurePath = function (cam) {
    cam.path || (cam.path = []);
    return cam.path;
  };
  
  const EMPTY_PATH = [];

  const peekPath = function (cam) {
    return cam.path || EMPTY_PATH;
  };

  const segmentCount = function (path) {
    return Math.max(0, path.length - 1);
  };

  const getState = function (cam) {
    let st = PATH_STATE.get(cam);
    if (!st) {
      st = {
      playing: false,
      loop: false,
      pingPong: false,
      onEnd: undefined,
      rate: 1,
      duration: 30, // frames per segment
      seg: 0,
      f: 0,
      pathIsOrtho: undefined
      };
      PATH_STATE.set(cam, st);
    }
    return st;
  };
  
  const getPlayers = function (pInst) {
    let players = PATH_PLAYERS.get(pInst);
    if (!players) {
      players = new Set();
      PATH_PLAYERS.set(pInst, players);
    }
    return players;
  };

  /**
   * Interpolate camera pose at normalized global t in [0..1] along the whole path.
   * Also updates internal seg/f so playPath resumes from that position.
   */
  const seekGlobal = function (cam, t) {
    const path = ensurePath(cam);
    const nSeg = segmentCount(path);
    if (nSeg === 0) return;
    const st = getState(cam);
    const tt = clamp01(t);
    const x = tt * nSeg;
    const seg = Math.min(nSeg - 1, Math.floor(x));
    const amt = x - seg;
    cam.slerp(path[seg], path[seg + 1], amt);
    st.seg = seg;
    st.f = Math.round(amt * Math.max(1, st.duration | 0));
  };

  /**
   * Interpolate camera pose at amt in [0..1] within a specific segment index.
   */
  const seekSegment = function (cam, amt, segIndex) {
    const path = ensurePath(cam);
    const nSeg = segmentCount(path);
    if (nSeg === 0) return;
    const st = getState(cam);
    const seg = Math.max(0, Math.min(segIndex | 0, nSeg - 1));
    const a = clamp01(amt);
    cam.slerp(path[seg], path[seg + 1], a);
    st.seg = seg;
    st.f = Math.round(a * Math.max(1, st.duration | 0));
  };

  /**
   * Playback tick.
   *
   * Playback runs in "frames per segment" (`duration`), and `rate` is interpreted
   * as a speed multiplier applied per frame.
   *
   * Rate semantics:
   * - rate > 0 : forward playback
   * - rate < 0 : reverse playback
   * - rate === 0 : stopped
   *
   * The absolute value of `rate` is used as a per-frame advance amount.
   * Fractional rates are supported (e.g. 0.5 plays at half speed).
   *
   * Segment boundaries are handled according to playback mode:
   * - pingPong: bounce at the ends and reverse direction
   * - loop: wrap around to the opposite end
   * - otherwise: stop at the end and optionally invoke `onEnd`
   */
  const tick = function (cam) {
    const st = getState(cam);
    if (!st.playing) return;
    const path = ensurePath(cam);
    const nSeg = segmentCount(path);
    if (nSeg === 0) {
      st.playing = false;
      return;
    }
    const dur = Math.max(1, st.duration | 0);
    const speed = Math.abs(st.rate);
    if (speed === 0) {
      st.playing = false;
      return;
    }
    let dir = st.rate >= 0 ? 1 : -1;
    st.f += speed;
    while (st.f >= dur) {
      st.f -= dur;
      st.seg += dir;
      if (st.seg >= nSeg || st.seg < 0) {
        if (st.pingPong) {
          // Bounce at endpoints and flip direction.
          if (dir > 0) {
            st.seg = nSeg - 1;
            st.f = 0;
            st.rate = -speed;
          } else {
            st.seg = 0;
            st.f = 0;
            st.rate = speed;
          }
          dir = st.rate >= 0 ? 1 : -1;
        } else if (st.loop) {
          st.seg = dir > 0 ? 0 : (nSeg - 1);
        } else {
          st.playing = false;
          seekGlobal(cam, dir > 0 ? 1 : 0);
          const cb = st.onEnd;
          if (typeof cb === 'function') {
            try { cb(cam); } catch (e) { /* ignore user callback errors */ }
          }
          return;
        }
      }
    }
    const local = st.f / dur;
    const amt = dir > 0 ? local : (1 - local);
    cam.slerp(path[st.seg], path[st.seg + 1], amt);
  };

  // ------------------------
  // v2 addon lifecycle hooks
  // ------------------------
  
  lifecycles.postsetup = function () {
    if (!(this._renderer instanceof p5.Renderer3D)) {
      throw new Error('p5.tree requires WEBGL or WEBGPU. Use createCanvas(w, h, WEBGL) or WEBGPU.');
    }
  };

  lifecycles.predraw = function () {
    const players = getPlayers(this);
    players.forEach(cam => {
      tick(cam);
      getState(cam).playing || players.delete(cam);
    });
  };
  
  lifecycles.remove = function () {
    const players = PATH_PLAYERS.get(this);
    players && players.clear();
    this.releasePipe(true);
  };

  // ----------
  // Camera API
  // ----------

  /**
   * addPath overloads (opts, if present, must be last; opts is the only allowed plain object):
   *
   *   camera.addPath();                                // snapshot this camera
   *   camera.addPath(opts);                            // snapshot this camera (with opts)
   *
   *   camera.addPath(otherCam, opts);                  // snapshot otherCam
   *   camera.addPath([camA, camB, ...], opts);         // bulk add (cameras)
   *
   *   camera.addPath(eye, center, up, opts);           // eye/center/up: p5.Vector or [x, y, z]
   *
   *   camera.addPath(view, opts);                      // view: p5.Matrix (4x4) or mat4[16]
   *                                                    // (world -> camera), like p5.Camera.cameraMatrix
   *   camera.addPath([viewA, viewB, ...], opts);       // bulk add (views)
   *
   * Options:
   *   - reset: boolean (default false) Clears the current path before adding.
   *
   * Notes:
   * - Keyframes are stored as camera snapshots (p5.Camera.copy()) so Camera.slerp() works.
   * - Projection compatibility is enforced (Camera.slerp requires same projection).
   *
   * @param  {...any} args
   * @returns {p5.Camera} this
   */
  p5.Camera.prototype.addPath = function (...args) {
    const st = getState(this);
    const path = ensurePath(this);
    const isPlainObject = v => {
      if (!v || typeof v !== 'object') return false;
      if (Array.isArray(v)) return false;
      if (ArrayBuffer.isView(v)) return false;
      return Object.getPrototypeOf(v) === Object.prototype;
    };
    const isVec3 = v =>
      v instanceof p5.Vector ||
      (Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n)));
    const toVec3 = v => v instanceof p5.Vector ? [v.x, v.y, v.z] : [v[0], v[1], v[2]];
    const sameKeyframe = function (a, b) {
      if (!a || !b) return false;
      const aCM = a.cameraMatrix && a.cameraMatrix.mat4;
      const bCM = b.cameraMatrix && b.cameraMatrix.mat4;
      if (!aCM || !bCM) return false;
      for (let i = 0; i < 16; i++) if (aCM[i] !== bCM[i]) return false;
      return true;
    };
    const addSnapshot = c => {
      const last = path.length ? path[path.length - 1] : undefined;
      last && sameKeyframe(last, c) || path.push(c.copy());
    };
    const isOrthoCam = c => {
      const m = c && c.projMatrix && c.projMatrix.mat4;
      return m && m.length === 16 ? (m[15] !== 0) : undefined;
    };
    const initProjBaseline = c => {
      if (st.pathIsOrtho !== undefined) return;
      const v = isOrthoCam(c);
      st.pathIsOrtho = v;
      v === undefined && warn('addPath: unable to verify projection type (projMatrix.mat4 unavailable).');
    };
    const checkProjCompat = c => {
      initProjBaseline(c);
      const v = isOrthoCam(c);
      if (st.pathIsOrtho === undefined || v === undefined) {
        v === undefined && warn('addPath: unable to verify projection type (projMatrix.mat4 unavailable).');
        return true;
      }
      if (v !== st.pathIsOrtho) {
        warn('addPath rejected: keyframe has different projection type (ortho vs perspective).');
        return false;
      }
      return true;
    };
    const isMat4Array = v =>
      (Array.isArray(v) || ArrayBuffer.isView(v)) &&
      v.length === 16 &&
      Array.prototype.every.call(v, n => typeof n === 'number' && Number.isFinite(n));
    const isView = v => v instanceof p5.Matrix || isMat4Array(v);
    const toMat4 = v => v instanceof p5.Matrix ? v.mat4 : v;
    const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const len3 = v => Math.sqrt(dot3(v, v));
    const norm3 = v => {
      const l = len3(v) || 1;
      return [v[0] / l, v[1] / l, v[2] / l];
    };
    const importViewToCamera = view => {
      // view is a column-major mat4, world -> camera (p5.Camera.cameraMatrix).
      const m = toMat4(view);
      // Rows of rotation part (world->camera):
      const right = norm3([m[0], m[4], m[8]]);
      const up = norm3([m[1], m[5], m[9]]);
      const negFwd = norm3([m[2], m[6], m[10]]);
      const fwd = [-negFwd[0], -negFwd[1], -negFwd[2]];
      // Translation column: t = -R^T * eye
      const t = [m[12], m[13], m[14]];
      // eye = -(t0*right + t1*up) + t2*forward
      const eye = [
        -(t[0] * right[0] + t[1] * up[0]) + t[2] * fwd[0],
        -(t[0] * right[1] + t[1] * up[1]) + t[2] * fwd[1],
        -(t[0] * right[2] + t[1] * up[2]) + t[2] * fwd[2]
      ];
      // Enforce center using this camera’s current focus distance.
      const dist = Math.sqrt(
        (this.centerX - this.eyeX) * (this.centerX - this.eyeX) +
        (this.centerY - this.eyeY) * (this.centerY - this.eyeY) +
        (this.centerZ - this.eyeZ) * (this.centerZ - this.eyeZ)
      ) || 1;
      const center = [
        eye[0] + fwd[0] * dist,
        eye[1] + fwd[1] * dist,
        eye[2] + fwd[2] * dist
      ];
      // Important: use camera(...) so cameraMatrix stays consistent with eye/center/up.
      const c = this.copy();
      c.camera(
        eye[0], eye[1], eye[2],
        center[0], center[1], center[2],
        up[0], up[1], up[2]
      );
      return c;
    };
    // --- opts extraction (opts always last; only plain object is opts) ---
    const o = args.length && isPlainObject(args[args.length - 1]) ? args.pop() : {};
    if (o.reset) {
      path.length = 0;
      st.seg = 0;
      st.f = 0;
      st.pathIsOrtho = undefined;
    }
    initProjBaseline(this);
    // addPath() -> snapshot this
    if (args.length === 0) {
      addSnapshot(this);
      return this;
    }
    // addPath(view) OR addPath(camera) OR addPath([cameras]) OR addPath([views])
    if (args.length === 1) {
      const override = args[0];
      // single view
      if (isView(override)) {
        const c = importViewToCamera(override);
        checkProjCompat(c) && addSnapshot(c);
        return this;
      }
      // bulk: views or cameras
      if (Array.isArray(override)) {
        const list = override;
        // bulk views
        if (list.length && list.every(isView)) {
          for (let i = 0; i < list.length; i++) {
            const c = importViewToCamera(list[i]);
            checkProjCompat(c) && addSnapshot(c);
          }
          return this;
        }
        // bulk cameras (existing behavior)
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          if (!(c instanceof p5.Camera)) {
            warn('addPath: ignored non-camera value.');
            continue;
          }
          checkProjCompat(c) && addSnapshot(c);
        }
        return this;
      }
      // single camera
      if (override instanceof p5.Camera) {
        checkProjCompat(override) && addSnapshot(override);
        return this;
      }
      warn('addPath: ignored unsupported arguments.');
      return this;
    }
    // addPath(eye, center, up, opts)
    if (args.length === 3 && args.every(isVec3)) {
      const eye = toVec3(args[0]);
      const center = toVec3(args[1]);
      const up = norm3(toVec3(args[2]));
      // Important: use camera(...) so cameraMatrix stays consistent with eye/center/up.
      const c = this.copy();
      c.camera(
        eye[0], eye[1], eye[2],
        center[0], center[1], center[2],
        up[0], up[1], up[2]
      );
      checkProjCompat(c) && addSnapshot(c);
      return this;
    }
    warn('addPath: ignored unsupported arguments.');
    return this;
  };

  /**
   * playPath overloads:
   *   camera.playPath(rate)
   *   camera.playPath({ duration, loop, pingPong, onEnd, rate })
   *
   * Playback runs in "frames per segment" (duration), and rate is interpreted as a
   * simple speed multiplier:
   * - rate > 0 : forward
   * - rate < 0 : reverse
   * - rate === 0 : stopped (does not register for ticking)
   *
   * duration: frames per segment (default 30).
   * loop: wraps at ends (default false).
   * pingPong: bounces at ends (default false).
   * onEnd: called when playback naturally ends (non-looping, non-pingpong).
   *
   * Special case (single keyframe):
   * If camera.path has exactly 1 keyframe, playPath does not start playback.
   * It restores this camera pose to that keyframe (via p5.Camera.camera())
   * and ensures playback is stopped/unregistered.
   *
   * If both pingPong and loop are true, pingPong takes precedence.
   */
  p5.Camera.prototype.playPath = function (rateOrOpts) {
    const st = getState(this);
    const path = ensurePath(this);
    const pInst = this._renderer && this._renderer._pInst;
    const unregister = () => pInst && getPlayers(pInst).delete(this);
    const register = () => pInst && getPlayers(pInst).add(this);
    // 0 keyframes: nothing to do
    if (path.length === 0) {
      warn('playPath ignored: need at least 1 keyframe in camera.path.');
      st.playing = false;
      unregister();
      return this;
    }
    // 1 keyframe: restore pose only (no playback)
    if (path.length === 1) {
      const kf = path[0];
      st.playing = false;
      unregister();
      return this.camera(
        kf.eyeX, kf.eyeY, kf.eyeZ,
        kf.centerX, kf.centerY, kf.centerZ,
        kf.upX, kf.upY, kf.upZ
      );
    }
    const nSeg = segmentCount(path);
    if (nSeg === 0) {
      warn('playPath ignored: need at least 2 keyframes in camera.path.');
      st.playing = false;
      unregister();
      return this;
    }
    if (isFiniteNumber(rateOrOpts)) {
      st.rate = rateOrOpts;
    } else {
      const o = rateOrOpts || {};
      st.duration = isFiniteNumber(o.duration) ? o.duration : st.duration;
      st.loop = !!o.loop;
      st.pingPong = !!o.pingPong;
      st.onEnd = typeof o.onEnd === 'function' ? o.onEnd : st.onEnd;
      st.rate = isFiniteNumber(o.rate) ? o.rate : st.rate;
    }
    // rate === 0 means "stop" (don’t register for ticking)
    if (st.rate === 0) {
      st.playing = false;
      unregister();
      return this;
    }
    // If starting from stopped state, default to an endpoint depending on direction.
    // Important: do NOT use seekGlobal(cam, 1) for reverse start, because seekGlobal sets st.f = dur
    // and the next tick will immediately underflow the segment and stop (snap).
    if (!st.playing) {
      const forward = st.rate >= 0;
      st.seg = forward ? 0 : (nSeg - 1);
      st.f = 0;
      // Snap pose to the start/end of the current segment, but keep st.f = 0.
      this.slerp(path[st.seg], path[st.seg + 1], forward ? 0 : 1);
    }  
    st.playing = true;
    register();
    return this;
  };

  /**
   * stopPath({ reset=false })
   * - Stops playback.
   * - If reset:true, seeks to start (forward) or end (reverse).
   */
  p5.Camera.prototype.stopPath = function (opts) {
    const st = getState(this);
    const o = opts || {};
    st.playing = false;
    const pInst = this._renderer && this._renderer._pInst;
    pInst && getPlayers(pInst).delete(this);
    if (o.reset) {
      const forward = st.rate >= 0;
      seekGlobal(this, forward ? 0 : 1);
      st.seg = forward ? 0 : Math.max(0, segmentCount(ensurePath(this)) - 1);
      st.f = 0;
    }
    return this;
  };

  /**
   * resetPath(n?)
   * - resetPath() clears all keyframes and stops.
   * - resetPath(n) keeps first n keyframes (truncate) and stops.
   */
  p5.Camera.prototype.resetPath = function (n) {
    const st = getState(this);
    const path = ensurePath(this);
    st.playing = false;
    st.seg = 0;
    st.f = 0;
    const pInst = this._renderer && this._renderer._pInst;
    pInst && getPlayers(pInst).delete(this);
    if (!isFiniteNumber(n)) {
      path.length = 0;
      st.pathIsOrtho = undefined;
      return this;
    }
    const nInt = n | 0;
    const keep = Math.max(0, Math.abs(nInt));
    if (keep === 0) {
      path.length = 0;
      st.pathIsOrtho = undefined;
      return this;
    }
    if (nInt >= 0) {
      path.length = Math.min(path.length, keep);
    } else if (path.length > keep) {
      path.splice(0, path.length - keep);
    }
    if (segmentCount(path) === 0) {
      st.pathIsOrtho = undefined;
    }
    return this;
  };

  /**
   * seekPath overloads:
   *   camera.seekPath(t)              // global t in [0..1]
   *   camera.seekPath(amt, segIndex)  // segment-local
   *
   * Seeking always stops playback.
   */
  p5.Camera.prototype.seekPath = function (t, segIndex) {
    const st = getState(this);
    st.playing = false;
    const pInst = this._renderer && this._renderer._pInst;
    pInst && getPlayers(pInst).delete(this);
    if (isFiniteNumber(segIndex)) {
      seekSegment(this, t, segIndex);
      return this;
    }
    seekGlobal(this, t);
    return this;
  };
  
  /**
   * Returns the normalized playback time of the current path cursor.
   *
   * - Range: [0..1]
   * - If the path has fewer than 2 keyframes, returns 0.
   * - Pure query: does not move the camera.
   *
   * Notes:
   * - Tracks the internal path cursor (seg/f), not the camera pose if the user
   *   moves the camera manually after stopping.
   * - Direction is reflected (reverse playback decreases the value).
   *
   * @returns {number}
   */
  p5.Camera.prototype.pathTime = function () {
    const path = peekPath(this);
    const nSeg = segmentCount(path);
    if (nSeg === 0) return 0;
    const st = getState(this);
    const dur = Math.max(1, st.duration | 0);
    const dir = (st.playing && st.rate < 0) ? -1 : 1;
    const local = (st.f / dur);
    const amt = dir > 0 ? local : (1 - local);
    return clamp01((st.seg + amt) / nSeg);
  };
  
  /**
   * Returns a snapshot of the current path playback state for this camera.
   * This is a pure query: it does not expose the internal path array
   * nor allow mutation of internal state.
   *
   * Returned object fields:
   * - keyframes {number} Total keyframes in path.
   * - segments {number} Total segments (keyframes - 1).
   * - playing {boolean} Whether playback is active.
   * - loop {boolean} Whether looping is enabled.
   * - pingPong {boolean} Whether ping-pong mode is enabled.
   * - rate {number} Playback rate (signed).
   * - duration {number} Frames per segment.
   * - time {number} Normalized time in [0,1] across entire path.
   *
   * @method pathInfo
   * @return {Object} Immutable snapshot of path state.
   */
  p5.Camera.prototype.pathInfo = function () {
    const path = peekPath(this);
    const st = getState(this);
    const keyframes = path.length;
    const segments = keyframes > 0 ? keyframes - 1 : 0;
    return {
      keyframes,
      segments,
      playing: st.playing,
      loop: st.loop,
      pingPong: st.pingPong,
      rate: st.rate,
      duration: st.duration,
      time: segments > 0 ? this.pathTime() : 0
    };
  };

  // ------------------------------------------------------------
  // p5 wrappers (same names, forward to active camera)
  // ------------------------------------------------------------

  fn.addPath = function (...args) {
    const cam = this._renderer.states.curCamera;
    cam && cam.addPath(...args);
    return this;
  };

  fn.playPath = function (...args) {
    const cam = this._renderer.states.curCamera;
    cam && cam.playPath(...args);
    return this;
  };
  
  fn.seekPath = function (...args) {
    const cam = this._renderer.states.curCamera;
    cam && cam.seekPath(...args);
    return this;
  };
  
  fn.resetPath = function (...args) {
    const cam = this._renderer.states.curCamera;
    cam && cam.resetPath(...args);
    return this;
  };
  
  fn.stopPath = function (...args) {
    const cam = this._renderer.states.curCamera;
    cam && cam.stopPath(...args);
    return this;
  };
  
  fn.pathTime = function () {
    const cam = this._renderer.states.curCamera;
    return cam && cam.pathTime();
  };
  
  fn.pathInfo = function () {
    const cam = this._renderer.states.curCamera;
    return cam && cam.pathInfo();
  };
  
  // HUD

  fn.beginHUD = function (...args) {
    this._renderer?.beginHUD?.(...args);
    return this;
  }
  
  fn.endHUD = function (...args) {
    this._renderer?.endHUD?.(...args);
    return this;
  }
  
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
  
  /**
   * Creates renderer-agnostic UI controls for shader parameters (GLSL/WebGPU/p5.strands).
   * Core-only + optional default vertical layout (show/hide/config) for 99% use cases.
   * No panel, no background, no drag, no grouping; you own styling beyond basics.
   *
   * Supported control types (explicit or inferred):
   * - 'float'  : slider (createSlider)
   * - 'int'    : slider semantics (createSlider; integer step usually 1)
   * - 'bool'   : checkbox (createCheckbox)
   * - 'color'  : color picker (createColorPicker) returning RGBA as vec4 floats in [0..1]
   * - 'vec2'   : 2 sliders (x, y)
   * - 'vec3'   : 3 sliders (x, y, z)
   * - 'vec4'   : 4 sliders (x, y, z, w) (or RGBA when used as such)
   * - 'select' : dropdown (createSelect)
   * - 'button' : button (createButton) for actions (reset/randomize/etc.)
   *
   * Inference (when cfg.type is omitted):
   * - cfg.options                 -> 'select'
   * - typeof cfg.onClick === 'function' -> 'button'
   * - typeof cfg.value === 'boolean'    -> 'bool'
   * - Array cfg.value length 2/3/4      -> 'vec2'/'vec3'/'vec4'
   * - typeof cfg.value === 'string'     -> 'color' (interpreted as a color picker initial value)
   * - otherwise                         -> 'float'
   *
   * Common per-control fields (leaf specs):
   * - value: initial value (type-dependent). Optional for sliders if min/max provided.
   * - min, max, step: numeric range for sliders and vecN components.
   * - label: label text when opt.labels=true (defaults to key name).
   * - text: checkbox label text (bool) or button caption (button).
   * - options: select choices. Each entry may be a primitive or { label, value }.
   * - onClick(ui, name): button callback. Receives the UniformUI instance and the control key.
   *
   * Value semantics (what ui[name].value() returns):
   * - float/int: number
   * - bool: boolean
   * - vec2/vec3/vec4: number[] (length 2/3/4)
   * - select: selected value (string by default; can be any option value you provide)
   * - color: [r, g, b, a] as floats in [0..1] (derived from createColorPicker().color())
   * - button: always true (useful only as an action trigger; not meant as a uniform)
   *
   * Labels:
   * - Per-control labels: enabled by opt.labels (default false). If cfg.label is missing, uses the key name.
   * - Container title: opt.title (optional). Rendered above controls when provided.
   *
   * Layout:
   * - Default vertical stacking in a container div (opt.x/opt.y anchor).
   * - You can ignore layout entirely and style manually via ui.container() and ui[name].elt.
   *
   * Parent mounting:
   * - By default, the container is created via createDiv() and lives under document.body (p5 default).
   * - If opt.parent is provided (HTMLElement or p5.Element), the container is mounted into that parent.
   * - When mounted into a parent, this helper ensures the parent has a non-static CSS position (sets position: relative if needed),
   *   so the UI can be positioned predictably in component frameworks (Vue/Slidev/etc.).
   *
   * Per-control visibility:
   * - ui.visible(name, visible) toggles a single control (and its label when labels are enabled).
   *
   * @method createUniformUI
   * @memberof p5
   * @param {Object<string, Object>} [schema={}] Control schema keyed by uniform/action name.
   * @param {Object} [opt={}] Layout/options.
   * @param {number} [opt.x=0] Container x position.
   * @param {number} [opt.y=0] Container y position.
   * @param {number} [opt.width=120] Width for sliders/selects/buttons (applied to each element).
   * @param {number} [opt.offset=6] Vertical spacing between rows (labels and controls).
   * @param {string} [opt.color] Text color applied to container (inherits to label text).
   * @param {boolean} [opt.hidden=false] If true, starts hidden.
   * @param {boolean} [opt.labels=false] If true, renders per-control labels.
   * @param {string} [opt.title] Optional container title.
   * @param {(HTMLElement|p5.Element)} [opt.parent] Optional DOM parent to mount the container into.
   * @returns {p5.UniformUI} A UniformUI object holding controls and helpers.
   *
   * @example
   * // GLSL/WebGPU (setUniform path): float slider + bool checkbox
   * const ui = createUniformUI({
   *   blurIntensity: { min: 0, max: 4, value: 2, step: 0.1, label: 'blur' },
   *   enabled: { value: true, text: 'enabled' }
   * }, { x: 10, y: 10, labels: true, title: 'Post FX' });
   * // later in draw:
   * ui.applyTo(blurShader); // sets blurShader.setUniform('blurIntensity', ui.blurIntensity.value()), etc.
   *
   * @example
   * // Select dropdown + button action
   * const ui = createUniformUI({
   *   tonemap: { options: ['none', 'reinhard', 'aces'], value: 'aces', label: 'tonemap' },
   *   reset: { text: 'Reset', onClick: (ui) => ui.reset() }
   * }, { x: 10, y: 10, labels: true });
   *
   * @example
   * // Color picker: returns vec4 floats in [0..1]
   * const ui = createUniformUI({
   *   tint: { value: '#ffcc00', label: 'tint' }
   * }, { x: 10, y: 10, labels: true });
   * // later:
   * // shader.setUniform('tint', ui.tint.value()); // [r,g,b,a]
   *
   * @example
   * // vec3 control: 3 sliders sharing min/max/step
   * const ui = createUniformUI({
   *   lightDir: { value: [0, 1, 0], min: -1, max: 1, step: 0.01, label: 'light dir' }
   * }, { x: 10, y: 10, labels: true });
   *
   * @example
   * // p5.strands (graph-build callback): read values via closures
   * function blurCallback () {
   *   const blurIntensity = uniformFloat(() => ui.blurIntensity.value());
   *   const enabled = uniformBool(() => ui.enabled.value());
   *   // ...
   * }
   *
   * @example
   * // Mount into a specific container (e.g. Vue/Slidev component)
   * const ui = createUniformUI(schema, { parent: document.getElementById('sketch'), x: 10, y: 10, labels: true });
   *
   * @example
   * // Toggle a single control's UI (and label when labels=true)
   * ui.visible('blurIntensity', false);
   */
  fn.createUniformUI = function (schema = {}, opt = {}) {
    const p = this;
    const _schema = schema || {};
    const ui = {};
    const _defaults = {};
    const _order = Object.keys(_schema);
    const _layout = {
      x: opt.x ?? 0,
      y: opt.y ?? 0,
      width: opt.width ?? 120,
      offset: opt.offset ?? 6,
      color: opt.color,
      hidden: !!opt.hidden,
      labels: !!opt.labels,
      title: opt.title
    };
    let _parent = opt.parent;
    let _parentElt = _parent && (_parent.elt || _parent);
    let _container = p.createDiv();
    let _titleElt = null;
    const _labelElts = {};
    const isBool = v => typeof v === 'boolean';
    const isArr = Array.isArray;
    const isVec = v => isArr(v) && (v.length === 2 || v.length === 3 || v.length === 4);
    const isStr = v => typeof v === 'string';
    const isNum = v => typeof v === 'number' && Number.isFinite(v);
    const toFloat = v => {
      if (isNum(v)) return v;
      const n = typeof v === 'string' ? parseFloat(v) : Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const inferType = (cfg = {}) => {
      if (cfg.type) return cfg.type;
      if (cfg.options) return 'select';
      if (typeof cfg.onClick === 'function') return 'button';
      const v = cfg.value;
      if (isBool(v)) return 'bool';
      if (isVec(v)) return v.length === 2 ? 'vec2' : v.length === 3 ? 'vec3' : 'vec4';
      if (isStr(v)) return 'color';
      return 'float';
    };
    const wrap = (type, elt, value, set, reset) => ({ type, elt, value, set, reset });
    const build = (name, cfg = {}) => {
      const type = inferType(cfg);
      const def =
        type === 'vec2' ? (isArr(cfg.value) ? cfg.value.slice(0, 2) : [0, 0]) :
        type === 'vec3' ? (isArr(cfg.value) ? cfg.value.slice(0, 3) : [0, 0, 0]) :
        type === 'vec4' ? (isArr(cfg.value) ? cfg.value.slice(0, 4) : [0, 0, 0, 0]) :
        cfg.value;
      _defaults[name] = def;
      if (type === 'button') {
        const btn = p.createButton(cfg.text || cfg.name || name);
        typeof cfg.onClick === 'function' && btn.mousePressed(() => cfg.onClick(ui, name));
        return wrap('button', btn, () => true, () => {}, () => {});
      }
      if (type === 'select') {
        const sel = p.createSelect();
        (cfg.options || []).forEach(o => {
          if (typeof o === 'object') sel.option(o.label ?? String(o.value), o.value);
          else sel.option(String(o), o);
        });
        cfg.value != null && sel.selected(cfg.value);
        return wrap('select', sel, () => sel.value(), v => sel.selected(v), () => sel.selected(_defaults[name]));
      }
      if (type === 'bool') {
        const cb = p.createCheckbox(cfg.text || '', !!cfg.value);
        return wrap('bool', cb, () => cb.checked(), v => cb.checked(!!v), () => cb.checked(!!_defaults[name]));
      }
      if (type === 'color') {
        const cp = p.createColorPicker(cfg.value ?? 'white');
        const val = () => {
          const c = cp.color();
          return [p.red(c) / 255, p.green(c) / 255, p.blue(c) / 255, p.alpha(c) / 255];
        };
        return wrap('color', cp, val, v => cp.value(v), () => cp.value(_defaults[name] ?? (cfg.value ?? 'white')));
      }
      if (type === 'vec2' || type === 'vec3' || type === 'vec4') {
        const n = type === 'vec2' ? 2 : type === 'vec3' ? 3 : 4;
        const min = cfg.min ?? 0;
        const max = cfg.max ?? 1;
        const step = cfg.step ?? 0.01;
        const v0 = isArr(cfg.value) ? cfg.value : [];
        const sliders = [];
        for (let i = 0; i < n; i++) sliders.push(p.createSlider(min, max, v0[i] ?? min, step));
        const value = () => sliders.map(s => toFloat(s.value()));
        const set = (arr) => {
          const a = isArr(arr) ? arr : [];
          for (let i = 0; i < n; i++) sliders[i].value(a[i] ?? (v0[i] ?? min));
        };
        const reset = () => set(_defaults[name]);
        return wrap(type, sliders, value, set, reset);
      }
      const min = cfg.min ?? 0;
      const max = cfg.max ?? 1;
      const step = cfg.step ?? (type === 'int' ? 1 : 0.1);
      const value0 = cfg.value ?? min;
      const s = p.createSlider(min, max, value0, step);
      const value = () => toFloat(s.value());
      const set = (v) => s.value(v);
      const reset = () => s.value(_defaults[name] ?? value0);
      return wrap(type, s, value, set, reset);
    };
    for (const name of _order) ui[name] = build(name, _schema[name]);
    /**
     * Iterate controls in schema order.
     * @memberof p5.UniformUI
     * @param {function(string, Object, p5.UniformUI):void} fn (name, control, ui) callback.
     * @returns {p5.UniformUI} this.
     */
    ui.each = function (fn) {
      _order.forEach(name => fn(name, ui[name], ui));
      return ui;
    };
    /**
     * Returns a flat list of p5.Elements for all controls (vec* expands to multiple elements).
     * Does not include labels/title (use ui.container() for full DOM access).
     * @memberof p5.UniformUI
     * @returns {p5.Element[]} elements.
     */
    ui.elts = function () {
      const out = [];
      ui.each((_, c) => {
        if (!c || !c.elt) return;
        Array.isArray(c.elt) ? c.elt.forEach(e => out.push(e)) : out.push(c.elt);
      });
      return out;
    };
    /**
     * Returns the container p5.Element holding the default layout (title, labels, controls).
     * You can style it freely (background/padding/border/etc.).
     * @memberof p5.UniformUI
     * @returns {p5.Element} container element.
     */
    ui.container = function () {
      return _container;
    };
    /**
     * Snapshot current values by uniform key.
     * @memberof p5.UniformUI
     * @returns {Object<string, any>} values.
     */
    ui.values = function () {
      const out = {};
      ui.each((name, c) => { out[name] = c.value(); });
      return out;
    };
    /**
     * Set multiple control values by key.
     * @memberof p5.UniformUI
     * @param {Object<string, any>} vals values keyed by uniform.
     * @returns {p5.UniformUI} this.
     */
    ui.setValues = function (vals = {}) {
      for (const k in vals) ui[k]?.set?.(vals[k]);
      return ui;
    };
    /**
     * Reset all controls to their defaults (from schema.value or inferred defaults).
     * @memberof p5.UniformUI
     * @returns {p5.UniformUI} this.
     */
    ui.reset = function () {
      ui.each((_, c) => c.reset && c.reset());
      return ui;
    };
    /**
     * Apply all control values to a shader exposing setUniform(name, value).
     * Useful for GLSL/WebGPU shader-like APIs.
     * @memberof p5.UniformUI
     * @param {Object} shader An object with setUniform(uniformName, value).
     * @param {Object<string, (string|function|Object)>} [map={}] Optional mapping per key.
     * @returns {p5.UniformUI} this.
     *
     * @example
     * ui.applyTo(blurShader);
     * @example
     * ui.applyTo(blurShader, { blurIntensity: 'uBlur', tint: { uniform: 'uTint', value: v => v } });
     */
    ui.applyTo = function (shader, map = {}) {
      if (!shader || typeof shader.setUniform !== 'function') return ui;
      ui.each((key, c) => {
        const raw = c.value();
        const m = map[key];
        const uniform =
          typeof m === 'string' ? m :
          m && typeof m === 'object' && typeof m.uniform === 'string' ? m.uniform :
          key;
        const val =
          typeof m === 'function' ? m(raw, key, ui) :
          m && typeof m === 'object' && typeof m.value === 'function' ? m.value(raw, key, ui) :
          raw;
        shader.setUniform(uniform, val);
      });
      return ui;
    };
    /**
     * Show the entire UI container (and thus title/labels/controls).
     * @memberof p5.UniformUI
     * @returns {p5.UniformUI} this.
     */
    ui.show = function () {
      _container && _container.show();
      return ui;
    };
    /**
     * Hide the entire UI container (and thus title/labels/controls).
     * @memberof p5.UniformUI
     * @returns {p5.UniformUI} this.
     */
    ui.hide = function () {
      _container && _container.hide();
      return ui;
    };
    /**
     * Show/hide a single control by uniform key (and its label when opt.labels=true).
     * For vec2/vec3/vec4, toggles all component sliders.
     * No-op if name is unknown.
     * @memberof p5.UniformUI
     * @param {string} name Uniform key.
     * @param {boolean} [visible=true] Whether the uniform control should be visible.
     * @returns {p5.UniformUI} this.
     *
     * @example
     * ui.visible('blurIntensity', false);
     * ui.visible('blurIntensity', true);
     */
    ui.visible = function (name, visible = true) {
      const c = ui[name];
      if (!c) return ui;
      const show = visible !== false;
      const elts = Array.isArray(c.elt) ? c.elt : [c.elt];
      elts.forEach(e => { e && (show ? e.show() : e.hide()); });
      const lab = _labelElts[name];
      lab && (show ? lab.show() : lab.hide());
      return ui;
    };
    /**
     * Destroy the UI: removes container and all children from the DOM. Not reversible; create a new UI to re-add.
     * @memberof p5.UniformUI
     */
    ui.remove = function () {
      _container && _container.remove();
      _container = null;
      _titleElt = null;
      Object.keys(_labelElts).forEach(k => { delete _labelElts[k]; });
    };
    const _applyWidth = (elt) => {
      if (!elt) return;
      const w = _layout.width;
      if (!(typeof w === 'number' && Number.isFinite(w))) return;
      elt.style && elt.style('width', `${w}px`);
    };
    const _ensurePositioningContext = (elt) => {
      if (!elt || typeof getComputedStyle !== 'function') return;
      const cs = getComputedStyle(elt);
      if (cs && cs.position === 'static') elt.style.position = 'relative';
    };
    const _rebuildLayout = () => {
      if (!_container) _container = p.createDiv();
      _container.elt && (_container.elt.innerHTML = '');
      Object.keys(_labelElts).forEach(k => { delete _labelElts[k]; });
      if (_parentElt) {
        try {
          _ensurePositioningContext(_parentElt);
          _container.parent(_parentElt);
        } catch (e) {
        }
      }
      _container && _container.position(_layout.x, _layout.y);
      _layout.color && _container.elt && _container.elt.style && (_container.elt.style.color = _layout.color);
      if (_layout.title) {
        _titleElt = p.createDiv(_layout.title);
        _container.child(_titleElt);
      } else {
        _titleElt = null;
      }
      ui.each((name, c) => {
        if (_layout.labels) {
          const cfg = _schema[name] || {};
          const text = (cfg.label != null ? cfg.label : name);
          const lab = p.createDiv(String(text));
          _labelElts[name] = lab;
          _container.child(lab);
        }
        const elts = Array.isArray(c.elt) ? c.elt : [c.elt];
        elts.forEach(e => {
          _applyWidth(e);
          _container.child(e);
        });
      });
      _container.style('display', 'flex');
      _container.style('flex-direction', 'column');
      _container.style('gap', `${_layout.offset}px`);
      _layout.hidden ? _container.hide() : _container.show();
    };
    /**
     * Configure default layout parameters (position/width/spacing/color/labels/title/hidden/parent) and rebuild layout.
     * Layout-only: does not change values.
     * @memberof p5.UniformUI
     * @param {Object} [next={}] Layout options (same as createUniformUI opt).
     * @param {(HTMLElement|p5.Element)} [next.parent] Optional DOM parent to (re)mount the container into.
     * @returns {p5.UniformUI} this.
     *
     * @example
     * ui.config({ x: 20, y: 20, labels: true, title: 'Lighting' });
     * @example
     * ui.config({ parent: document.getElementById('sketch') });
     */
    ui.config = function (next = {}) {
      _layout.x = next.x ?? _layout.x;
      _layout.y = next.y ?? _layout.y;
      _layout.width = next.width ?? _layout.width;
      _layout.offset = next.offset ?? _layout.offset;
      _layout.color = next.color ?? _layout.color;
      _layout.hidden = next.hidden ?? _layout.hidden;
      _layout.labels = next.labels ?? _layout.labels;
      _layout.title = next.title ?? _layout.title;
      if (next.parent != null) {
        _parent = next.parent;
        _parentElt = _parent && (_parent.elt || _parent);
      }
      _rebuildLayout();
      return ui;
    };
    _rebuildLayout();
    return ui;
  };
  
  /**
   * Pipes a source through one or more post-processing passes (filters), optionally displaying
   * the final output on the main canvas.
   *
   * By default, pipe allocates and caches internal ping/pong framebuffers (keyed) and lazily
   * resizes them to match the source. Advanced users may override ping/pong explicitly.
   *
   * Args may be provided in any order (source, pass(es), opt).
   *
   * Logical args:
   * - source: p5.Framebuffer|p5.Texture|p5.Image|p5.Graphics (if a p5.Framebuffer is provided, its .color is used)
   * - passes: a pass or array of passes (e.g. baseFilterShader().modify(...)); falsy entries ignored
   * - opt: options object
   *
   * @method pipe
   * @for p5
   * @param {...*} args Source, pass(es), and options in any order.
   * @param {boolean} [opt.display=true] If true, draw the final output to the main canvas.
   * @param {boolean} [opt.allocate=true] If true, allocate internal ping/pong when missing (cached per key).
   * @param {string} [opt.key='default'] Cache key for internal ping/pong (advanced; useful for multiple independent pipelines).
   * @param {p5.Framebuffer} [opt.ping] Optional user-provided ping framebuffer (advanced override; not cached internally).
   * @param {p5.Framebuffer} [opt.pong] Optional user-provided pong framebuffer (advanced override; not cached internally).
   * @param {boolean} [opt.clear=true] If true, clear each ping/pong pass target before drawing into it.
   * @param {boolean} [opt.clearDisplay=true] If true and opt.display is true, clear the main canvas before drawing final output.
   * @param {function} [opt.clearFn] Clear strategy for ping/pong passes. Defaults to () => this.background(0).
   * @param {function} [opt.clearDisplayFn] Clear strategy for display stage. Defaults to opt.clearFn.
   * @param {function} [opt.draw] Draw strategy used to place the current texture on the current render target. Defaults to full-canvas blit.
   * @returns {p5.Framebuffer|null} The final framebuffer used (ping or pong) when ping/pong are available; otherwise null.
   */
  fn.pipe = function (...args) {
    const p = this;
    let source;
    let passes = [];
    let opt = {};
    args.forEach(arg => {
      if (Array.isArray(arg) || arg instanceof p5.Shader) {
        passes = arg;
      } else if (arg && typeof arg === 'object') {
        const isFramebuffer = typeof p5.Framebuffer !== 'undefined' && arg instanceof p5.Framebuffer;
        const isGraphics = arg instanceof p5.Graphics;
        const isImage = arg instanceof p5.Image;
        const isTexture = typeof p5.Texture !== 'undefined' && arg instanceof p5.Texture;
        (isFramebuffer || isGraphics || isImage || isTexture) ? (source = arg) : (opt = arg);
      } else if (arg) {
        source = arg;
      }
    });
    const _rawPasses = Array.isArray(passes) ? passes : [passes];
    const _passes = (_rawPasses || []).filter(Boolean);
    const _opt = opt || {};
    const display = _opt.display ?? true;
    const allocate = _opt.allocate ?? true;
    const key = _opt.key ?? 'default';
    const clearPasses = _opt.clear ?? true;
    const clearDisplay = _opt.clearDisplay ?? true;
    const defaultClear = () => p.background(0);
    const clearFn = typeof _opt.clearFn === 'function' ? _opt.clearFn : defaultClear;
    const clearDisplayFn = typeof _opt.clearDisplayFn === 'function' ? _opt.clearDisplayFn : clearFn;
    const defaultDraw = (tex) => {
      p.imageMode(p.CORNER);
      p.image(tex, -p.width / 2, -p.height / 2, p.width, p.height);
    };
    const draw = typeof _opt.draw === 'function' ? _opt.draw : defaultDraw;
    const srcTex = source?.color ?? source;
    if (!_passes.length) {
      if (display && srcTex) {
        clearDisplay && clearDisplayFn();
        draw(srcTex);
      }
      return null;
    }
    const sizeFrom = (s) => {
      const w = s?.width ?? s?.color?.width ?? p.width;
      const h = s?.height ?? s?.color?.height ?? p.height;
      return [w, h];
    };
    const [w, h] = sizeFrom(source);
    const ensureSize = (fb) => {
      fb && (fb.width !== w || fb.height !== h) && fb.resize(w, h);
    };
    const applyPassClear = () => {
      clearPasses && clearFn();
    };
    const applyDisplayClear = () => {
      clearDisplay && clearDisplayFn();
    };
    const hasPing = Object.prototype.hasOwnProperty.call(_opt, 'ping');
    const hasPong = Object.prototype.hasOwnProperty.call(_opt, 'pong');
    p._tree ||= {};
    p._tree._pipe ||= {};
    p._tree._pipe[key] ||= {};
    const store = p._tree._pipe[key];
    let ping = hasPing ? _opt.ping : store.ping;
    let pong = hasPong ? _opt.pong : store.pong;
    if (allocate) {
      !ping && !hasPing && (ping = p.createFramebuffer());
      !pong && !hasPong && (pong = p.createFramebuffer());
      !hasPing && (store.ping = ping);
      !hasPong && (store.pong = pong);
    }
    if (ping && pong) {
      ensureSize(ping);
      ensureSize(pong);
    }
    if (!ping || !pong) {
      if (display && srcTex) {
        applyDisplayClear();
        draw(srcTex);
        p.filter(_passes[0]);
      }
      return null;
    }
    let readTex = srcTex;
    let out = null;
    for (let i = 0; i < _passes.length; i++) {
      const dst = (i % 2 === 0) ? ping : pong;
      dst.begin();
      applyPassClear();
      draw(readTex);
      p.filter(_passes[i]);
      dst.end();
      readTex = dst.color;
      out = dst;
    }
    if (display && readTex) {
      applyDisplayClear();
      draw(readTex);
    }
    return out;
  };
  
  /**
   * Release internal cached pipe framebuffers created by pipe() when opt.allocate is true.
   * Does NOT remove user-provided ping/pong passed via opt.ping/opt.pong.
   *
   * @method releasePipe
   * @for p5
   * @param {string|boolean} [key] If omitted, releases the default key ('default').
   *                              If a string, releases only that key.
   *                              If true, releases all keys.
   */
  fn.releasePipe = function (key) {
    const p = this;
    const store = p._tree?._pipe;
    if (!store) return;
    const releasePair = (pair) => {
      pair?.ping && pair.ping.remove();
      pair?.pong && pair.pong.remove();
    };
    if (key === true) {
      Object.keys(store).forEach(k => {
        releasePair(store[k]);
        delete store[k];
      });
      return;
    }
    const k = typeof key === 'string' ? key : 'default';
    releasePair(store[k]);
    delete store[k];
  };
});
