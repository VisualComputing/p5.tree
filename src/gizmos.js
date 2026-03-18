/**
 * @file Gizmos — scene-space diagnostic helpers: axes, grid, cross, bullsEye,
 *               viewFrustum, and visibility queries.
 * @module p5.tree/gizmos
 * @license GPL-3.0-only
 *
 * Depends on p5.tree/hud (beginHUD / endHUD), p5.tree/matrix (mapLocation,
 * pixelRatio, p5.Tree constants).
 *
 * All internal calls to mapLocation write into module-level Float32Array
 * buffers — no p5.Vector allocations anywhere.
 *
 * ── Visibility pattern ────────────────────────────────────────────────────
 *
 *   // setup
 *   m._c1 = new Float32Array(3)
 *   m._c2 = new Float32Array(3)
 *
 *   // draw — zero allocations
 *   m._c1.set([px - hw, py - hh, pz - hd])
 *   m._c2.set([px + hw, py + hh, pz + hd])
 *   m.visibility = p.visibility({ corner1: m._c1, corner2: m._c2 })
 */

'use strict';

import {
  mat4Invert,
  projIsOrtho, projNear, projFar,
  projLeft, projRight, projTop, projBottom,
  frustumPlanes,
  pointVisibility, sphereVisibility, boxVisibility,
} from '@nakednous/tree';

// ═══════════════════════════════════════════════════════════════════════════
// Module-level working buffers — never returned to caller
// ═══════════════════════════════════════════════════════════════════════════

const _sl     = new Float32Array(3);   // screen location (cross, bullsEye)
const _wl     = new Float32Array(3);   // world location  (pixelRatio input)
const _eye    = new Float32Array(16);  // eye matrix for _computePlanes / viewFrustum
const _planes = new Float64Array(24);  // 6 frustum planes × [a,b,c,d]

// ═══════════════════════════════════════════════════════════════════════════
// Unified type normaliser — zero alloc
// ═══════════════════════════════════════════════════════════════════════════

const _rawMat4 = (m) => (m != null && m.mat4 != null) ? m.mat4 : m;

// ═══════════════════════════════════════════════════════════════════════════
// Local p5 state accessors
// ═══════════════════════════════════════════════════════════════════════════

const _projMat4  = (r) => r.states.uPMatrix.mat4;
const _viewMat4  = (r) => r.states.curCamera.cameraMatrix.mat4;
const _modelMat4 = (r) => r.states.uModelMatrix.mat4;

// ═══════════════════════════════════════════════════════════════════════════
// _computePlanes — fill _planes from renderer state, zero allocations
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fill the module-level _planes buffer from the current renderer state.
 * @param {p5.Renderer3D} renderer
 * @param {Float32Array}  [eRaw]  Pre-computed eye matrix — skips inversion.
 * @returns {Float64Array} _planes
 */
function _computePlanes(renderer, eRaw) {
  const view = _viewMat4(renderer);
  const e    = eRaw ?? (mat4Invert(_eye, view), _eye);
  const proj = _projMat4(renderer);
  const ndcZ = -1;
  frustumPlanes(
    _planes,
    e[12], e[13], e[14],
    -e[8], -e[9], -e[10],
     e[4],  e[5],  e[6],
     e[0],  e[1],  e[2],
    projIsOrtho(proj),
    projNear(proj, ndcZ), projFar(proj),
    projLeft(proj, ndcZ), projRight(proj, ndcZ),
    projTop(proj, ndcZ),  projBottom(proj, ndcZ)
  );
  return _planes;
}

// ═══════════════════════════════════════════════════════════════════════════
// Install
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Install gizmo helpers on fn and p5.Renderer3D.
 * @param {p5}    p5
 * @param {Object} fn  p5 prototype.
 */
