/**
 * @file Matrix queries, space transforms, and frustum scalar queries.
 * @module p5.tree/matrix
 * @license AGPL-3.0-only
 *
 * ── Two distinct contracts ─────────────────────────────────────────────────
 *
 * Matrix-fill methods (mat4Proj, mat4View, mat4PV, …):
 *   out-first, mandatory, zero-allocation.
 *   `out` is a caller-owned buffer (Float32Array | ArrayLike | p5.Matrix).
 *   The function writes into it and returns it.
 *
 * Space-query methods (mapLocation, mapDirection):
 *   point/dir is positional; everything else is in opts.
 *   opts.out is optional — if absent a fresh p5.Vector is allocated.
 *   Return type matches opts.out: Float32Array, ArrayLike, or p5.Vector.
 *   Hot paths pass opts.out = buf (zero-alloc); non-hot paths omit it.
 *
 * ── Viewport convention ───────────────────────────────────────────────────
 * The bridge always builds vp = [0, canvasH, canvasW, −canvasH].
 * Negative h encodes DOM/p5 screen-y-down. See query.js for full details.
 */

'use strict';

import {
  EYE, NDC, SCREEN, MATRIX, WEBGL, WEBGPU,
  mat4Mul, mat4Invert, mat3NormalFromMat4,
  mat4Location, mat3Direction,
  mapLocation as coreMapLocation,
  mapDirection as coreMapDirection,
  projIsOrtho, projNear, projFar, projFov, projHfov,
  projLeft, projRight, projTop, projBottom,
  pixelRatio as corePixelRatio,
} from '@nakednous/tree';

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

/** Detect NDC Z convention from renderer context. Called from postsetup. */
export function detectNDC(renderer) {
  _ndcZ = (renderer.drawingContext &&
           typeof WebGL2RenderingContext !== 'undefined' &&
           renderer.drawingContext instanceof WebGL2RenderingContext) ? WEBGL : WEBGPU;
}

export const getNdcZ = () => _ndcZ;

// ═══════════════════════════════════════════════════════════════════════════
// Raw p5 state access — direct Float32Array refs, no copies
// ═══════════════════════════════════════════════════════════════════════════

const _projMat4  = (r) => r.states.uPMatrix.mat4;
const _viewMat4  = (r) => r.states.curCamera.cameraMatrix.mat4;
const _modelMat4 = (r) => r.states.uModelMatrix.mat4;

// ═══════════════════════════════════════════════════════════════════════════
// Install
// ═══════════════════════════════════════════════════════════════════════════

