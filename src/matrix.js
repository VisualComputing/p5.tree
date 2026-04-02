/**
 * @file Matrix queries, space transforms, and frustum scalar queries.
 * @module p5.tree/matrix
 * @license AGPL-3.0-only
 *
 * ── Overview ──────────────────────────────────────────────────────────────
 *
 *   All matrix query functions follow the same contract:
 *     out  — first parameter, caller-owned buffer, written and returned.
 *     null — returned on degeneracy (singular matrix).
 *     zero allocations in hot paths.
 *
 *   Matrix params (16-elem):  Float32Array | ArrayLike | p5.Matrix(.mat4)
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
 *   p.mat4Eye(e)
 *   p.mat4Proj(pm)
 *   p.mat4PV(pv)
 *   p.viewFrustum({ mat4Eye: e, mat4Proj: pm })
 *   p.mouseHit({ mat4PV: pv, mat4Eye: e })
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

const _pv   = new Float32Array(16);  // mat4PV intermediate
const _ipv  = new Float32Array(16);  // mat4PVInv intermediate
const _wa   = new Float32Array(16);  // single-step intermediate (mat4Eye, MV, …)
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

  // Detect vec input: Array, TypedArray, or p5.Vector.
  // Plain opts objects { from, to, … } do not match.
  const _isVec = (v) => v != null &&
    (Array.isArray(v) || ArrayBuffer.isView(v) || v instanceof p5.Vector);

  // ── p5.Matrix utilities ───────────────────────────────────────────────────

  fn.createMatrix = (...args) => new p5.Matrix(...args);

  // ── Simple matrix queries ─────────────────────────────────────────────────
  //
  // Each reads from live p5 renderer state and writes into the caller-provided
  // out buffer. Accepts Float32Array | ArrayLike | p5.Matrix for out.

  /**
   * Projection matrix (eye → clip).
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @returns {typeof out}
   */
  p5.Renderer3D.prototype.mat4Proj = function (out) {
    const buf = _rawMat4(out), s = _projMat4(this);
    for (let i = 0; i < 16; i++) buf[i] = s[i];
    return out;
  };
  fn.mat4Proj = function (out) { return this._renderer.mat4Proj(out); };

  /**
   * Model matrix (local → world).
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @returns {typeof out}
   */
  p5.Renderer3D.prototype.mat4Model = function (out) {
    const buf = _rawMat4(out), s = _modelMat4(this);
    for (let i = 0; i < 16; i++) buf[i] = s[i];
    return out;
  };
  fn.mat4Model = function (out) { return this._renderer.mat4Model(out); };

  /**
   * View matrix (world → eye).
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @returns {typeof out}
   */
  p5.Camera.prototype.mat4View = function (out) {
    const buf = _rawMat4(out), s = this.cameraMatrix.mat4;
    for (let i = 0; i < 16; i++) buf[i] = s[i];
    return out;
  };
  p5.Renderer3D.prototype.mat4View = function (out) { return this.states.curCamera.mat4View(out); };
  fn.mat4View = function (out) { return this._renderer.mat4View(out); };

  /**
   * Eye matrix (eye → world, i.e. inverse view).
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @returns {typeof out|null} out, or null if the view matrix is singular.
   */
  p5.Camera.prototype.mat4Eye = function (out) {
    const buf = _rawMat4(out);
    return mat4Invert(buf, this.cameraMatrix.mat4) === null ? null : out;
  };
  p5.Renderer3D.prototype.mat4Eye = function (out) { return this.states.curCamera.mat4Eye(out); };
  fn.mat4Eye = function (out) { return this._renderer.mat4Eye(out); };

  // ── Composite matrix queries ──────────────────────────────────────────────
  //
  // out is first; optional matrix overrides follow in an opts object.
  // All matrix opts accept Float32Array | ArrayLike | p5.Matrix.

  /**
   * Projection-view matrix: P · V.
   * @param {Float32Array|ArrayLike|p5.Matrix} out
   * @param {{ mat4Proj?: Float32Array|ArrayLike|p5.Matrix, mat4View?: Float32Array|ArrayLike|p5.Matrix }} [opts]
   * @returns {typeof out}
   */
  p5.Renderer3D.prototype.mat4PV = function (out, { mat4Proj, mat4View } = {}) {
    const buf = _rawMat4(out);
    mat4Mul(buf, _rawMat4(mat4Proj) ?? _projMat4(this), _rawMat4(mat4View) ?? _viewMat4(this));
    return out;
  };
  fn.mat4PV = function (out, opts) { return this._renderer.mat4PV(out, opts); };

  /**
   * Inverse projection-view matrix: inv(P · V).
   * @param {Float32Array|ArrayLike|p5.Matrix} out
   * @param {{ mat4Proj?: Float32Array|ArrayLike|p5.Matrix, mat4View?: Float32Array|ArrayLike|p5.Matrix, mat4PV?: Float32Array|ArrayLike|p5.Matrix }} [opts]
   *   Pass `mat4PV` to skip recomputing P · V.
   * @returns {typeof out|null} out, or null if singular.
   */
  p5.Renderer3D.prototype.mat4PVInv = function (out, { mat4Proj, mat4View, mat4PV } = {}) {
    const pv = _rawMat4(mat4PV) ??
      (mat4Mul(_pv, _rawMat4(mat4Proj) ?? _projMat4(this), _rawMat4(mat4View) ?? _viewMat4(this)), _pv);
    const buf = _rawMat4(out);
    return mat4Invert(buf, pv) === null ? null : out;
  };
  fn.mat4PVInv = function (out, opts) { return this._renderer.mat4PVInv(out, opts); };

  /**
   * Model-view matrix: V · M.
   * @param {Float32Array|ArrayLike|p5.Matrix} out
   * @param {{ mat4Model?: Float32Array|ArrayLike|p5.Matrix, mat4View?: Float32Array|ArrayLike|p5.Matrix }} [opts]
   * @returns {typeof out}
   */
  p5.Renderer3D.prototype.mat4MV = function (out, { mat4Model, mat4View } = {}) {
    const buf = _rawMat4(out);
    mat4Mul(buf, _rawMat4(mat4View) ?? _viewMat4(this), _rawMat4(mat4Model) ?? _modelMat4(this));
    return out;
  };
  fn.mat4MV = function (out, opts) { return this._renderer.mat4MV(out, opts); };

  /**
   * Projection-model-view matrix: P · V · M.
   * @param {Float32Array|ArrayLike|p5.Matrix} out
   * @param {{ mat4Proj?: Float32Array|ArrayLike|p5.Matrix, mat4Model?: Float32Array|ArrayLike|p5.Matrix, mat4View?: Float32Array|ArrayLike|p5.Matrix }} [opts]
   * @returns {typeof out}
   */
  p5.Renderer3D.prototype.mat4PMV = function (out, { mat4Proj, mat4Model, mat4View } = {}) {
    mat4Mul(_wa, _rawMat4(mat4View) ?? _viewMat4(this), _rawMat4(mat4Model) ?? _modelMat4(this));
    const buf = _rawMat4(out);
    mat4Mul(buf, _rawMat4(mat4Proj) ?? _projMat4(this), _wa);
    return out;
  };
  fn.mat4PMV = function (out, opts) { return this._renderer.mat4PMV(out, opts); };

  /**
   * Normal matrix: inverseTranspose(upper 3×3 of V · M).
   * @param {Float32Array|ArrayLike|p5.Matrix} out  9-element destination.
   * @param {{ mat4Model?: Float32Array|ArrayLike|p5.Matrix, mat4View?: Float32Array|ArrayLike|p5.Matrix, mat4MV?: Float32Array|ArrayLike|p5.Matrix }} [opts]
   *   Pass `mat4MV` to skip recomputing V · M.
   * @returns {typeof out}
   */
  p5.Renderer3D.prototype.mat3Normal = function (out, { mat4Model, mat4View, mat4MV } = {}) {
    const mv = _rawMat4(mat4MV) ??
      (mat4Mul(_wa, _rawMat4(mat4View) ?? _viewMat4(this), _rawMat4(mat4Model) ?? _modelMat4(this)), _wa);
    const buf = _rawMat3(out);
    mat3NormalFromMat4(buf, mv);
    return out;
  };
  fn.mat3Normal = function (out, opts) { return this._renderer.mat3Normal(out, opts); };

  /**
   * Location transform matrix: inv(to) · from.
   * Maps a point from the `from` frame into the `to` frame: p_to = out · p_from.
   * @param {Float32Array|ArrayLike|p5.Matrix} out   16-element destination.
   * @param {Float32Array|ArrayLike|p5.Matrix} from  Source frame transform.
   * @param {Float32Array|ArrayLike|p5.Matrix} to    Destination frame transform.
   * @returns {typeof out|null} out, or null if `to` is singular.
   */
  p5.Renderer3D.prototype.mat4Location = function (out, from, to) {
    const buf = _rawMat4(out);
    return mat4Location(buf, _rawMat4(from), _rawMat4(to)) === null ? null : out;
  };
  fn.mat4Location = function (out, from, to) { return this._renderer.mat4Location(out, from, to); };

  /**
   * Direction transform matrix: to₃ · inv(from₃).
   * Uses only the upper-left 3×3 blocks (rotation/scale, no translation).
   * @param {Float32Array|ArrayLike|p5.Matrix} out   9-element destination.
   * @param {Float32Array|ArrayLike|p5.Matrix} from  Source frame transform (mat4).
   * @param {Float32Array|ArrayLike|p5.Matrix} to    Destination frame transform (mat4).
   * @returns {typeof out|null} out, or null if `from` is singular.
   */
  p5.Renderer3D.prototype.mat3Direction = function (out, from, to) {
    const buf = _rawMat3(out);
    return mat3Direction(buf, _rawMat4(from), _rawMat4(to)) === null ? null : out;
  };
  fn.mat3Direction = function (out, from, to) { return this._renderer.mat3Direction(out, from, to); };

  // ── Raw math forwarders ───────────────────────────────────────────────────
  //
  // Exposed for sketches that need custom matrix arithmetic (e.g. composing a
  // bias matrix with a light PV for shadow mapping) without reaching into the
  // @nakednous/tree package directly. Same out-first, zero-alloc contract.

  /**
   * Matrix product: out = A · B  (column-major).
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @param {Float32Array|ArrayLike|p5.Matrix} A
   * @param {Float32Array|ArrayLike|p5.Matrix} B
   * @returns {typeof out}
   */
  p5.Renderer3D.prototype.mat4Mul = function (out, A, B) {
    mat4Mul(_rawMat4(out), _rawMat4(A), _rawMat4(B));
    return out;
  };
  fn.mat4Mul = function (out, A, B) { return this._renderer.mat4Mul(out, A, B); };

  /**
   * Matrix inverse: out = inv(src).
   * @param {Float32Array|ArrayLike|p5.Matrix} out  16-element destination.
   * @param {Float32Array|ArrayLike|p5.Matrix} src
   * @returns {typeof out|null} out, or null if singular.
   */
  p5.Renderer3D.prototype.mat4Invert = function (out, src) {
    const buf = _rawMat4(out);
    return mat4Invert(buf, _rawMat4(src)) === null ? null : out;
  };
  fn.mat4Invert = function (out, src) { return this._renderer.mat4Invert(out, src); };

  // ── Projection scalar queries ─────────────────────────────────────────────

  p5.Renderer3D.prototype.projIsOrtho = function () { return projIsOrtho(_projMat4(this)); };
  fn.projIsOrtho = function () { return this._renderer.projIsOrtho(); };

  p5.Renderer3D.prototype.projNear   = function () { return projNear(_projMat4(this), _ndcZ); };
  p5.Renderer3D.prototype.projFar    = function () { return projFar(_projMat4(this)); };
  p5.Renderer3D.prototype.projLeft   = function () { return projLeft(_projMat4(this), _ndcZ); };
  p5.Renderer3D.prototype.projRight  = function () { return projRight(_projMat4(this), _ndcZ); };
  p5.Renderer3D.prototype.projTop    = function () { return projTop(_projMat4(this), _ndcZ); };
  p5.Renderer3D.prototype.projBottom = function () { return projBottom(_projMat4(this), _ndcZ); };

  fn.projNear   = function () { return this._renderer.projNear(); };
  fn.projFar    = function () { return this._renderer.projFar(); };
  fn.projLeft   = function () { return this._renderer.projLeft(); };
  fn.projRight  = function () { return this._renderer.projRight(); };
  fn.projTop    = function () { return this._renderer.projTop(); };
  fn.projBottom = function () { return this._renderer.projBottom(); };

  p5.Renderer3D.prototype.projFov  = function () { return projFov(_projMat4(this)); };
  p5.Renderer3D.prototype.projHfov = function () { return projHfov(_projMat4(this)); };
  fn.projFov  = function () { return this._renderer.projFov(); };
  fn.projHfov = function () { return this._renderer.projHfov(); };

  // ── _buildBag — shared bag-builder for mapLocation / mapDirection ─────────
  //
  // from / to are either a space-string constant (EYE, WORLD, SCREEN, …) or a
  // matrix (Float32Array | ArrayLike | p5.Matrix) for a custom MATRIX frame.
  // p5.Tree.MODEL must be resolved to the live _modelMat4 ref before calling.
  // _wb holds toFrameInv for the MATRIX-to path; valid until coreMap* returns.

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

  fn.mapLocation = function (out, ...rest) { return this._renderer.mapLocation(out, ...rest); };

  /**
   * Map a point between coordinate spaces.
   *
   * Signatures:
   *   mapLocation(out, point, opts?)   — explicit input point
   *   mapLocation(out, opts?)          — defaults to ORIGIN
   *   mapLocation(out)                 — defaults to ORIGIN, EYE→WORLD
   *
   * @param {Float32Array|ArrayLike|p5.Vector} out     3-element destination.
   * @param {Float32Array|ArrayLike|p5.Vector} [point] Input coordinates.
   * @param {{
   *   from?:       string | Float32Array | ArrayLike | p5.Matrix,
   *   to?:         string | Float32Array | ArrayLike | p5.Matrix,
   *   mat4Eye?:    Float32Array | ArrayLike | p5.Matrix,
   *   mat4Proj?:   Float32Array | ArrayLike | p5.Matrix,
   *   mat4View?:   Float32Array | ArrayLike | p5.Matrix,
   *   mat4PV?:     Float32Array | ArrayLike | p5.Matrix,
   *   mat4PVInv?:  Float32Array | ArrayLike | p5.Matrix,
   * }} [opts]
   * @returns {typeof out}
   */
  p5.Renderer3D.prototype.mapLocation = function (out, ...rest) {
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
   *   from?:      string | Float32Array | ArrayLike | p5.Matrix,
   *   to?:        string | Float32Array | ArrayLike | p5.Matrix,
   *   mat4Eye?:   Float32Array | ArrayLike | p5.Matrix,
   *   mat4Proj?:  Float32Array | ArrayLike | p5.Matrix,
   *   mat4View?:  Float32Array | ArrayLike | p5.Matrix,
   * }} [opts]
   * @returns {typeof out}
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
   * World-units-per-pixel at a world position.
   * @param {Float32Array|ArrayLike|p5.Vector} [worldPos]
   *   World position to query. Defaults to the camera world position.
   * @param {{
   *   mat4Proj?: Float32Array | ArrayLike | p5.Matrix,
   *   mat4View?: Float32Array | ArrayLike | p5.Matrix,
   * }} [opts]
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
   * Physical screen size in pixels: [pixelDensity × width, pixelDensity × height].
   *
   * Use to set a `u_resolution` uniform on shaders that use `gl_FragCoord.xy`
   * for full-canvas effects (portals, post-effects). Not needed for filter
   * shaders created with `createFilterShader()` — those receive `canvasSize`
   * and `texelSize` automatically.
   *
   * @method screenSize
   * @memberof p5
   * @returns {number[]} [w, h] in physical pixels.
   */
  p5.Renderer3D.prototype.screenSize = function () {
    const pd = this._pInst.pixelDensity();
    return [pd * this.width, pd * this.height];
  };
  fn.screenSize = function () { return this._renderer.screenSize(); };

  // ── texelSize ─────────────────────────────────────────────────────────────

  /**
   * Texel size of an image-like object: [1/width, 1/height].
   *
   * Pass to convolution or multi-tap shaders that sample neighbours of a
   * texture. Works with `p5.Image`, `p5.Framebuffer`, `p5.Graphics`,
   * and any duck-typed object with `.width` / `.height` properties.
   *
   * @method texelSize
   * @memberof p5
   * @param {{ width:number, height:number }} img  Image-like source.
   * @returns {number[]} [1/w, 1/h].
   */
  fn.texelSize = function (img) {
    return [1 / img.width, 1 / img.height];
  };
}