export function installGizmos(p5, fn) {

  // ── Axes ──────────────────────────────────────────────────────────────────

  fn.axes = function (opts) { this._renderer.axes(opts); return this; };

  p5.Renderer3D.prototype.axes = function ({
    size   = 100,
    colors = ['Red', 'Lime', 'DodgerBlue'],
    bits   = p5.Tree.LABELS | p5.Tree.X | p5.Tree.Y | p5.Tree.Z
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    p.push();
    if ((bits & p5.Tree.LABELS) !== 0) {
      const cw = size / 40.0, ch = size / 30.0, cs = 1.04 * size;
      p.stroke(colors[0 % colors.length]);
      p.line(cs,  cw, -ch, cs, -cw,  ch);
      p.line(cs, -cw, -ch, cs,  cw,  ch);
      p.stroke(colors[1 % colors.length]);
      p.line( cw, cs,  ch,  0, cs,   0);
      p.line(  0, cs,   0, -cw, cs,  ch);
      p.line(-cw, cs,  ch,  0, cs,   0);
      p.line(  0, cs,   0,  0, cs, -ch);
      p.stroke(colors[2 % colors.length]);
      p.line(-cw, -ch, cs,  cw, -ch, cs);
      p.line( cw, -ch, cs, -cw,  ch, cs);
      p.line(-cw,  ch, cs,  cw,  ch, cs);
    }
    p.stroke(colors[0 % colors.length]);
    (bits & p5.Tree.X)  !== 0 && p.line(0,0,0,  size,0,0);
    (bits & p5.Tree._X) !== 0 && p.line(0,0,0, -size,0,0);
    p.stroke(colors[1 % colors.length]);
    (bits & p5.Tree.Y)  !== 0 && p.line(0,0,0, 0, size,0);
    (bits & p5.Tree._Y) !== 0 && p.line(0,0,0, 0,-size,0);
    p.stroke(colors[2 % colors.length]);
    (bits & p5.Tree.Z)  !== 0 && p.line(0,0,0, 0,0, size);
    (bits & p5.Tree._Z) !== 0 && p.line(0,0,0, 0,0,-size);
    p.pop();
  };

  // ── Grid ──────────────────────────────────────────────────────────────────

  fn.grid = function (opts) { this._renderer.grid(opts); return this; };

  p5.Renderer3D.prototype.grid = function ({ size = 100, subdivisions = 10 } = {}) {
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

  // ── Circle primitive ──────────────────────────────────────────────────────

  p5.Renderer3D.prototype._circle = function ({
    filled = false, x = this.width / 2, y = this.height / 2, radius = 100, detail = 50
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    p.push(); p.translate(x, y);
    if (filled) {
      p.beginShape(p.TRIANGLE_STRIP);
      for (let t = 0; t <= detail; t++) {
        const cx = Math.cos(t * (2 * Math.PI) / detail);
        const cy = Math.sin(t * (2 * Math.PI) / detail);
        p.vertex(0, 0, 0, 0.5, 0.5);
        p.vertex(radius * cx, radius * cy, 0, cx * 0.5 + 0.5, cy * 0.5 + 0.5);
      }
      p.endShape();
    } else {
      const angle = (2 * Math.PI) / detail;
      let lx = radius, ly = 0;
      for (let i = 1; i <= detail; i++) {
        const nx = Math.cos(i * angle) * radius, ny = Math.sin(i * angle) * radius;
        p.line(lx, ly, nx, ny); lx = nx; ly = ny;
      }
    }
    p.pop();
  };

  // ── Cross ─────────────────────────────────────────────────────────────────

  fn.cross = function (opts) { this._renderer.cross(opts); return this; };

  /**
   * Draw a screen-space crosshair centred on the current model's origin.
   * @param {{
   *   mMatrix?:  Float32Array | ArrayLike | p5.Matrix,
   *   x?, y?,
   *   size?:     number,
   *   eMatrix?:  Float32Array | ArrayLike | p5.Matrix,
   *   pMatrix?:  Float32Array | ArrayLike | p5.Matrix,
   *   vMatrix?:  Float32Array | ArrayLike | p5.Matrix,
   *   pvMatrix?: Float32Array | ArrayLike | p5.Matrix,
   * }} [opts]
   */
  p5.Renderer3D.prototype.cross = function ({
    mMatrix, x, y, size = 50, eMatrix, pMatrix, vMatrix, pvMatrix
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    const mm = _rawMat4(mMatrix) ?? _modelMat4(this);
    if (x == null || y == null) {
      this.mapLocation(_sl, p5.Tree.ORIGIN, { from: mm, to: p5.Tree.SCREEN, pMatrix, vMatrix, pvMatrix });
      x = _sl[0]; y = _sl[1];
      this.mapLocation(_wl, p5.Tree.ORIGIN, { from: mm, to: p5.Tree.WORLD, eMatrix });
      size = size / this.pixelRatio(_wl);
    }
    const half = size / 2.0;
    this.beginHUD();
    p.line(x - half, y, x + half, y);
    p.line(x, y - half, x, y + half);
    this.endHUD();
  };

  // ── BullsEye ──────────────────────────────────────────────────────────────

  fn.bullsEye = function (opts) { this._renderer.bullsEye(opts); return this; };

  /**
   * Draw a screen-space bulls-eye overlay centred on the current model's origin.
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
   */
  p5.Renderer3D.prototype.bullsEye = function ({
    mMatrix, x, y, size = 50, shape = p5.Tree.CIRCLE,
    eMatrix, pMatrix, vMatrix, pvMatrix
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    const mm = _rawMat4(mMatrix) ?? _modelMat4(this);
    if (x == null || y == null) {
      this.mapLocation(_sl, p5.Tree.ORIGIN, { from: mm, to: p5.Tree.SCREEN, pMatrix, vMatrix, pvMatrix });
      x = _sl[0]; y = _sl[1];
      this.mapLocation(_wl, p5.Tree.ORIGIN, { from: mm, to: p5.Tree.WORLD, eMatrix });
      size = size / this.pixelRatio(_wl);
    }
    const half = size / 2.0, corner = 0.6 * half;
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
    const ch = 0.6 * half;
    p.line(x - ch, y, x + ch, y);
    p.line(x, y - ch, x, y + ch);
    this.endHUD();
  };

  // ── View frustum ──────────────────────────────────────────────────────────

  fn.viewFrustum = function (opts) { this._renderer.viewFrustum(opts); return this; };

  /**
   * Draw the view frustum of a secondary renderer / camera into this renderer.
   *
   * @param {{
   *   pg?,
   *   eMatrix?: Float32Array | ArrayLike | p5.Matrix,
   *   pMatrix?: Float32Array | ArrayLike | p5.Matrix,
   *   vMatrix?: Float32Array | ArrayLike | p5.Matrix,
   *   bits?:    number,
   *   viewer?:  function,
   * }} [opts]
   */
  p5.Renderer3D.prototype.viewFrustum = function ({
    pg,
    eMatrix,
    pMatrix,
    vMatrix,
    bits   = p5.Tree.NEAR | p5.Tree.FAR,
    viewer = () => this.axes({
      size: 50,
      bits: p5.Tree.X | p5.Tree._X | p5.Tree.Y | p5.Tree._Y | p5.Tree.Z | p5.Tree._Z
    })
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    if (this === pg) {
      console.error('displaying viewFrustum requires a pg different than this'); return;
    }

    const eRaw = _rawMat4(eMatrix) ?? (pg ? (pg._renderer.eMatrix(_eye), _eye) : null);
    const pRaw = _rawMat4(pMatrix) ?? (pg ? _projMat4(pg._renderer) : null);

    if (!pRaw || !eRaw) {
      console.error('displaying viewFrustum requires either a pg or both eMatrix and pMatrix'); return;
    }

    const states = this.states, uView = states?.uViewMatrix;
    if (!uView) return;

    const vRaw = _rawMat4(vMatrix) ?? _viewMat4(this);

    const isOrtho = projIsOrtho(pRaw);
    const ndcZ    = -1;
    const apex    = !isOrtho && ((bits & p5.Tree.APEX) !== 0);
    const n = -projNear(pRaw, ndcZ), f = -projFar(pRaw);
    const l =  projLeft(pRaw, ndcZ), r  = projRight(pRaw, ndcZ);
    const t = isOrtho ? -projTop(pRaw, ndcZ)    : projTop(pRaw, ndcZ);
    const b = isOrtho ? -projBottom(pRaw, ndcZ) : projBottom(pRaw, ndcZ);
    const ratio = isOrtho ? 1 : f / n;
    const _l = ratio * l, _r = ratio * r, _b = ratio * b, _t = ratio * t;

    p.push(); p.resetMatrix();
    const prevView = uView.copy();
    uView.set(vRaw);
    this.applyMatrix(...eRaw);
    typeof viewer === 'function' && viewer();

    if ((bits & p5.Tree.FAR) !== 0) {
      this.beginShape(); this.vertex(_l,_t,f); this.vertex(_r,_t,f);
      this.vertex(_r,_b,f); this.vertex(_l,_b,f); this.endShape(p.CLOSE);
    } else {
      this.line(_l,_t,f,_r,_t,f); this.line(_r,_t,f,_r,_b,f);
      this.line(_r,_b,f,_l,_b,f); this.line(_l,_b,f,_l,_t,f);
    }
    if ((bits & p5.Tree.BODY) !== 0) {
      this.beginShape(); this.vertex(_l,_t,f); this.vertex(l,t,n); this.vertex(r,t,n); this.vertex(_r,_t,f); this.endShape();
      this.beginShape(); this.vertex(_r,_t,f); this.vertex(r,t,n); this.vertex(r,b,n); this.vertex(_r,_b,f); this.endShape();
      this.beginShape(); this.vertex(_r,_b,f); this.vertex(r,b,n); this.vertex(l,b,n); this.vertex(_l,_b,f); this.endShape();
      this.beginShape(); this.vertex(l,t,n); this.vertex(_l,_t,f); this.vertex(_l,_b,f); this.vertex(l,b,n); this.endShape();
      if (apex) {
        this.line(0,0,0,r,t,n); this.line(0,0,0,l,t,n);
        this.line(0,0,0,l,b,n); this.line(0,0,0,r,b,n);
      }
    } else {
      this.line(apex?0:r, apex?0:t, apex?0:n, _r,_t,f);
      this.line(apex?0:l, apex?0:t, apex?0:n, _l,_t,f);
      this.line(apex?0:l, apex?0:b, apex?0:n, _l,_b,f);
      this.line(apex?0:r, apex?0:b, apex?0:n, _r,_b,f);
    }
    if ((bits & p5.Tree.NEAR) !== 0) {
      this.beginShape(); this.vertex(l,t,n); this.vertex(r,t,n);
      this.vertex(r,b,n); this.vertex(l,b,n); this.endShape(p.CLOSE);
    } else {
      this.line(l,t,n,r,t,n); this.line(r,t,n,r,b,n);
      this.line(r,b,n,l,b,n); this.line(l,b,n,l,t,n);
    }

    uView.set(prevView);
    p.pop();
  };

  // ── Visibility ────────────────────────────────────────────────────────────

  fn.visibility      = function (...args) { return this._renderer.visibility(...args); };
  fn.bounds          = function (opts)    { return this._renderer.bounds(opts); };
  fn.distanceToBound = function (...args) { return this._renderer.distanceToBound(...args); };

  p5.Renderer3D.prototype._parseVisibilityArgs = function (...args) {
    let corner1, corner2, center, radius, pendingRadius, bounds;
    const vecs = [];
    const isPlainObject = v => {
      if (!v || typeof v !== 'object') return false;
      if (Array.isArray(v) || ArrayBuffer.isView(v)) return false;
      return Object.getPrototypeOf(v) === Object.prototype;
    };
    for (const arg of args) {
      if (arg instanceof p5.Vector || Array.isArray(arg) || ArrayBuffer.isView(arg)) {
        vecs.push(arg); continue;
      }
      if (typeof arg === 'number' && Number.isFinite(arg) && radius === undefined) {
        center ? (radius = arg) : (pendingRadius = arg); continue;
      }
      if (isPlainObject(arg)) {
        if ('corner1' in arg || 'corner2' in arg || 'center' in arg ||
            'radius'  in arg || 'bounds'  in arg) {
          corner1 = arg.corner1 ?? corner1; corner2 = arg.corner2 ?? corner2;
          center  = arg.center  ?? center;  radius  = arg.radius  ?? radius;
          bounds  = arg.bounds  ?? bounds;
        } else { bounds = arg; }
      }
    }
    if (!corner1 && !corner2) {
      if (!center && vecs.length === 1) { center = vecs[0]; }
      else if (vecs.length >= 2) { corner1 = vecs[0]; corner2 = vecs[1]; }
    }
    if (radius === undefined && pendingRadius !== undefined && center) { radius = pendingRadius; }
    return { corner1, corner2, center, radius, bounds };
  };

  /**
   * Test visibility of a point, sphere, or AABB against the view frustum.
   *
   * Fast path (no `bounds` option): calls core boxVisibility / sphereVisibility /
   * pointVisibility directly — zero allocations per call.
   * Fallback (user-supplied `bounds` object): scalar arithmetic on the keyed plane
   * object.
   *
   * Accepts Float32Array(3) or plain array for corner1/corner2/center.
   *
   * @method visibility
   * @for p5
   * @returns {number} p5.Tree.VISIBLE | SEMIVISIBLE | INVISIBLE
   */
  p5.Renderer3D.prototype.visibility = function (...args) {
    const { corner1, corner2, center, radius, bounds: userBounds } = this._parseVisibilityArgs(...args);

    if (!userBounds) {
      const planes = _computePlanes(this);
      if (center) {
        const cx = center.x ?? center[0] ?? 0;
        const cy = center.y ?? center[1] ?? 0;
        const cz = center.z ?? center[2] ?? 0;
        return radius != null
          ? sphereVisibility(planes, cx, cy, cz, radius)
          : pointVisibility(planes, cx, cy, cz);
      }
      if (corner1 && corner2) {
        return boxVisibility(
          planes,
          corner1.x ?? corner1[0] ?? 0, corner1.y ?? corner1[1] ?? 0, corner1.z ?? corner1[2] ?? 0,
          corner2.x ?? corner2[0] ?? 0, corner2.y ?? corner2[1] ?? 0, corner2.z ?? corner2[2] ?? 0
        );
      }
      console.error('[p5.tree] visibility: could not parse query.');
      return p5.Tree.INVISIBLE;
    }

    // ── Fallback: user-supplied keyed bounds ───────────────────────────────
    if (center) {
      return radius != null
        ? this._ballVisibility(center, radius, userBounds)
        : this._pointVisibility(center, userBounds);
    }
    if (corner1 && corner2) return this._boxVisibility(corner1, corner2, userBounds);
    console.error('[p5.tree] visibility: could not parse query.');
    return p5.Tree.INVISIBLE;
  };

  // ── Keyed-bounds visibility helpers (fallback path) ───────────────────────

  p5.Renderer3D.prototype._pointVisibility = function (point, bounds) {
    const px = point.x ?? point[0] ?? 0;
    const py = point.y ?? point[1] ?? 0;
    const pz = point.z ?? point[2] ?? 0;
    for (const key in bounds) {
      const { a, b, c, d } = bounds[key];
      const dist = a * px + b * py + c * pz - d;
      if (dist > 0)   return p5.Tree.INVISIBLE;
      if (dist === 0) return p5.Tree.SEMIVISIBLE;
    }
    return p5.Tree.VISIBLE;
  };

  p5.Renderer3D.prototype._ballVisibility = function (center, radius, bounds) {
    const cx = center.x ?? center[0] ?? 0;
    const cy = center.y ?? center[1] ?? 0;
    const cz = center.z ?? center[2] ?? 0;
    let allIn = true;
    for (const key in bounds) {
      const { a, b, c, d } = bounds[key];
      const dist = a * cx + b * cy + c * cz - d;
      if (dist > radius)              return p5.Tree.INVISIBLE;
      if (dist > 0 || -dist < radius) allIn = false;
    }
    return allIn ? p5.Tree.VISIBLE : p5.Tree.SEMIVISIBLE;
  };

  p5.Renderer3D.prototype._boxVisibility = function (corner1, corner2, bounds) {
    const x0 = corner1.x ?? corner1[0] ?? 0, y0 = corner1.y ?? corner1[1] ?? 0, z0 = corner1.z ?? corner1[2] ?? 0;
    const x1 = corner2.x ?? corner2[0] ?? 0, y1 = corner2.y ?? corner2[1] ?? 0, z1 = corner2.z ?? corner2[2] ?? 0;
    let allIn = true;
    for (const key in bounds) {
      const { a, b, c, d } = bounds[key];
      let allOut = true;
      for (let corner = 0; corner < 8; corner++) {
        const cx = (corner & 4) ? x0 : x1;
        const cy = (corner & 2) ? y0 : y1;
        const cz = (corner & 1) ? z0 : z1;
        if (a * cx + b * cy + c * cz - d > 0) { allIn  = false; }
        else                                   { allOut = false; }
      }
      if (allOut) return p5.Tree.INVISIBLE;
    }
    return allIn ? p5.Tree.VISIBLE : p5.Tree.SEMIVISIBLE;
  };

  // ── bounds ────────────────────────────────────────────────────────────────

  /**
   * Compute the six view-frustum planes as a keyed object.
   *
   * Returns `{ [LEFT|RIGHT|NEAR|FAR|TOP|BOTTOM]: { a, b, c, d } }`.
   * For per-object visibility tests prefer calling `visibility()` directly —
   * its fast path bypasses this object entirely.
   *
   * @method bounds
   * @for p5
   * @param {{ eMatrix?: Float32Array | ArrayLike | p5.Matrix }} [opts]
   * @returns {object}
   */
  p5.Renderer3D.prototype.bounds = function ({ eMatrix } = {}) {
    const eRaw = _rawMat4(eMatrix) ?? (mat4Invert(_eye, _viewMat4(this)), _eye);
    _computePlanes(this, eRaw);
    const keys = [p5.Tree.LEFT, p5.Tree.RIGHT, p5.Tree.NEAR, p5.Tree.FAR, p5.Tree.TOP, p5.Tree.BOTTOM];
    const result = {};
    for (let i = 0; i < 6; i++) {
      const b = i * 4;
      result[keys[i]] = { a: _planes[b], b: _planes[b+1], c: _planes[b+2], d: _planes[b+3] };
    }
    return result;
  };

  // ── distanceToBound ───────────────────────────────────────────────────────

  /**
   * Signed distance from a point to one frustum plane.
   * Positive → outside (invisible side).
   *
   * @method distanceToBound
   * @for p5
   * @param {ArrayLike|p5.Vector} point
   * @param {number|string} key  p5.Tree plane constant (LEFT, RIGHT, NEAR, FAR, TOP, BOTTOM).
   * @param {object} [bounds]    Keyed bounds object. Defaults to current frustum.
   * @returns {number}
   */
  p5.Renderer3D.prototype.distanceToBound = function (...args) {
    let point, key, bounds;
    for (const arg of args) {
      if (Array.isArray(arg) || ArrayBuffer.isView(arg) || arg instanceof p5.Vector) { point = arg; }
      else if (typeof arg === 'string' || typeof arg === 'number') { key = arg; }
      else if (arg && typeof arg === 'object') { bounds = arg; }
    }
    if (!point || key === undefined) {
      console.error('[p5.tree] distanceToBound: could not parse query.'); return 0;
    }
    const { a, b, c, d } = (bounds ?? this.bounds())[key];
    const px = point.x ?? point[0] ?? 0;
    const py = point.y ?? point[1] ?? 0;
    const pz = point.z ?? point[2] ?? 0;
    return a * px + b * py + c * pz - d;
  };
}
