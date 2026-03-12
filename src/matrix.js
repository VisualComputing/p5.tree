/**
 * @file Matrix queries, space transforms, and HUD — p5 bridge layer.
 * @module p5.tree/matrix
 * @license GPL-3.0-only
 *
 * Thin bridge: reads raw Float32Array refs from p5 renderer state and feeds
 * them directly into @nakednous/tree core functions.
 *
 * All matrix queries follow the same contract as @nakednous/tree:
 *   - `out` is the first parameter — caller owns the buffer
 *   - the function returns `out` (or null on a singular matrix)
 *   - no heap allocations; all intermediates use module-level working buffers
 *
 * ── Unified input types ───────────────────────────────────────────────────
 *
 *   Matrix params (16-elem): Float32Array | ArrayLike | p5.Matrix
 *     Internally normalised via _rawMat4(m) = m.mat4 ?? m — zero alloc.
 *
 *   Matrix params (9-elem):  Float32Array | ArrayLike | p5.Matrix(.mat3)
 *     Internally normalised via _rawMat3(m) = m.mat3 ?? m — zero alloc.
 *
 *   Vector params (3-elem):  Float32Array | ArrayLike | p5.Vector
 *     Input:  read via v.x ?? v[0] ?? 0 inline — zero alloc.
 *     Output: if p5.Vector, core writes into _tmp3 scratch then x/y/z are
 *             copied back; all other types receive the result directly.
 *
 * ── Pattern ───────────────────────────────────────────────────────────────
 *
 *   // setup — allocate once
 *   const e   = new Float32Array(16)
 *   const pm  = new Float32Array(16)
 *   const pv  = new Float32Array(16)
 *   const loc = new Float32Array(3)
 *
 *   // draw — zero allocations
 *   p.eMatrix(e)
 *   p.pMatrix(pm)
 *   p.pvMatrix(pv)
 *   p.viewFrustum({ eMatrix: e, pMatrix: pm })
 *   p.mousePicking({ pvMatrix: pv, eMatrix: e })
 *   p.mapLocation(loc, [0,0,0], { from: p5.Tree.EYE, to: p5.Tree.WORLD })
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

const _pv   = new Float32Array(16);  // PV intermediate
const _ipv  = new Float32Array(16);  // IPV intermediate
const _wa   = new Float32Array(16);  // single-step intermediate (eye, MV, …)
const _wb   = new Float32Array(16);  // toFrameInv for custom MATRIX space
const _vp   = new Float32Array(4);   // viewport [x, y, w, h]
const _tmp3 = new Float32Array(3);   // p5.Vector out path in map*** functions

// ═══════════════════════════════════════════════════════════════════════════
// Unified type normalisers — zero alloc
// ═══════════════════════════════════════════════════════════════════════════

// p5.Matrix exposes its internal Float32Array via .mat4 (4×4) or .mat3 (3×3).
// Plain Float32Array / ArrayLike fall through unchanged.
const _rawMat4 = (m) => (m != null && m.mat4 != null) ? m.mat4 : m;
const _rawMat3 = (m) => (m != null && m.mat3 != null) ? m.mat3 : m;

// ═══════════════════════════════════════════════════════════════════════════
// NDC convention — detected once in postsetup
// ═══════════════════════════════════════════════════════════════════════════

let _ndcZ = WEBGL;

/** Called from addon index.js lifecycles.postsetup. */
export function detectNDC(renderer) {
  if (renderer.drawingContext &&
      typeof WebGL2RenderingContext !== 'undefined' &&
      renderer.drawingContext instanceof WebGL2RenderingContext) {
    _ndcZ = WEBGL;
  } else {
    _ndcZ = WEBGPU;
  }
}

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

  // Detect vec input: Array, TypedArray, or p5.Vector.
  // Plain opts objects { from, to, … } do not match.
  const _isVec = (v) => v != null &&
    (Array.isArray(v) || ArrayBuffer.isView(v) || v instanceof p5.Vector);

  // ── p5.Matrix utilities ───────────────────────────────────────────────────
  //
  // Operate on p5.Matrix objects for callers working with p5's own matrix
  // stack. Not matrix queries — do not follow the out-first contract.

  fn.tMatrix = function (m) {
    const s = m.mat4;
    if (s) return new p5.Matrix([s[0],s[4],s[8],s[12],s[1],s[5],s[9],s[13],s[2],s[6],s[10],s[14],s[3],s[7],s[11],s[15]]);
    const t = m.mat3;
    if (t) return new p5.Matrix([t[0],t[3],t[6],t[1],t[4],t[7],t[2],t[5],t[8]]);
  };
  fn.iMatrix      = function (m)    { const o = m.clone(); o.invert(m); return o; };
  fn.axbMatrix    = function (a, b) { return a.clone().mult(b); };
  fn.createMatrix = (...args) => new p5.Matrix(...args);

  // ── Simple matrix queries ────────────────────────────────────────────────
  //
  // Each reads from live p5 renderer state and writes into the caller-provided
  // out buffer. Accepts Float32Array | ArrayLike | p5.Matrix for out.

  /**
   * Projection matrix.
   * @param {Float32Array|p5.Matrix} out  16-element destination.
   * @returns {typeof out}
   */
  p5.Renderer3D.prototype.pMatrix = function (out) {
    const buf = _rawMat4(out), s = _projMat4(this);
    for (let i = 0; i < 16; i++) buf[i] = s[i];
    return out;
  };
  fn.pMatrix = function (out) { return this._renderer.pMatrix(out); };

  /**
   * Model matrix.
   * @param {Float32Array|p5.Matrix} out  16-element destination.
   * @returns {typeof out}
   */
  p5.Renderer3D.prototype.mMatrix = function (out) {
    const buf = _rawMat4(out), s = _modelMat4(this);
    for (let i = 0; i < 16; i++) buf[i] = s[i];
    return out;
  };
  fn.mMatrix = function (out) { return this._renderer.mMatrix(out); };

  /**
   * View matrix (world → eye).
   * @param {Float32Array|p5.Matrix} out  16-element destination.
   * @returns {typeof out}
   */
  p5.Camera.prototype.vMatrix = function (out) {
    const buf = _rawMat4(out), s = this.cameraMatrix.mat4;
    for (let i = 0; i < 16; i++) buf[i] = s[i];
    return out;
  };
  p5.Renderer3D.prototype.vMatrix = function (out) { return this.states.curCamera.vMatrix(out); };
  fn.vMatrix = function (out) { return this._renderer.vMatrix(out); };

  /**
   * Eye matrix (eye → world, i.e. inverse view).
   * @param {Float32Array|p5.Matrix} out  16-element destination.
   * @returns {typeof out|null} out, or null if the view matrix is singular.
   */
  p5.Camera.prototype.eMatrix = function (out) {
    const buf = _rawMat4(out);
    return mat4Invert(buf, this.cameraMatrix.mat4) === null ? null : out;
  };
  p5.Renderer3D.prototype.eMatrix = function (out) { return this.states.curCamera.eMatrix(out); };
  fn.eMatrix = function (out) { return this._renderer.eMatrix(out); };

  // ── Composite matrix queries ─────────────────────────────────────────────
  //
  // out is first; optional matrix overrides follow in an opts object.
  // All matrix opts accept Float32Array | ArrayLike | p5.Matrix.

  /**
   * Projection-view matrix: P · V.
   * @param {Float32Array|p5.Matrix} out
   * @param {{ pMatrix?: Float32Array|p5.Matrix, vMatrix?: Float32Array|p5.Matrix }} [opts]
   * @returns {typeof out}
   */
  p5.Renderer3D.prototype.pvMatrix = function (out, { pMatrix, vMatrix } = {}) {
    const buf = _rawMat4(out);
    mat4Mul(buf, _rawMat4(pMatrix) ?? _projMat4(this), _rawMat4(vMatrix) ?? _viewMat4(this));
    return out;
  };
  fn.pvMatrix = function (out, opts) { return this._renderer.pvMatrix(out, opts); };

  /**
   * Inverse projection-view matrix: inv(P · V).
   * @param {Float32Array|p5.Matrix} out
   * @param {{ pMatrix?: Float32Array|p5.Matrix, vMatrix?: Float32Array|p5.Matrix, pvMatrix?: Float32Array|p5.Matrix }} [opts]
   *   Pass `pvMatrix` to skip recomputing P · V.
   * @returns {typeof out|null} out, or null if singular.
   */
  p5.Renderer3D.prototype.ipvMatrix = function (out, { pMatrix, vMatrix, pvMatrix } = {}) {
    const pv = _rawMat4(pvMatrix) ??
      (mat4Mul(_pv, _rawMat4(pMatrix) ?? _projMat4(this), _rawMat4(vMatrix) ?? _viewMat4(this)), _pv);
    const buf = _rawMat4(out);
    return mat4Invert(buf, pv) === null ? null : out;
  };
  fn.ipvMatrix = function (out, opts) { return this._renderer.ipvMatrix(out, opts); };

  /**
   * Model-view matrix: V · M.
   * @param {Float32Array|p5.Matrix} out
   * @param {{ mMatrix?: Float32Array|p5.Matrix, vMatrix?: Float32Array|p5.Matrix }} [opts]
   * @returns {typeof out}
   */
  p5.Renderer3D.prototype.mvMatrix = function (out, { mMatrix, vMatrix } = {}) {
    const buf = _rawMat4(out);
    mat4Mul(buf, _rawMat4(vMatrix) ?? _viewMat4(this), _rawMat4(mMatrix) ?? _modelMat4(this));
    return out;
  };
  fn.mvMatrix = function (out, opts) { return this._renderer.mvMatrix(out, opts); };

  /**
   * Projection-model-view matrix: P · V · M.
   * @param {Float32Array|p5.Matrix} out
   * @param {{ pMatrix?: Float32Array|p5.Matrix, mMatrix?: Float32Array|p5.Matrix, vMatrix?: Float32Array|p5.Matrix }} [opts]
   * @returns {typeof out}
   */
  p5.Renderer3D.prototype.pmvMatrix = function (out, { pMatrix, mMatrix, vMatrix } = {}) {
    mat4Mul(_wa, _rawMat4(vMatrix) ?? _viewMat4(this), _rawMat4(mMatrix) ?? _modelMat4(this));
    const buf = _rawMat4(out);
    mat4Mul(buf, _rawMat4(pMatrix) ?? _projMat4(this), _wa);
    return out;
  };
  fn.pmvMatrix = function (out, opts) { return this._renderer.pmvMatrix(out, opts); };

  /**
   * Normal matrix: inverseTranspose(upper 3×3 of V · M).
   * @param {Float32Array|p5.Matrix} out  9-element destination.
   * @param {{ mMatrix?: Float32Array|p5.Matrix, vMatrix?: Float32Array|p5.Matrix, mvMatrix?: Float32Array|p5.Matrix }} [opts]
   *   Pass `mvMatrix` to skip recomputing V · M.
   * @returns {typeof out}
   */
  p5.Renderer3D.prototype.nMatrix = function (out, { mMatrix, vMatrix, mvMatrix } = {}) {
    const mv = _rawMat4(mvMatrix) ??
      (mat4Mul(_wa, _rawMat4(vMatrix) ?? _viewMat4(this), _rawMat4(mMatrix) ?? _modelMat4(this)), _wa);
    const buf = _rawMat3(out);
    mat3NormalFromMat4(buf, mv);
    return out;
  };
  fn.nMatrix = function (out, opts) { return this._renderer.nMatrix(out, opts); };

  /**
   * Location transform matrix: inv(to) · from.
   *
   * Maps a point from the `from` frame into the `to` frame: p_to = out · p_from.
   *
   * @param {Float32Array|p5.Matrix} out   16-element destination.
   * @param {Float32Array|p5.Matrix} from  Source frame transform.
   * @param {Float32Array|p5.Matrix} to    Destination frame transform.
   * @returns {typeof out|null} out, or null if `to` is singular.
   */
  p5.Renderer3D.prototype.lMatrix = function (out, from, to) {
    const buf = _rawMat4(out);
    return mat4Location(buf, _rawMat4(from), _rawMat4(to)) === null ? null : out;
  };
  fn.lMatrix = function (out, from, to) { return this._renderer.lMatrix(out, from, to); };

  /**
   * Direction transform matrix: to₃ · inv(from₃).
   *
   * Uses only the upper-left 3×3 blocks (rotation/scale, no translation).
   *
   * @param {Float32Array|p5.Matrix} out   9-element destination.
   * @param {Float32Array|p5.Matrix} from  Source frame transform (mat4).
   * @param {Float32Array|p5.Matrix} to    Destination frame transform (mat4).
   * @returns {typeof out|null} out, or null if `from` is singular.
   */
  p5.Renderer3D.prototype.dMatrix = function (out, from, to) {
    const buf = _rawMat3(out);
    return mat3Direction(buf, _rawMat4(from), _rawMat4(to)) === null ? null : out;
  };
  fn.dMatrix = function (out, from, to) { return this._renderer.dMatrix(out, from, to); };

  // ── Projection scalar queries ─────────────────────────────────────────────

  p5.Renderer3D.prototype.isOrtho = function () { return projIsOrtho(_projMat4(this)); };
  fn.isOrtho = function () { return this._renderer.isOrtho(); };

  p5.Renderer3D.prototype.nPlane = function () { return projNear(_projMat4(this), _ndcZ); };
  p5.Renderer3D.prototype.fPlane = function () { return projFar(_projMat4(this)); };
  p5.Renderer3D.prototype.lPlane = function () { return projLeft(_projMat4(this), _ndcZ); };
  p5.Renderer3D.prototype.rPlane = function () { return projRight(_projMat4(this), _ndcZ); };
  p5.Renderer3D.prototype.tPlane = function () { return projTop(_projMat4(this), _ndcZ); };
  p5.Renderer3D.prototype.bPlane = function () { return projBottom(_projMat4(this), _ndcZ); };

  fn.nPlane = function () { return this._renderer.nPlane(); };
  fn.fPlane = function () { return this._renderer.fPlane(); };
  fn.lPlane = function () { return this._renderer.lPlane(); };
  fn.rPlane = function () { return this._renderer.rPlane(); };
  fn.tPlane = function () { return this._renderer.tPlane(); };
  fn.bPlane = function () { return this._renderer.bPlane(); };

  p5.Renderer3D.prototype.fov  = function () { return projFov(_projMat4(this)); };
  p5.Renderer3D.prototype.hfov = function () { return projHfov(_projMat4(this)); };
  fn.fov  = function () { return this._renderer.fov(); };
  fn.hfov = function () { return this._renderer.hfov(); };

  // ── HUD (beginHUD / endHUD) ───────────────────────────────────────────────

  fn.beginHUD = function (...args) { this._renderer?.beginHUD?.(...args); return this; };
  fn.endHUD   = function (...args) { this._renderer?.endHUD?.(...args);   return this; };

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
  };

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
  };

  // ── _buildBag — shared bag-builder for mapLocation / mapDirection ─────────
  //
  // from / to are either a space-string constant (EYE, WORLD, SCREEN, …) or a
  // matrix (Float32Array | ArrayLike | p5.Matrix) for a custom MATRIX frame.
  // p5.Tree.MODEL must be resolved to the live _modelMat4 ref before calling.
  // _wb holds toFrameInv for the MATRIX-to path; valid until coreMap* returns.

  function _buildBag(renderer, options, from, to) {
    const bag = {
      proj: _rawMat4(options.pMatrix) ?? _projMat4(renderer),
      view: _rawMat4(options.vMatrix) ?? _viewMat4(renderer),
      eye: null, pv: null, ipv: null,
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

  fn.mapLocation = function (out, ...rest) { return this._renderer.mapLocation(out, ...rest); };

  /**
   * Map a point between coordinate spaces.
   *
   * Signatures:
   *   mapLocation(out, point, opts?)   — explicit input point
   *   mapLocation(out, opts?)          — defaults to ORIGIN
   *   mapLocation(out)                 — defaults to ORIGIN, EYE→WORLD
   *
   * @param {Float32Array|ArrayLike|p5.Vector} out    3-element destination.
   * @param {Float32Array|ArrayLike|p5.Vector} [point]  Input coordinates.
   * @param {{
   *   from?:      string | Float32Array | p5.Matrix,
   *   to?:        string | Float32Array | p5.Matrix,
   *   eMatrix?:   Float32Array | p5.Matrix,
   *   pMatrix?:   Float32Array | p5.Matrix,
   *   vMatrix?:   Float32Array | p5.Matrix,
   *   pvMatrix?:  Float32Array | p5.Matrix,
   *   ipvMatrix?: Float32Array | p5.Matrix,
   * }} [opts]
   * @returns {typeof out}
   *
   * @example
   * const loc = new Float32Array(3)
   * p.mapLocation(loc, [0,0,0], { from: p5.Tree.EYE, to: p5.Tree.WORLD })
   */
  p5.Renderer3D.prototype.mapLocation = function (out, ...rest) {
    // Disambiguate: rest[0] is the input point if it looks like a vector.
    const hasVec = _isVec(rest[0]);
    const point  = hasVec ? rest[0] : p5.Tree.ORIGIN;
    const opts   = (hasVec ? rest[1] : rest[0]) ?? {};

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
      bag.eye = _rawMat4(opts.eMatrix) ??
        (mat4Invert(_wa, bag.view), _wa);
    }
    if (toStr === SCREEN || toStr === NDC || fromStr === SCREEN || fromStr === NDC) {
      bag.pv = _rawMat4(opts.pvMatrix) ??
        (mat4Mul(_pv, bag.proj, bag.view), _pv);
      if (fromStr === SCREEN || fromStr === NDC) {
        bag.ipv = _rawMat4(opts.ipvMatrix) ??
          (mat4Invert(_ipv, bag.pv), _ipv);
      }
    }

    _vp[0] = 0; _vp[1] = this.height; _vp[2] = this.width; _vp[3] = -this.height;

    // If out is p5.Vector, core writes into _tmp3, then we copy back.
    const isVecOut = out instanceof p5.Vector;
    const buf = isVecOut ? _tmp3 : out;
    coreMapLocation(buf, px, py, pz, fromStr, toStr, bag, _vp, _ndcZ);
    if (isVecOut) { out.x = buf[0]; out.y = buf[1]; out.z = buf[2]; }
    return out;
  };

  // ── mapDirection ──────────────────────────────────────────────────────────

  fn.mapDirection = function (out, ...rest) { return this._renderer.mapDirection(out, ...rest); };

  /**
   * Map a direction vector between coordinate spaces.
   *
   * Signatures:
   *   mapDirection(out, dir, opts?)   — explicit input direction
   *   mapDirection(out, opts?)        — defaults to −Z (look direction)
   *   mapDirection(out)               — defaults to −Z, EYE→WORLD
   *
   * @param {Float32Array|ArrayLike|p5.Vector} out   3-element destination.
   * @param {Float32Array|ArrayLike|p5.Vector} [dir] Input direction.
   * @param {{
   *   from?:    string | Float32Array | p5.Matrix,
   *   to?:      string | Float32Array | p5.Matrix,
   *   eMatrix?: Float32Array | p5.Matrix,
   *   pMatrix?: Float32Array | p5.Matrix,
   *   vMatrix?: Float32Array | p5.Matrix,
   * }} [opts]
   * @returns {typeof out}
   *
   * @example
   * const dir = new Float32Array(3)
   * p.mapDirection(dir, [0,0,-1], { from: p5.Tree.EYE, to: p5.Tree.WORLD })
   */
  p5.Renderer3D.prototype.mapDirection = function (out, ...rest) {
    const hasVec = _isVec(rest[0]);
    const dir    = hasVec ? rest[0] : p5.Tree._k;
    const opts   = (hasVec ? rest[1] : rest[0]) ?? {};

    const dx = dir.x ?? dir[0] ?? 0;
    const dy = dir.y ?? dir[1] ?? 0;
    const dz = dir.z ?? dir[2] ?? 0;

    let from = opts.from ?? p5.Tree.EYE;
    let to   = opts.to   ?? p5.Tree.WORLD;
    if (from === p5.Tree.MODEL) from = _modelMat4(this);
    if (to   === p5.Tree.MODEL) to   = _modelMat4(this);

    const { bag, fromStr, toStr } = _buildBag(this, opts, from, to);

    bag.eye = _rawMat4(opts.eMatrix) ??
      (mat4Invert(_wa, bag.view), _wa);

    _vp[0] = 0; _vp[1] = this.height; _vp[2] = this.width; _vp[3] = -this.height;

    const isVecOut = out instanceof p5.Vector;
    const buf = isVecOut ? _tmp3 : out;
    coreMapDirection(buf, dx, dy, dz, fromStr, toStr, bag, _vp, _ndcZ);
    if (isVecOut) { out.x = buf[0]; out.y = buf[1]; out.z = buf[2]; }
    return out;
  };

  // ── Utilities ─────────────────────────────────────────────────────────────

  fn.pixelRatio = function (point) { return this._renderer.pixelRatio(point); };

  /**
   * World-units-per-pixel at the given world-space point.
   * @param {ArrayLike|p5.Vector} [point]  Defaults to origin.
   * @returns {number}
   */
  p5.Renderer3D.prototype.pixelRatio = function (point = p5.Tree.ORIGIN) {
    const proj = _projMat4(this);
    if (projIsOrtho(proj)) return corePixelRatio(proj, this.height, 0, _ndcZ);
    const px = point.x ?? point[0] ?? 0;
    const py = point.y ?? point[1] ?? 0;
    const pz = point.z ?? point[2] ?? 0;
    const view = _viewMat4(this);
    const eyeZ = view[2]*px + view[6]*py + view[10]*pz + view[14];
    return corePixelRatio(proj, this.height, eyeZ, _ndcZ);
  };

  fn.texOffset = function (image) { return [1 / image.width, 1 / image.height]; };

  fn.mousePosition = function (flip = true) {
    const pd = this.pixelDensity();
    return [pd * this.mouseX, pd * (flip ? this.height - this.mouseY : this.mouseY)];
  };

  fn.pointerPosition = function (...args) { return this._renderer.pointerPosition(...args); };
  fn.resolution      = function ()        { return this._renderer.resolution(); };

  p5.Renderer3D.prototype.pointerPosition = function (...args) {
    let pointerX, pointerY, flip = true;
    for (const arg of args) {
      if (typeof arg === 'number') { pointerX == null ? (pointerX = arg) : (pointerY = arg); }
      else if (typeof arg === 'boolean') { flip = arg; }
    }
    const pd = this.pixelDensity();
    return [pd * pointerX, pd * (flip ? this.height - pointerY : pointerY)];
  };

  p5.Renderer3D.prototype.resolution = function () {
    const pd = this.pixelDensity();
    return [pd * this.width, pd * this.height];
  };
}
