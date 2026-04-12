/**
 * @file Visibility — frustum culling bridge: computePlanes, visibility, bounds, distanceToBound.
 * @module p5.tree/visibility
 * @license AGPL-3.0-only
 *
 * Delegates all math to @nakednous/tree. Zero allocations in hot paths.
 *
 * ── Usage pattern ─────────────────────────────────────────────────────────
 *
 *   // setup
 *   m._c1 = new Float32Array(3)
 *   m._c2 = new Float32Array(3)
 *
 *   // draw — zero allocations
 *   m._c1.set([px - hw, py - hh, pz - hd])
 *   m._c2.set([px + hw, py + hh, pz + hd])
 *   m.visibility = p.visibility({ corner1: m._c1, corner2: m._c2 })
 *
 * ── Sign contract ─────────────────────────────────────────────────────────
 *
 * Frustum extents are near-plane coordinates in camera space (y-up, z into
 * screen):
 *
 *   top    > 0   bottom < 0   (y axis)
 *   right  > 0   left   < 0   (x axis)
 *   near, far > 0              (positive distances along −z)
 *
 * All of frustumPlanes, viewFrustum, projTop/projBottom, projLeft/projRight,
 * mat4Proj, mat4Ortho, and p5 v2's frustum()/ortho() share this contract.
 * p5 v2 call order: frustum(left, right, bottom, top, near, far).
 */

'use strict';

import {
  mat4Invert, mat4MulPoint,
  projIsOrtho, projNear, projFar,
  projLeft, projRight, projTop, projBottom,
  frustumPlanes,
  pointVisibility, sphereVisibility, boxVisibility,
} from '@nakednous/tree';

import { getNdcZ } from './matrix.js';

// ═══════════════════════════════════════════════════════════════════════════
// Module-level working buffers — never returned to caller
// ═══════════════════════════════════════════════════════════════════════════

const _eye    = new Float32Array(16);  // eye matrix scratch for computePlanes
const _planes = new Float64Array(24);  // 6 frustum planes × [a,b,c,d]
const _tMin   = new Float32Array(3);   // transformed AABB min scratch
const _tMax   = new Float32Array(3);   // transformed AABB max scratch

// ═══════════════════════════════════════════════════════════════════════════
// Local p5 state accessors
// ═══════════════════════════════════════════════════════════════════════════

const _rawMat4  = (m) => (m != null && m.mat4 != null) ? m.mat4 : m;
const _projMat4 = (r) => r.states.uPMatrix.mat4;
const _viewMat4 = (r) => r.states.curCamera.cameraMatrix.mat4;

// ═══════════════════════════════════════════════════════════════════════════
// computePlanes — exported for gizmos (viewFrustum); not part of public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fill the module-level _planes buffer from the current renderer state.
 * @param {p5.Renderer3D} renderer
 * @param {Float32Array}  [eRaw]  Pre-computed eye matrix — skips inversion.
 * @returns {Float64Array} _planes
 */