export function installMatrix(p5, fn) {

  // True for Float32Array, plain Array, or p5.Vector — the three accepted
  // point/direction types. Plain opts objects do not match.
  const _isVec = (v) => v != null &&
    (Array.isArray(v) || ArrayBuffer.isView(v) || v instanceof p5.Vector);

  // Resolve opts.out for mapLocation / mapDirection.
  // Returns opts.out if provided, otherwise allocates a fresh p5.Vector.
  const _resolveOut = (opts) => opts?.out ?? new p5.Vector();

  // ── p5.Matrix utility ─────────────────────────────────────────────────────

  fn.createMatrix = (...args) => new p5.Matrix(...args);

  // ── Simple matrix queries ─────────────────────────────────────────────────
  //   out: Float32Array | ArrayLike | p5.Matrix — 16-element destination.

  /** Projection matrix (eye → clip). */
  p5.Renderer3D.prototype.mat4Proj = function (out) {
    const buf = _rawMat4(out), s = _projMat4(this);
    for (let i = 0; i < 16; i++) buf[i] = s[i];
    return out;
  };
  fn.mat4Proj = function (out) { return this._renderer.mat4Proj(out); };

  /** Model matrix (local → world). */
  p5.Renderer3D.prototype.mat4Model = function (out) {
    const buf = _rawMat4(out), s = _modelMat4(this);
    for (let i = 0; i < 16; i++) buf[i] = s[i];
    return out;
  };
  fn.mat4Model = function (out) { return this._renderer.mat4Model(out); };

  /** View matrix (world → eye). */
  p5.Camera.prototype.mat4View = function (out) {
    const buf = _rawMat4(out), s = this.cameraMatrix.mat4;
    for (let i = 0; i < 16; i++) buf[i] = s[i];
    return out;
  };
  p5.Renderer3D.prototype.mat4View = function (out) { return this.states.curCamera.mat4View(out); };
  fn.mat4View = function (out) { return this._renderer.mat4View(out); };

  /** Eye matrix (eye → world, i.e. inverse view). Returns null if singular. */
  p5.Camera.prototype.mat4Eye = function (out) {
    const buf = _rawMat4(out);
    return mat4Invert(buf, this.cameraMatrix.mat4) === null ? null : out;
  };
  p5.Renderer3D.prototype.mat4Eye = function (out) { return this.states.curCamera.mat4Eye(out); };
  fn.mat4Eye = function (out) { return this._renderer.mat4Eye(out); };

  // ── Composite matrix queries ──────────────────────────────────────────────
  //   opts may supply precomputed matrices to skip redundant multiplications.

  /**
   * Projection-view matrix: P · V.
   * @param {Float32Array|ArrayLike|p5.Matrix} out
   * @param {{ mat4Proj?, mat4View? }} [opts]
   */
  p5.Renderer3D.prototype.mat4PV = function (out, { mat4Proj, mat4View } = {}) {
    mat4Mul(_rawMat4(out), _rawMat4(mat4Proj) ?? _projMat4(this), _rawMat4(mat4View) ?? _viewMat4(this));
    return out;
  };
  fn.mat4PV = function (out, opts) { return this._renderer.mat4PV(out, opts); };

  /**
   * Inverse projection-view matrix: inv(P · V).
   * Pass mat4PV to skip recomputing P · V. Returns null if singular.
   * @param {Float32Array|ArrayLike|p5.Matrix} out
   * @param {{ mat4Proj?, mat4View?, mat4PV? }} [opts]
   */
  p5.Renderer3D.prototype.mat4PVInv = function (out, { mat4Proj, mat4View, mat4PV } = {}) {
    const pv = _rawMat4(mat4PV) ??
      (mat4Mul(_pv, _rawMat4(mat4Proj) ?? _projMat4(this), _rawMat4(mat4View) ?? _viewMat4(this)), _pv);
    return mat4Invert(_rawMat4(out), pv) === null ? null : out;
  };
  fn.mat4PVInv = function (out, opts) { return this._renderer.mat4PVInv(out, opts); };

  /**
   * Model-view matrix: V · M.
   * @param {Float32Array|ArrayLike|p5.Matrix} out
   * @param {{ mat4Model?, mat4View? }} [opts]
   */
  p5.Renderer3D.prototype.mat4MV = function (out, { mat4Model, mat4View } = {}) {
    mat4Mul(_rawMat4(out), _rawMat4(mat4View) ?? _viewMat4(this), _rawMat4(mat4Model) ?? _modelMat4(this));
    return out;
  };
  fn.mat4MV = function (out, opts) { return this._renderer.mat4MV(out, opts); };

  /**
   * Projection-model-view matrix: P · V · M.
   * @param {Float32Array|ArrayLike|p5.Matrix} out
   * @param {{ mat4Proj?, mat4Model?, mat4View? }} [opts]
   */
  p5.Renderer3D.prototype.mat4PMV = function (out, { mat4Proj, mat4Model, mat4View } = {}) {
    mat4Mul(_wa, _rawMat4(mat4View) ?? _viewMat4(this), _rawMat4(mat4Model) ?? _modelMat4(this));
    mat4Mul(_rawMat4(out), _rawMat4(mat4Proj) ?? _projMat4(this), _wa);
    return out;
  };
  fn.mat4PMV = function (out, opts) { return this._renderer.mat4PMV(out, opts); };

  /**
   * Normal matrix: inverseTranspose(upper 3×3 of V · M).
   * Pass mat4MV to skip recomputing V · M.
   * @param {Float32Array|ArrayLike|p5.Matrix} out  9-element destination.
   * @param {{ mat4Model?, mat4View?, mat4MV? }} [opts]
   */
  p5.Renderer3D.prototype.mat3Normal = function (out, { mat4Model, mat4View, mat4MV } = {}) {
    const mv = _rawMat4(mat4MV) ??
      (mat4Mul(_wa, _rawMat4(mat4View) ?? _viewMat4(this), _rawMat4(mat4Model) ?? _modelMat4(this)), _wa);
    mat3NormalFromMat4(_rawMat3(out), mv);
    return out;
  };
  fn.mat3Normal = function (out, opts) { return this._renderer.mat3Normal(out, opts); };

  /**
   * Location transform between frames: out = inv(to) · from.
   * Returns null if `to` is singular.
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @param {Float32Array|ArrayLike|p5.Matrix} from
   * @param {Float32Array|ArrayLike|p5.Matrix} to
   */
  p5.Renderer3D.prototype.mat4Location = function (out, from, to) {
    return mat4Location(_rawMat4(out), _rawMat4(from), _rawMat4(to)) === null ? null : out;
  };
  fn.mat4Location = function (out, from, to) { return this._renderer.mat4Location(out, from, to); };

  /**
   * Direction transform between frames: out = to₃ · inv(from₃).
   * Returns null if `from` is singular.
   * @param {Float32Array|ArrayLike|p5.Matrix} out  9-element destination.
   * @param {Float32Array|ArrayLike|p5.Matrix} from
   * @param {Float32Array|ArrayLike|p5.Matrix} to
   */
  p5.Renderer3D.prototype.mat3Direction = function (out, from, to) {
    return mat3Direction(_rawMat3(out), _rawMat4(from), _rawMat4(to)) === null ? null : out;
  };
  fn.mat3Direction = function (out, from, to) { return this._renderer.mat3Direction(out, from, to); };

  // ── Raw math forwarders ───────────────────────────────────────────────────
  //   For sketches that need custom matrix arithmetic (e.g. bias·lightPV for
  //   shadow mapping) without importing @nakednous/tree directly.

  /** out = A · B  (column-major) */
  p5.Renderer3D.prototype.mat4Mul = function (out, A, B) {
    mat4Mul(_rawMat4(out), _rawMat4(A), _rawMat4(B));
    return out;
  };
  fn.mat4Mul = function (out, A, B) { return this._renderer.mat4Mul(out, A, B); };

  /** out = inv(src). Returns null if singular. */
  p5.Renderer3D.prototype.mat4Invert = function (out, src) {
    return mat4Invert(_rawMat4(out), _rawMat4(src)) === null ? null : out;
  };
  fn.mat4Invert = function (out, src) { return this._renderer.mat4Invert(out, src); };

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

  fn.projIsOrtho = function () { return this._renderer.projIsOrtho(); };
  fn.projNear    = function () { return this._renderer.projNear();    };
  fn.projFar     = function () { return this._renderer.projFar();     };
  fn.projLeft    = function () { return this._renderer.projLeft();    };
  fn.projRight   = function () { return this._renderer.projRight();   };
  fn.projTop     = function () { return this._renderer.projTop();     };
  fn.projBottom  = function () { return this._renderer.projBottom();  };
  fn.projFov     = function () { return this._renderer.projFov();     };
  fn.projHfov    = function () { return this._renderer.projHfov();    };

  // ── _buildBag ─────────────────────────────────────────────────────────────
  //   Builds the matrices bag for coreMapLocation / coreMapDirection.
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
   * Map a point between coordinate spaces.
   *
   * Hot path (zero-alloc):  pass `opts.out` as a caller-owned buffer.
   * Ergonomic path:         omit `opts.out`; a fresh p5.Vector is returned.
   *
   * @param {Float32Array|number[]|p5.Vector} [point]  Input point. Default: ORIGIN.
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
   * @returns {Float32Array|number[]|p5.Vector}  opts.out if provided, else a fresh p5.Vector.
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
    coreMapLocation(buf, px, py, pz, fromStr, toStr, bag, _vp, _ndcZ);
    if (isVecOut) { out.x = buf[0]; out.y = buf[1]; out.z = buf[2]; }
    return out;
  };

  // ── mapDirection ──────────────────────────────────────────────────────────

  fn.mapDirection = function (...args) { return this._renderer.mapDirection(...args); };

  /**
   * Map a direction between coordinate spaces.
   *
   * Hot path (zero-alloc):  pass `opts.out` as a caller-owned buffer.
   * Ergonomic path:         omit `opts.out`; a fresh p5.Vector is returned.
   *
   * @param {Float32Array|number[]|p5.Vector} [dir]  Input direction. Default: −Z (look direction).
   * @param {{
   *   out?:      Float32Array | number[] | p5.Vector,
   *   from?:     string | Float32Array | number[] | p5.Matrix,
   *   to?:       string | Float32Array | number[] | p5.Matrix,
   *   mat4Eye?:  Float32Array | number[] | p5.Matrix,
   *   mat4Proj?: Float32Array | number[] | p5.Matrix,
   *   mat4View?: Float32Array | number[] | p5.Matrix,
   * }} [opts]
   * @returns {Float32Array|number[]|p5.Vector}  opts.out if provided, else a fresh p5.Vector.
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
    coreMapDirection(buf, dx, dy, dz, fromStr, toStr, bag, _vp, _ndcZ);
    if (isVecOut) { out.x = buf[0]; out.y = buf[1]; out.z = buf[2]; }
    return out;
  };

  // ── pixelRatio ────────────────────────────────────────────────────────────

  /**
   * World-units-per-pixel at a world position (defaults to camera position).
   * @param {Float32Array|number[]|p5.Vector} [worldPos]
   * @param {{ mat4Proj?, mat4View? }} [opts]
   * @returns {number}
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

  // ── screenSize ────────────────────────────────────────────────────────────

  /**
   * Physical canvas size in pixels: [pixelDensity×width, pixelDensity×height].
   * Use as `u_resolution` for shaders that use `gl_FragCoord.xy`.
   * @returns {number[]} [w, h]
   */
  p5.Renderer3D.prototype.screenSize = function () {
    const pd = this._pInst.pixelDensity();
    return [pd * this.width, pd * this.height];
  };
  fn.screenSize = function () { return this._renderer.screenSize(); };

  // ── texelSize ─────────────────────────────────────────────────────────────

  /**
   * Texel size of an image-like object: [1/width, 1/height].
   * Accepts p5.Image, p5.Framebuffer, p5.Graphics, or any `{ width, height }`.
   * @param {{ width:number, height:number }} img
   * @returns {number[]} [1/w, 1/h]
   */
  fn.texelSize = function (img) { return [1/img.width, 1/img.height]; };
}
