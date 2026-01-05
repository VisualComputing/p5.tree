/**
 * @file Adds Tree rendering functions to the p5 prototype.
 * @version 0.0.1
 * @author JP Charalambos
 * @license GPL-3.0-only
 *
 * @description
 * A p5.js WEBGL addon for shader development and space transformations.
 * 
 * Camera path recording/playback section.
 *
 * Requires WEBGL (p5.Camera).
 *
 * Camera API (kept as requested):
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

'use strict';

import p5 from 'p5';

p5.registerAddon((p5, fn, lifecycles) => {
  // --- namespace (module shelf) ---
  p5.Tree ||= {};

  Object.defineProperty(p5.Tree, 'VERSION', {
    value: '0.0.1',
    writable: false,
    enumerable: true,
    configurable: false
  });
  
  // ---------------------------------------------------------------------------
  // Matrix queries (p5.treegl -> p5.tree, p5-v2)
  // Rely on p5-v2, minimal safeties, cache-friendly.
  // ---------------------------------------------------------------------------

  /**
   * @private
   * Returns the WEBGL renderer or undefined.
   * @param {p5} pInst
   * @returns {p5.RendererGL|undefined}
   */
  const _rendererGL = function (pInst) {
    const r = pInst._renderer;
    return r instanceof p5.RendererGL ? r : undefined;
  };

  // ---------------------------------------------------------------------------
  // p5.Matrix * vector helpers
  // ---------------------------------------------------------------------------

  /**
   * Multiply a direction vector by a mat3.
   * @param {p5.Vector} v
   * @returns {p5.Vector}
   */
  p5.Matrix.prototype.mult3 = function (v) {
    const m = this.mat3;
    return new p5.Vector(
      m[0] * v.x + m[3] * v.y + m[6] * v.z,
      m[1] * v.x + m[4] * v.y + m[7] * v.z,
      m[2] * v.x + m[5] * v.y + m[8] * v.z
    );
  };

  /**
   * Multiply a point (w=1) by a mat4.
   * p5-v2 canonical implementation.
   * @param {p5.Vector} v
   * @returns {p5.Vector}
   */
  p5.Matrix.prototype.mult4 = function (v) {
    return this.multiplyPoint(v);
  };

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
   * Creates a new identity matrix of size n.
   * (Wrapper for `new p5.Matrix(n)`.)
   * @param {number} [n=4] Matrix size (typically 4).
   * @returns {p5.Matrix}
   */
  fn.createMatrix = function (n = 4) {
    return new p5.Matrix(n);
  };

  // ---------------------------------------------------------------------------
  // Matrix queries (immutable, cache-friendly)
  // ---------------------------------------------------------------------------

  /**
   * Returns the current projection matrix (immutable copy).
   * @returns {p5.Matrix}
   */
  p5.RendererGL.prototype.pMatrix = function () {
    return this.states.uPMatrix.clone();
  };

  /**
   * Returns the current projection matrix (immutable copy).
   * Requires WEBGL.
   * @returns {p5.Matrix}
   */
  fn.pMatrix = function () {
    return _rendererGL(this).pMatrix();
  };

  /**
   * Returns the current model matrix (immutable copy).
   * @returns {p5.Matrix}
   */
  p5.RendererGL.prototype.mMatrix = function () {
    return this.states.uModelMatrix.clone();
  };

  /**
   * Returns the current model matrix (immutable copy).
   * Requires WEBGL.
   * @returns {p5.Matrix}
   */
  fn.mMatrix = function () {
    return _rendererGL(this).mMatrix();
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
   * Returns the current view matrix (world -> camera) (immutable copy).
   * Prefers the renderer cached view matrix when available.
   * @returns {p5.Matrix}
   */
  p5.RendererGL.prototype.vMatrix = function () {
    return (this.states.uViewMatrix || this.states.curCamera.cameraMatrix).clone();
  };

  /**
   * Returns the current view matrix (world -> camera) (immutable copy).
   * Requires WEBGL.
   * @returns {p5.Matrix}
   */
  fn.vMatrix = function () {
    return _rendererGL(this).vMatrix();
  };

  /**
   * Returns the current eye matrix (camera -> world) (immutable).
   * @returns {p5.Matrix}
   */
  p5.RendererGL.prototype.eMatrix = function () {
    return _invert(this.states.uViewMatrix || this.states.curCamera.cameraMatrix);
  };

  /**
   * Returns the current eye matrix (camera -> world) (immutable).
   * Requires WEBGL.
   * @returns {p5.Matrix}
   */
  fn.eMatrix = function () {
    return _rendererGL(this).eMatrix();
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
  p5.RendererGL.prototype.lMatrix = function ({
    from = new p5.Matrix(4),
    to = this.eMatrix()
  } = {}) {
    return _invert(to).mult(from);
  };

  /**
   * lMatrix({ from, to }):
   * Location transform (mat4) mapping points from `from` space to `to` space.
   * Requires WEBGL.
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.from]
   * @param {p5.Matrix} [opts.to]
   * @returns {p5.Matrix}
   */
  fn.lMatrix = function (opts = {}) {
    return _rendererGL(this).lMatrix(opts);
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
  p5.RendererGL.prototype.dMatrix = function ({
    from = new p5.Matrix(4),
    to = this.eMatrix(),
    matrix
  } = {}) {
    return (matrix || _invert(from).mult(to)).createSubMatrix3x3();
  };

  /**
   * dMatrix({ from, to, matrix }):
   * Direction transform (mat3) mapping vectors from `from` space to `to` space.
   * Requires WEBGL.
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.from]
   * @param {p5.Matrix} [opts.to]
   * @param {p5.Matrix} [opts.matrix]
   * @returns {p5.Matrix} mat3
   */
  fn.dMatrix = function (opts = {}) {
    return _rendererGL(this).dMatrix(opts);
  };

  /**
   * mvMatrix({ vMatrix, mMatrix }):
   * ModelView matrix (mat4) = M * V (p5-v2 convention).
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.vMatrix=this.vMatrix()] View matrix.
   * @param {p5.Matrix} [opts.mMatrix=this.mMatrix()] Model matrix.
   * @returns {p5.Matrix}
   */
  p5.RendererGL.prototype.mvMatrix = function ({
    vMatrix = this.vMatrix(),
    mMatrix
  } = {}) {
    return (mMatrix || this.states.uModelMatrix).clone().mult(vMatrix);
  };

  /**
   * mvMatrix({ vMatrix, mMatrix }):
   * ModelView matrix (mat4) = M * V (p5-v2 convention).
   * Requires WEBGL.
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.vMatrix]
   * @param {p5.Matrix} [opts.mMatrix]
   * @returns {p5.Matrix}
   */
  fn.mvMatrix = function (opts = {}) {
    return _rendererGL(this).mvMatrix(opts);
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
  p5.RendererGL.prototype.nMatrix = function ({
    vMatrix,
    mMatrix,
    mvMatrix = this.mvMatrix({ mMatrix, vMatrix })
  } = {}) {
    return _transpose(_invert(mvMatrix.createSubMatrix3x3()));
  };

  /**
   * nMatrix({ vMatrix, mMatrix, mvMatrix }):
   * Normal matrix (mat3) = inverseTranspose(linear_part(MV)).
   * Requires WEBGL.
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.vMatrix]
   * @param {p5.Matrix} [opts.mMatrix]
   * @param {p5.Matrix} [opts.mvMatrix]
   * @returns {p5.Matrix} mat3
   */
  fn.nMatrix = function (opts = {}) {
    return _rendererGL(this).nMatrix(opts);
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
  p5.RendererGL.prototype.pmvMatrix = function ({
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
   * Requires WEBGL.
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.pMatrix]
   * @param {p5.Matrix} [opts.vMatrix]
   * @param {p5.Matrix} [opts.mMatrix]
   * @param {p5.Matrix} [opts.mvMatrix]
   * @returns {p5.Matrix}
   */
  fn.pmvMatrix = function (opts = {}) {
    return _rendererGL(this).pmvMatrix(opts);
  };

  /**
   * pvMatrix({ pMatrix, vMatrix }):
   * PV (mat4) = V * P (p5-v2 convention).
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.pMatrix=this.pMatrix()] Projection matrix.
   * @param {p5.Matrix} [opts.vMatrix=this.vMatrix()] View matrix.
   * @returns {p5.Matrix}
   */
  p5.RendererGL.prototype.pvMatrix = function ({
    pMatrix = this.pMatrix(),
    vMatrix
  } = {}) {
    return (vMatrix || (this.states.uViewMatrix || this.states.curCamera.cameraMatrix)).clone().mult(pMatrix);
  };

  /**
   * pvMatrix({ pMatrix, vMatrix }):
   * PV (mat4) = V * P (p5-v2 convention).
   * Requires WEBGL.
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.pMatrix]
   * @param {p5.Matrix} [opts.vMatrix]
   * @returns {p5.Matrix}
   */
  fn.pvMatrix = function (opts = {}) {
    return _rendererGL(this).pvMatrix(opts);
  };
  
  /**
   * pviMatrix({ pMatrix, vMatrix, pvMatrix }):
   * Inverse(PV) (mat4).
   * @param {object} [opts]
   * @param {p5.Matrix} [opts.pMatrix] Optional projection matrix (used if pvMatrix is computed).
   * @param {p5.Matrix} [opts.vMatrix] Optional view matrix (used if pvMatrix is computed).
   * @param {p5.Matrix} [opts.pvMatrix=this.pvMatrix({ pMatrix, vMatrix })] Optional PV matrix override.
   * @returns {p5.Matrix}
   */
  p5.RendererGL.prototype.pviMatrix = function ({
    pMatrix,
    vMatrix,
    pvMatrix = this.pvMatrix({ pMatrix, vMatrix })
  } = {}) {
    return _invert(pvMatrix);
  };
  
  /**
   * pviMatrix({ pMatrix, vMatrix, pvMatrix }):
   * Inverse(PV) (mat4). Requires WEBGL.
   * @param {object} [opts]
   * @returns {p5.Matrix}
   */
  fn.pviMatrix = function (opts = {}) {
    return _rendererGL(this).pviMatrix(opts);
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
  p5.RendererGL.prototype.isOrtho = function () {
    return this.pMatrix().isOrtho();
  };

  /**
   * Returns true if the current projection is orthographic.
   * Requires WEBGL.
   * @returns {boolean}
   */
  fn.isOrtho = function () {
    return _rendererGL(this).isOrtho();
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
  p5.RendererGL.prototype.nPlane = function () {
    return this.pMatrix().nPlane();
  };

  /**
   * Far plane distance for the current projection.
   * @returns {number}
   */
  p5.RendererGL.prototype.fPlane = function () {
    return this.pMatrix().fPlane();
  };

  /**
   * Left plane for the current projection.
   * @returns {number}
   */
  p5.RendererGL.prototype.lPlane = function () {
    return this.pMatrix().lPlane();
  };

  /**
   * Right plane for the current projection.
   * @returns {number}
   */
  p5.RendererGL.prototype.rPlane = function () {
    return this.pMatrix().rPlane();
  };

  /**
   * Top plane for the current projection.
   * @returns {number}
   */
  p5.RendererGL.prototype.tPlane = function () {
    return this.pMatrix().tPlane();
  };

  /**
   * Bottom plane for the current projection.
   * @returns {number}
   */
  p5.RendererGL.prototype.bPlane = function () {
    return this.pMatrix().bPlane();
  };

  /**
   * Near plane distance for the current projection.
   * Requires WEBGL.
   * @returns {number}
   */
  fn.nPlane = function () {
    return _rendererGL(this).nPlane();
  };

  /**
   * Far plane distance for the current projection.
   * Requires WEBGL.
   * @returns {number}
   */
  fn.fPlane = function () {
    return _rendererGL(this).fPlane();
  };

  /**
   * Left plane for the current projection.
   * Requires WEBGL.
   * @returns {number}
   */
  fn.lPlane = function () {
    return _rendererGL(this).lPlane();
  };

  /**
   * Right plane for the current projection.
   * Requires WEBGL.
   * @returns {number}
   */
  fn.rPlane = function () {
    return _rendererGL(this).rPlane();
  };

  /**
   * Top plane for the current projection.
   * Requires WEBGL.
   * @returns {number}
   */
  fn.tPlane = function () {
    return _rendererGL(this).tPlane();
  };

  /**
   * Bottom plane for the current projection.
   * Requires WEBGL.
   * @returns {number}
   */
  fn.bPlane = function () {
    return _rendererGL(this).bPlane();
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
  p5.RendererGL.prototype.fov = function () {
    return this.pMatrix().fov();
  };

  /**
   * Horizontal field of view (radians) of the current projection.
   * @returns {number|undefined}
   */
  p5.RendererGL.prototype.hfov = function () {
    return this.pMatrix().hfov();
  };

  /**
   * Vertical field of view (radians) of the current projection.
   * Requires WEBGL.
   * @returns {number|undefined}
   */
  fn.fov = function () {
    return _rendererGL(this).fov();
  };

  /**
   * Horizontal field of view (radians) of the current projection.
   * Requires WEBGL.
   * @returns {number|undefined}
   */
  fn.hfov = function () {
    return _rendererGL(this).hfov();
  };

  // --- private keys (shared internal state across protos) ---
  const STATE_KEY = Symbol.for('tree.camera.path.state');
  const PLAYERS_KEY = Symbol.for('tree.camera.path.players');

  const clamp01 = function (x) {
    return x < 0 ? 0 : (x > 1 ? 1 : x);
  };

  const isFiniteNumber = function (x) {
    return typeof x === 'number' && Number.isFinite(x);
  };

  // Keyframe equality helper (used to avoid consecutive identical snapshots).
  // Prefer matrix comparisons (cameraMatrix / projMatrix). Fallback to scalar camera params if needed.
  const sameKeyframe = function (a, b) {
    if (!a || !b) return false;
    const aCM = a.cameraMatrix && a.cameraMatrix.mat4;
    const bCM = b.cameraMatrix && b.cameraMatrix.mat4;
    if (aCM && bCM) {
      for (let i = 0; i < 16; i++) if (aCM[i] !== bCM[i]) return false;
    } else {
      if (a.eyeX !== b.eyeX || a.eyeY !== b.eyeY || a.eyeZ !== b.eyeZ) return false;
      if (a.centerX !== b.centerX || a.centerY !== b.centerY || a.centerZ !== b.centerZ) return false;
      if (a.upX !== b.upX || a.upY !== b.upY || a.upZ !== b.upZ) return false;
    }
    const aPM = a.projMatrix && a.projMatrix.mat4;
    const bPM = b.projMatrix && b.projMatrix.mat4;
    if (aPM && bPM) {
      for (let i = 0; i < 16; i++) if (aPM[i] !== bPM[i]) return false;
    }
    return true;
  };

  const warn = function (msg) {
    console.warn('[tree.camera.path] ' + msg);
  };

  const ensurePath = function (cam) {
    cam.path || (cam.path = []);
    return cam.path;
  };

  const segmentCount = function (path) {
    return Math.max(0, path.length - 1);
  };

  const getState = function (cam) {
    cam[STATE_KEY] || (cam[STATE_KEY] = {
      playing: false,
      loop: false,
      pingPong: false,
      onEnd: undefined,
      rate: 1,
      duration: 30, // frames per segment
      seg: 0,
      f: 0,
      projSig: undefined
    });
    return cam[STATE_KEY];
  };

  const getPlayers = function (pInst) {
    pInst[PLAYERS_KEY] || (pInst[PLAYERS_KEY] = new Set());
    return pInst[PLAYERS_KEY];
  };
  
  const getActiveCamera = function (pInst) {
    const r = pInst && pInst._renderer;
    return (
      (r && r.states && r.states.curCamera) || // p5-v2 canonical
      (r && (r._curCamera || r.curCamera || r._camera)) || // fallbacks
      undefined
    );
  };

  /**
   * Build a stable projection signature from camera.projMatrix.mat4.
   * Returns undefined if unavailable (in which case we warn and do not reject).
   */
  const projSig = function (cam) {
    const pm = cam && cam.projMatrix;
    const m = pm && pm.mat4;
    if (!m || m.length !== 16) return undefined;
    let s = '';
    for (let i = 0; i < 16; i++) {
      const v = Math.round(m[i] * 1e6) / 1e6;
      s += (i ? ',' : '') + v;
    }
    return s;
  };

  /**
   * Interpolate camera pose at normalized global t in [0..1] along the whole path.
   * Also updates internal seg/f so playPath resumes from that location.
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

  // -----------------------
  // v2 addon lifecycle hook
  // -----------------------

  lifecycles.predraw = function () {
    const players = getPlayers(this);
    players.forEach(cam => {
      tick(cam);
      getState(cam).playing || players.delete(cam);
    });
  };

  lifecycles.remove = function () {
    const players = this[PLAYERS_KEY];
    players && players.clear();
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
   *   camera.addPath([camA, camB, ...], opts);         // bulk add
   *
   *   camera.addPath(eye, center, up, opts);           // eye/center/up: p5.Vector or [x, y, z]
   *
   *   camera.addPath(view, opts);                      // view: p5.Matrix (4x4) or mat4[16]
   *                                                   // (world -> camera), like p5.Camera.cameraMatrix
   *
   * Options:
   *   - clear: boolean (default false) Clears the current path before adding.
   *
   * Notes:
   * - Keyframes are stored as camera snapshots (p5.Camera.copy()) so Camera.slerp() works.
   * - Projection compatibility is enforced (Camera.slerp requires same projection).
   */
  p5.Camera.prototype.addPath = function (...args) {
    const st = getState(this);
    const path = ensurePath(this);
    const isPlainObject = v => {
      if (!v || typeof v !== 'object') return false;
      if (Array.isArray(v)) return false;
      if (ArrayBuffer.isView(v)) return false;
      const proto = Object.getPrototypeOf(v);
      return proto === Object.prototype || proto === null;
    };
    const isVec3 = v =>
      v instanceof p5.Vector ||
      (Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n)));
    const toVec3 = v => v instanceof p5.Vector ? [v.x, v.y, v.z] : [v[0], v[1], v[2]];
    const addSnapshot = c => {
      const last = path.length ? path[path.length - 1] : undefined;
      last && sameKeyframe(last, c) || path.push(c.copy());
    };
    const initProjBaseline = () => {
      const sig = projSig(this);
      st.projSig || (st.projSig = sig);
    };
    const checkProjCompat = c => {
      const sig = projSig(c);
      if (st.projSig && sig && sig !== st.projSig) {
        warn('addPath rejected: camera has different projection; Camera.slerp requires same projection.');
        return false;
      }
      if (!st.projSig && sig) {
        st.projSig = sig;
      } else if (!st.projSig && !sig) {
        warn('addPath: unable to verify projection compatibility (projMatrix.mat4 unavailable).');
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
    if (o.clear) {
      path.length = 0;
      st.seg = 0;
      st.f = 0;
      st.projSig = undefined;
    }
    initProjBaseline();
    // addPath() -> snapshot this
    if (args.length === 0) {
      const last = path.length ? path[path.length - 1] : undefined;
      last && sameKeyframe(last, this) || path.push(this.copy());
      return this;
    }
    // addPath(view) OR addPath(camera) OR addPath([cameras])
    if (args.length === 1) {
      const override = args[0];
      if (isView(override)) {
        const c = importViewToCamera(override);
        checkProjCompat(c) && addSnapshot(c);
        return this;
      }
      const cams = Array.isArray(override) ? override : [override];
      for (let i = 0; i < cams.length; i++) {
        const c = cams[i];
        if (!(c instanceof p5.Camera)) {
          warn('addPath: ignored non-camera value.');
          continue;
        }
        checkProjCompat(c) && addSnapshot(c);
      }
      return this;
    }
    // addPath(eye, center, up)
    if (args.length === 3 && isVec3(args[0]) && isVec3(args[1]) && isVec3(args[2])) {
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
   * duration: frames per segment (default 30).
   * loop: wraps at ends (default false).
   * pingPong: bounces at ends (default false).
   * onEnd: called when playback naturally ends (non-looping, non-pingpong).
   * rate: speed multiplier (fractional supported); negative plays reverse; rate=0 stops.
   *
   * If both pingPong and loop are true, pingPong takes precedence.
   */
  p5.Camera.prototype.playPath = function (rateOrOpts) {
    const st = getState(this);
    const path = ensurePath(this);
    const nSeg = segmentCount(path);
    if (nSeg === 0) {
      warn('playPath ignored: need at least 2 keyframes in camera.path.');
      st.playing = false;
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
    if (st.rate === 0) {
      st.playing = false;
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
    const pInst = this._renderer && this._renderer._pInst;
    pInst && getPlayers(pInst).add(this);
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
      st.projSig = undefined;
      return this;
    }
    const nInt = n | 0;
    const keep = Math.max(0, Math.abs(nInt));
    if (keep === 0) {
      path.length = 0;
      st.projSig = undefined;
      return this;
    }
    if (nInt >= 0) {
      path.length = Math.min(path.length, keep);
    } else if (path.length > keep) {
      path.splice(0, path.length - keep);
    }
    if (segmentCount(path) === 0) {
      st.projSig = undefined;
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

  // ------------------------------------------------------------
  // p5 wrappers (same names, forward to active camera)
  // ------------------------------------------------------------

  fn.addPath = function (...args) {
    const cam = getActiveCamera(this);
    cam && cam.addPath(...args);
    return this;
  };

  fn.playPath = function (...args) {
    const cam = getActiveCamera(this);
    cam && cam.playPath(...args);
    return this;
  };
  
  fn.seekPath = function (...args) {
    const cam = getActiveCamera(this);
    cam && cam.seekPath(...args);
    return this;
  };
  
  fn.resetPath = function (...args) {
    const cam = getActiveCamera(this);
    cam && cam.resetPath(...args);
    return this;
  };
  
  fn.stopPath = function (...args) {
    const cam = getActiveCamera(this);
    cam && cam.stopPath(...args);
    return this;
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
    
  p5.RendererGL.prototype.beginHUD = function () {
    if (this._hudActive === true) return;
    const p = this._pInst;
    const gl = this.drawingContext;
    const states = this.states;
    if (p === undefined || gl === undefined || states === undefined) return;
    p.push(); // calls: this._rendererState = this.push();
    p.resetShader();
    // --- HUD setup ---
    this._hudPrevCam = states.curCamera;
    this._hudDepthWasEnabled = gl.isEnabled(gl.DEPTH_TEST);
    gl.flush();
    gl.disable(gl.DEPTH_TEST);
    if (this._hudCam === undefined) this._hudCam = p.createCamera();
    const z = 1e6;
    this._hudCam.ortho(-p.width / 2, p.width / 2, -p.height / 2, p.height / 2, -z, z);
    this._hudCam.camera(0, 0, 1, 0, 0, 0, 0, 1, 0);
    p.setCamera(this._hudCam);
    this._hudActive = true;
  };
  
  p5.RendererGL.prototype.endHUD = function () {
    if (this._hudActive !== true) return;
    const p = this._pInst;
    const gl = this.drawingContext;
    const states = this.states;
    if (p === undefined || gl === undefined || states === undefined) return;
    gl.flush();
    this._hudDepthWasEnabled ? gl.enable(gl.DEPTH_TEST) : gl.disable(gl.DEPTH_TEST);
    p.pop(); // calls: this.pop(this._rendererState);
    this._hudPrevCam !== undefined && p.setCamera(this._hudPrevCam);
    this._hudPrevCam = undefined;
    this._hudDepthWasEnabled = undefined;
    this._hudActive = false;
  };
});