export function computePlanes(renderer, eRaw) {
  const view = _viewMat4(renderer);
  const e    = eRaw ?? (mat4Invert(_eye, view), _eye);
  const proj = _projMat4(renderer);
  const ndcZ = getNdcZ();
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
 * Install visibility helpers on fn and p5.Renderer3D.
 * @param {p5}    p5
 * @param {Object} fn  p5 prototype.
 */
export function installVisibility(p5, fn) {

  // ── Public forwarders ─────────────────────────────────────────────────────

  fn.visibility      = function (...args) { return this._renderer.visibility(...args); };
  fn.bounds          = function (opts)    { return this._renderer.bounds(opts); };
  fn.distanceToBound = function (...args) { return this._renderer.distanceToBound(...args); };

  // ── Argument parser ───────────────────────────────────────────────────────

  p5.Renderer3D.prototype._parseVisibilityArgs = function (...args) {
    let corner1, corner2, center, radius, pendingRadius, bounds, mat4Model;
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
          corner1   = arg.corner1 ?? corner1; corner2 = arg.corner2 ?? corner2;
          center    = arg.center  ?? center;  radius  = arg.radius  ?? radius;
          bounds    = arg.bounds  ?? bounds;
          mat4Model = arg.mat4Model ?? mat4Model;
        } else { bounds = arg; }
      }
    }
    if (!corner1 && !corner2) {
      if (!center && vecs.length === 1) { center = vecs[0]; }
      else if (vecs.length >= 2) { corner1 = vecs[0]; corner2 = vecs[1]; }
    }
    if (radius === undefined && pendingRadius !== undefined && center) { radius = pendingRadius; }
    return { corner1, corner2, center, radius, bounds, mat4Model };
  };

  // ── visibility ────────────────────────────────────────────────────────────
  
  /**
   * Test visibility of a point, sphere, or AABB against the view frustum.
   *
   * Three query forms:
   *   visibility({ corner1, corner2 })          // axis-aligned box
   *   visibility({ center, radius })            // sphere
   *   visibility({ center })                    // point
   *
   * All corner/center values accept Float32Array(3), plain array, or p5.Vector.
   *
   * ── mat4Model (optional) ────────────────────────────────────────────────────
   * When supplied, transforms bounds from local/object space to world space
   * before the frustum test. Accepts Float32Array(16) | ArrayLike | p5.Matrix.
   * Useful when bounds are defined in object space and the model matrix is
   * available without a push()/pop() context — mirrors the mat4Model option
   * already accepted by axes(), bullsEye(), and pointerHit().
   *
   *   AABB  → all 8 corners transformed; result is a conservative world-space
   *           AABB (larger than tight OBB — correct for culling, never false negative).
   *   Sphere → center transformed; radius scaled by max column length
   *            (conservative under non-uniform scale).
   *   Point  → straight mat4 × point.
   *
   * ── Performance notes ───────────────────────────────────────────────────────
   * Fast path (no `bounds` option): calls core boxVisibility / sphereVisibility /
   * pointVisibility directly — zero allocations per call.
   * Fallback (user-supplied `bounds` object): scalar arithmetic on the keyed
   * plane object.
   *
   * @method visibility
   * @for p5
   * @param {{
   *   corner1?:   Float32Array | ArrayLike | p5.Vector,
   *   corner2?:   Float32Array | ArrayLike | p5.Vector,
   *   center?:    Float32Array | ArrayLike | p5.Vector,
   *   radius?:    number,
   *   bounds?:    object,
   *   mat4Model?: Float32Array | ArrayLike | p5.Matrix,
   * }} opts
   * @returns {number} p5.Tree.VISIBLE | SEMIVISIBLE | INVISIBLE
   */
  p5.Renderer3D.prototype.visibility = function (...args) {
    const { corner1, corner2, center, radius, bounds: userBounds, mat4Model } = this._parseVisibilityArgs(...args);
    
    // ── Optional model-space → world-space transform ──────────────────────
    // If mat4Model supplied, transform bounds before frustum test.
    // AABB: transform all 8 corners, recompute conservative AABB (zero-alloc).
    // Sphere: transform center; scale radius by max column length.
    // Point: straight mat4MulPoint.
    let c1 = corner1, c2 = corner2, ct = center, rt = radius;
    if (mat4Model != null) {
      const m = _rawMat4(mat4Model);
      if (m != null) {
        if (c1 && c2) {
          // Transform 8 AABB corners, find new min/max
          const x0 = c1.x ?? c1[0] ?? 0, y0 = c1.y ?? c1[1] ?? 0, z0 = c1.z ?? c1[2] ?? 0;
          const x1 = c2.x ?? c2[0] ?? 0, y1 = c2.y ?? c2[1] ?? 0, z1 = c2.z ?? c2[2] ?? 0;
          _tMin[0] =  Infinity; _tMin[1] =  Infinity; _tMin[2] =  Infinity;
          _tMax[0] = -Infinity; _tMax[1] = -Infinity; _tMax[2] = -Infinity;
          for (let i = 0; i < 8; i++) {
            const cx = (i & 4) ? x0 : x1;
            const cy = (i & 2) ? y0 : y1;
            const cz = (i & 1) ? z0 : z1;
            mat4MulPoint(_tMin, m, [cx, cy, cz]);   // reuse _tMin as temp
            if (_tMin[0] < _tMax[0] || i === 0) {}  // update min/max below
            // ── inline to avoid a second scratch ─────────────────────────
            const tx = m[0]*cx + m[4]*cy + m[8]*cz  + m[12];
            const tw = m[3]*cx + m[7]*cy + m[11]*cz + m[15];
            const ty = m[1]*cx + m[5]*cy + m[9]*cz  + m[13];
            const tz = m[2]*cx + m[6]*cy + m[10]*cz + m[14];
            const wx = tx/tw, wy = ty/tw, wz = tz/tw;
            if (i === 0 || wx < _tMin[0]) _tMin[0] = wx;
            if (i === 0 || wy < _tMin[1]) _tMin[1] = wy;
            if (i === 0 || wz < _tMin[2]) _tMin[2] = wz;
            if (i === 0 || wx > _tMax[0]) _tMax[0] = wx;
            if (i === 0 || wy > _tMax[1]) _tMax[1] = wy;
            if (i === 0 || wz > _tMax[2]) _tMax[2] = wz;
          }
          c1 = _tMin; c2 = _tMax;
        } else if (ct) {
          // Transform center
          const cx = ct.x ?? ct[0] ?? 0;
          const cy = ct.y ?? ct[1] ?? 0;
          const cz = ct.z ?? ct[2] ?? 0;
          const tw = m[3]*cx + m[7]*cy + m[11]*cz + m[15];
          _tMin[0] = (m[0]*cx + m[4]*cy + m[8]*cz  + m[12]) / tw;
          _tMin[1] = (m[1]*cx + m[5]*cy + m[9]*cz  + m[13]) / tw;
          _tMin[2] = (m[2]*cx + m[6]*cy + m[10]*cz + m[14]) / tw;
          ct = _tMin;
          if (rt != null) {
            // Scale radius by max column length (conservative under non-uniform scale)
            const s0 = Math.sqrt(m[0]*m[0] + m[1]*m[1] + m[2]*m[2]);
            const s1 = Math.sqrt(m[4]*m[4] + m[5]*m[5] + m[6]*m[6]);
            const s2 = Math.sqrt(m[8]*m[8] + m[9]*m[9] + m[10]*m[10]);
            rt = rt * Math.max(s0, s1, s2);
          }
        }
      }
    }

    if (!userBounds) {
      const planes = computePlanes(this);
      if (ct) {
        const cx = ct.x ?? ct[0] ?? 0;
        const cy = ct.y ?? ct[1] ?? 0;
        const cz = ct.z ?? ct[2] ?? 0;
        return rt != null
          ? sphereVisibility(planes, cx, cy, cz, rt)
          : pointVisibility(planes, cx, cy, cz);
      }
      if (c1 && c2) {
        return boxVisibility(
          planes,
          c1.x ?? c1[0] ?? 0, c1.y ?? c1[1] ?? 0, c1.z ?? c1[2] ?? 0,
          c2.x ?? c2[0] ?? 0, c2.y ?? c2[1] ?? 0, c2.z ?? c2[2] ?? 0
        );
      }
      console.error('[p5.tree] visibility: could not parse query.');
      return p5.Tree.INVISIBLE;
    }

    // ── Fallback: user-supplied keyed bounds ───────────────────────────────
    if (ct) {
      return rt != null
        ? this._ballVisibility(ct, rt, userBounds)
        : this._pointVisibility(ct, userBounds);
    }
    if (c1 && c2) return this._boxVisibility(c1, c2, userBounds);
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
   * @param {{ mat4Eye?: Float32Array | ArrayLike | p5.Matrix }} [opts]
   * @returns {object}
   */
  p5.Renderer3D.prototype.bounds = function ({ mat4Eye } = {}) {
    const eRaw = _rawMat4(mat4Eye) ?? (mat4Invert(_eye, _viewMat4(this)), _eye);
    computePlanes(this, eRaw);
    const keys   = [p5.Tree.LEFT, p5.Tree.RIGHT, p5.Tree.NEAR, p5.Tree.FAR, p5.Tree.TOP, p5.Tree.BOTTOM];
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
