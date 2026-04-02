/**
 * @file Gizmos — scene-space diagnostic helpers: axes, grid, cross, bullsEye, viewFrustum.
 * @module p5.tree/gizmos
 * @license AGPL-3.0-only
 *
 * Depends on p5.tree/hud (beginHUD / endHUD), p5.tree/matrix (mapLocation,
 * pixelRatio, p5.Tree constants), and p5.tree/visibility (computePlanes).
 *
 * All internal calls to mapLocation write into module-level Float32Array
 * buffers — no p5.Vector allocations anywhere.
 */

'use strict';

import {
  projIsOrtho, projNear, projFar,
  projLeft, projRight, projTop, projBottom,
} from '@nakednous/tree';

import { getNdcZ } from './matrix.js';

import { computePlanes } from './visibility.js';

// ═══════════════════════════════════════════════════════════════════════════
// Module-level working buffers — never returned to caller
// ═══════════════════════════════════════════════════════════════════════════

const _sl  = new Float32Array(3);   // screen location (cross, bullsEye)
const _wl  = new Float32Array(3);   // world location  (pixelRatio input)
const _eye = new Float32Array(16);  // eye matrix scratch for viewFrustum

// ═══════════════════════════════════════════════════════════════════════════
// Local p5 state accessors
// ═══════════════════════════════════════════════════════════════════════════

const _rawMat4   = (m) => (m != null && m.mat4 != null) ? m.mat4 : m;
const _projMat4  = (r) => r.states.uPMatrix.mat4;
const _viewMat4  = (r) => r.states.curCamera.cameraMatrix.mat4;
const _modelMat4 = (r) => r.states.uModelMatrix.mat4;

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
   *   mat4Model?:  Float32Array | ArrayLike | p5.Matrix,
   *   x?, y?,
   *   size?:       number,
   *   mat4Eye?:    Float32Array | ArrayLike | p5.Matrix,
   *   mat4Proj?:   Float32Array | ArrayLike | p5.Matrix,
   *   mat4View?:   Float32Array | ArrayLike | p5.Matrix,
   *   mat4PV?:     Float32Array | ArrayLike | p5.Matrix,
   * }} [opts]
   */
  p5.Renderer3D.prototype.cross = function ({
    mat4Model, x, y, size = 50, mat4Eye, mat4Proj, mat4View, mat4PV
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    const mm = _rawMat4(mat4Model) ?? _modelMat4(this);
    if (x == null || y == null) {
      this.mapLocation(_sl, p5.Tree.ORIGIN, { from: mm, to: p5.Tree.SCREEN, mat4Proj, mat4View, mat4PV });
      x = _sl[0]; y = _sl[1];
      this.mapLocation(_wl, p5.Tree.ORIGIN, { from: mm, to: p5.Tree.WORLD, mat4Eye });
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
   *   mat4Model?:  Float32Array | ArrayLike | p5.Matrix,
   *   x?, y?,
   *   size?:       number,
   *   shape?:      number,
   *   mat4Eye?:    Float32Array | ArrayLike | p5.Matrix,
   *   mat4Proj?:   Float32Array | ArrayLike | p5.Matrix,
   *   mat4View?:   Float32Array | ArrayLike | p5.Matrix,
   *   mat4PV?:     Float32Array | ArrayLike | p5.Matrix,
   * }} [opts]
   */
  p5.Renderer3D.prototype.bullsEye = function ({
    mat4Model, x, y, size = 50, shape = p5.Tree.CIRCLE,
    mat4Eye, mat4Proj, mat4View, mat4PV
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    const mm = _rawMat4(mat4Model) ?? _modelMat4(this);
    if (x == null || y == null) {
      this.mapLocation(_sl, p5.Tree.ORIGIN, { from: mm, to: p5.Tree.SCREEN, mat4Proj, mat4View, mat4PV });
      x = _sl[0]; y = _sl[1];
      this.mapLocation(_wl, p5.Tree.ORIGIN, { from: mm, to: p5.Tree.WORLD, mat4Eye });
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
   *   mat4Eye?:   Float32Array | ArrayLike | p5.Matrix,
   *   mat4Proj?:  Float32Array | ArrayLike | p5.Matrix,
   *   mat4View?:  Float32Array | ArrayLike | p5.Matrix,
   *   bits?:      number,
   *   viewer?:    function,
   * }} [opts]
   */
  p5.Renderer3D.prototype.viewFrustum = function ({
    pg,
    mat4Eye,
    mat4Proj,
    mat4View,
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

    const eRaw = _rawMat4(mat4Eye) ?? (pg ? (pg._renderer.mat4Eye(_eye), _eye) : null);
    const pRaw = _rawMat4(mat4Proj) ?? (pg ? _projMat4(pg._renderer) : null);

    if (!pRaw || !eRaw) {
      console.error('displaying viewFrustum requires either a pg or both mat4Eye and mat4Proj'); return;
    }

    const states = this.states, uView = states?.uViewMatrix;
    if (!uView) return;

    const vRaw = _rawMat4(mat4View) ?? _viewMat4(this);

    const isOrtho = projIsOrtho(pRaw);
    const ndcZ    = getNdcZ();
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
}
