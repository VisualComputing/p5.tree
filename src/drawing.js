/**
 * @file Drawing helpers, picking, view frustum display, and visibility queries.
 * @module p5.tree/drawing
 * @license GPL-3.0-only
 *
 * Depends on p5.tree/matrix (uses mapLocation, pixelRatio, beginHUD/endHUD,
 * isOrtho, plane queries, p5.Tree constants).
 */

'use strict';

export function installDrawing(p5, fn) {

  // ── Axes ────────────────────────────────────────────────────────────────

  fn.axes = function (opts) { this._renderer.axes(opts); return this; };

  p5.Renderer3D.prototype.axes = function ({
    size = 100,
    colors = ['Red', 'Lime', 'DodgerBlue'],
    bits = p5.Tree.LABELS | p5.Tree.X | p5.Tree.Y | p5.Tree.Z
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    p.push();
    if ((bits & p5.Tree.LABELS) !== 0) {
      const charWidth = size / 40.0, charHeight = size / 30.0, charShift = 1.04 * size;
      p.stroke(colors[0 % colors.length]);
      p.line(charShift, charWidth, -charHeight, charShift, -charWidth, charHeight);
      p.line(charShift, -charWidth, -charHeight, charShift, charWidth, charHeight);
      p.stroke(colors[1 % colors.length]);
      p.line(charWidth, charShift, charHeight, 0, charShift, 0);
      p.line(0, charShift, 0, -charWidth, charShift, charHeight);
      p.line(-charWidth, charShift, charHeight, 0, charShift, 0);
      p.line(0, charShift, 0, 0, charShift, -charHeight);
      p.stroke(colors[2 % colors.length]);
      p.line(-charWidth, -charHeight, charShift, charWidth, -charHeight, charShift);
      p.line(charWidth, -charHeight, charShift, -charWidth, charHeight, charShift);
      p.line(-charWidth, charHeight, charShift, charWidth, charHeight, charShift);
    }
    p.stroke(colors[0 % colors.length]);
    (bits & p5.Tree.X) !== 0 && p.line(0, 0, 0, size, 0, 0);
    (bits & p5.Tree._X) !== 0 && p.line(0, 0, 0, -size, 0, 0);
    p.stroke(colors[1 % colors.length]);
    (bits & p5.Tree.Y) !== 0 && p.line(0, 0, 0, 0, size, 0);
    (bits & p5.Tree._Y) !== 0 && p.line(0, 0, 0, 0, -size, 0);
    p.stroke(colors[2 % colors.length]);
    (bits & p5.Tree.Z) !== 0 && p.line(0, 0, 0, 0, 0, size);
    (bits & p5.Tree._Z) !== 0 && p.line(0, 0, 0, 0, 0, -size);
    p.pop();
  };

  // ── Grid ────────────────────────────────────────────────────────────────

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

  // ── Picking ─────────────────────────────────────────────────────────────

  fn.mousePicking = function (opts) { return this._renderer.mousePicking(opts); };
  fn.pointerPicking = function (...args) { return this._renderer.pointerPicking(...args); };

  p5.Renderer3D.prototype.mousePicking = function ({
    mMatrix = this.mMatrix(), x, y, size = 50, shape = p5.Tree.CIRCLE,
    eMatrix, pMatrix, vMatrix, pvMatrix
  } = {}) {
    const p = this._pInst;
    if (!p) return false;
    return this.pointerPicking(p.mouseX, p.mouseY, { mMatrix, x, y, size, shape, eMatrix, pMatrix, vMatrix, pvMatrix });
  };

  p5.Renderer3D.prototype.pointerPicking = function (...args) {
    let pointerX, pointerY;
    const config = {};
    for (const arg of args) {
      if (typeof arg === 'number' && Number.isFinite(arg)) {
        pointerX == null ? pointerX = arg : pointerY = arg;
      } else if (arg && typeof arg === 'object') { Object.assign(config, arg); }
    }
    const p = this._pInst;
    if (pointerX == null) pointerX = p ? p.mouseX : this.width / 2;
    if (pointerY == null) pointerY = p ? p.mouseY : this.height / 2;
    let { mMatrix = this.mMatrix(), x, y, size = 50, shape = p5.Tree.CIRCLE,
      eMatrix, pMatrix, vMatrix, pvMatrix } = config;
    if (x == null || y == null) {
      const screen = this.mapLocation({ from: mMatrix, to: p5.Tree.SCREEN, pMatrix, vMatrix, pvMatrix });
      x = screen.x; y = screen.y;
      const world = this.mapLocation({ from: mMatrix, to: p5.Tree.WORLD, eMatrix });
      size = size / this.pixelRatio(world);
    }
    const r = size / 2.0, dx = x - pointerX, dy = y - pointerY;
    return shape === p5.Tree.CIRCLE ? Math.sqrt(dx * dx + dy * dy) < r : (Math.abs(dx) < r && Math.abs(dy) < r);
  };

  // ── Circle primitive ────────────────────────────────────────────────────

  p5.Renderer3D.prototype._circle = function ({
    filled = false, x = this.width / 2, y = this.height / 2, radius = 100, detail = 50
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    p.push(); p.translate(x, y);
    if (filled) {
      p.beginShape(p.TRIANGLE_STRIP);
      for (let t = 0; t <= detail; t++) {
        const cx = Math.cos(t * (2 * Math.PI) / detail), cy = Math.sin(t * (2 * Math.PI) / detail);
        p.vertex(0, 0, 0, 0.5, 0.5);
        p.vertex(radius * cx, radius * cy, 0, (cx * 0.5) + 0.5, (cy * 0.5) + 0.5);
      }
      p.endShape();
    } else {
      const angle = (2 * Math.PI) / detail;
      let last = { x: radius, y: 0 };
      for (let i = 1; i <= detail; i++) {
        const pos = { x: Math.cos(i * angle) * radius, y: Math.sin(i * angle) * radius };
        p.line(last.x, last.y, pos.x, pos.y); last = pos;
      }
    }
    p.pop();
  };

  // ── Cross / BullsEye ───────────────────────────────────────────────────

  fn.cross = function (opts) { this._renderer.cross(opts); return this; };

  p5.Renderer3D.prototype.cross = function ({
    mMatrix = this.mMatrix(), x, y, size = 50, eMatrix, pMatrix, vMatrix, pvMatrix
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    if (x == null || y == null) {
      const screen = this.mapLocation({ from: mMatrix, to: p5.Tree.SCREEN, pMatrix, vMatrix, pvMatrix });
      x = screen.x; y = screen.y;
      const world = this.mapLocation({ from: mMatrix, to: p5.Tree.WORLD, eMatrix });
      size = size / this.pixelRatio(world);
    }
    const half = size / 2.0;
    this.beginHUD();
    p.line(x - half, y, x + half, y);
    p.line(x, y - half, x, y + half);
    this.endHUD();
  };

  fn.bullsEye = function (opts) { this._renderer.bullsEye(opts); return this; };

  p5.Renderer3D.prototype.bullsEye = function ({
    mMatrix = this.mMatrix(), x, y, size = 50, shape = p5.Tree.CIRCLE,
    eMatrix, pMatrix, vMatrix, pvMatrix
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    if (x == null || y == null) {
      const screen = this.mapLocation({ from: mMatrix, to: p5.Tree.SCREEN, pMatrix, vMatrix, pvMatrix });
      x = screen.x; y = screen.y;
      const world = this.mapLocation({ from: mMatrix, to: p5.Tree.WORLD, eMatrix });
      size = size / this.pixelRatio(world);
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
    const crossHalf = 0.6 * half;
    p.line(x - crossHalf, y, x + crossHalf, y);
    p.line(x, y - crossHalf, x, y + crossHalf);
    this.endHUD();
  };

  // ── View frustum ───────────────────────────────────────────────────────

  fn.viewFrustum = function (opts) { this._renderer.viewFrustum(opts); return this; };

  p5.Renderer3D.prototype.viewFrustum = function ({
    vMatrix = this.vMatrix(), pg, eMatrix = pg?.eMatrix(), pMatrix = pg?.pMatrix(),
    bits = p5.Tree.NEAR | p5.Tree.FAR,
    viewer = () => this.axes({ size: 50, bits: p5.Tree.X | p5.Tree._X | p5.Tree.Y | p5.Tree._Y | p5.Tree.Z | p5.Tree._Z })
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    if (this === pg) { console.error('displaying viewFrustum requires a pg different than this'); return; }
    if (!pMatrix || !eMatrix) { console.error('displaying viewFrustum requires either a pg or projection and eye matrices'); return; }
    const states = this.states, uView = states?.uViewMatrix;
    if (!uView) return;
    p.push(); p.resetMatrix();
    const prevView = uView.copy();
    uView.set(vMatrix);
    this.applyMatrix(...eMatrix.mat4);
    typeof viewer === 'function' && viewer();
    const isOrtho = pMatrix.isOrtho();
    const apex = !isOrtho && ((bits & p5.Tree.APEX) !== 0);
    const n = -pMatrix.nPlane(), f = -pMatrix.fPlane();
    const l = pMatrix.lPlane(), r = pMatrix.rPlane();
    const t = isOrtho ? -pMatrix.tPlane() : pMatrix.tPlane();
    const b = isOrtho ? -pMatrix.bPlane() : pMatrix.bPlane();
    const ratio = isOrtho ? 1 : f / n;
    const _l = ratio * l, _r = ratio * r, _b = ratio * b, _t = ratio * t;
    if ((bits & p5.Tree.FAR) !== 0) {
      this.beginShape(); this.vertex(_l, _t, f); this.vertex(_r, _t, f); this.vertex(_r, _b, f); this.vertex(_l, _b, f); this.endShape(p.CLOSE);
    } else {
      this.line(_l, _t, f, _r, _t, f); this.line(_r, _t, f, _r, _b, f); this.line(_r, _b, f, _l, _b, f); this.line(_l, _b, f, _l, _t, f);
    }
    if ((bits & p5.Tree.BODY) !== 0) {
      this.beginShape(); this.vertex(_l, _t, f); this.vertex(l, t, n); this.vertex(r, t, n); this.vertex(_r, _t, f); this.endShape();
      this.beginShape(); this.vertex(_r, _t, f); this.vertex(r, t, n); this.vertex(r, b, n); this.vertex(_r, _b, f); this.endShape();
      this.beginShape(); this.vertex(_r, _b, f); this.vertex(r, b, n); this.vertex(l, b, n); this.vertex(_l, _b, f); this.endShape();
      this.beginShape(); this.vertex(l, t, n); this.vertex(_l, _t, f); this.vertex(_l, _b, f); this.vertex(l, b, n); this.endShape();
      if (apex) {
        this.line(0, 0, 0, r, t, n); this.line(0, 0, 0, l, t, n);
        this.line(0, 0, 0, l, b, n); this.line(0, 0, 0, r, b, n);
      }
    } else {
      this.line(apex ? 0 : r, apex ? 0 : t, apex ? 0 : n, _r, _t, f);
      this.line(apex ? 0 : l, apex ? 0 : t, apex ? 0 : n, _l, _t, f);
      this.line(apex ? 0 : l, apex ? 0 : b, apex ? 0 : n, _l, _b, f);
      this.line(apex ? 0 : r, apex ? 0 : b, apex ? 0 : n, _r, _b, f);
    }
    if ((bits & p5.Tree.NEAR) !== 0) {
      this.beginShape(); this.vertex(l, t, n); this.vertex(r, t, n); this.vertex(r, b, n); this.vertex(l, b, n); this.endShape(p.CLOSE);
    } else {
      this.line(l, t, n, r, t, n); this.line(r, t, n, r, b, n); this.line(r, b, n, l, b, n); this.line(l, b, n, l, t, n);
    }
    uView.set(prevView);
    p.pop();
  };

  // ── Visibility ─────────────────────────────────────────────────────────

  fn.visibility = function (...args) { return this._renderer.visibility(...args); };
  fn.bounds = function (opts = {}) { return this._renderer.bounds(opts); };
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
      if (arg instanceof p5.Vector || Array.isArray(arg)) { vecs.push(arg); continue; }
      if (typeof arg === 'number' && Number.isFinite(arg) && radius === undefined) {
        center ? (radius = arg) : (pendingRadius = arg); continue;
      }
      if (isPlainObject(arg)) {
        if ('corner1' in arg || 'corner2' in arg || 'center' in arg || 'radius' in arg || 'bounds' in arg) {
          corner1 = arg.corner1 ?? corner1; corner2 = arg.corner2 ?? corner2;
          center = arg.center ?? center; radius = arg.radius ?? radius; bounds = arg.bounds ?? bounds;
        } else { bounds = arg; }
      }
    }
    if (!corner1 && !corner2) {
      if (!center && vecs.length === 1) { center = vecs[0]; }
      else if (!corner1 && !corner2 && vecs.length >= 2) { corner1 = vecs[0]; corner2 = vecs[1]; }
    }
    if (radius === undefined && pendingRadius !== undefined && center) { radius = pendingRadius; }
    return { corner1, corner2, center, radius, bounds };
  };

  p5.Renderer3D.prototype.visibility = function (...args) {
    const { corner1, corner2, center, radius, bounds } = this._parseVisibilityArgs(...args);
    const b = bounds ?? this.bounds();
    return center
      ? (radius ? this._ballVisibility(center, radius, b) : this._pointVisibility(center, b))
      : (corner1 && corner2
        ? this._boxVisibility(corner1, corner2, b)
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
    const asVec3 = v => v instanceof p5.Vector ? v : new p5.Vector(v?.[0] ?? 0, v?.[1] ?? 0, v?.[2] ?? 0);
    corner1 = asVec3(corner1); corner2 = asVec3(corner2);
    let allInForAllPlanes = true;
    for (const key in bounds) {
      let allOut = true;
      for (let c = 0; c < 8; ++c) {
        const pos = new p5.Vector(
          (c & 4) !== 0 ? corner1.x : corner2.x,
          (c & 2) !== 0 ? corner1.y : corner2.y,
          (c & 1) !== 0 ? corner1.z : corner2.z
        );
        if (this.distanceToBound(pos, key, bounds) > 0) { allInForAllPlanes = false; }
        else { allOut = false; }
      }
      if (allOut) return p5.Tree.INVISIBLE;
    }
    return allInForAllPlanes ? p5.Tree.VISIBLE : p5.Tree.SEMIVISIBLE;
  };

  p5.Renderer3D.prototype.bounds = function ({ vMatrix, eMatrix } = {}) {
    const n = this.nPlane(), f = this.fPlane(), l = this.lPlane(), r = this.rPlane();
    const b = this.bPlane(), t = this.tPlane();
    const normals = Array(6), distances = Array(6);
    const pos = this.mapLocation([0, 0, 0], { from: p5.Tree.EYE, to: p5.Tree.WORLD, eMatrix });
    const viewDir = this.mapDirection([0, 0, -1], { from: p5.Tree.EYE, to: p5.Tree.WORLD, vMatrix });
    const up = this.mapDirection([0, 1, 0], { from: p5.Tree.EYE, to: p5.Tree.WORLD, vMatrix });
    const right = this.mapDirection([1, 0, 0], { from: p5.Tree.EYE, to: p5.Tree.WORLD, vMatrix });
    const posViewDir = p5.Vector.dot(pos, viewDir);
    if (this.isOrtho()) {
      normals[0] = p5.Vector.mult(right, -1); normals[1] = right;
      normals[4] = up; normals[5] = p5.Vector.mult(up, -1);
      distances[0] = p5.Vector.dot(p5.Vector.sub(pos, p5.Vector.mult(right, -l)), normals[0]);
      distances[1] = p5.Vector.dot(p5.Vector.add(pos, p5.Vector.mult(right, r)), normals[1]);
      distances[4] = p5.Vector.dot(p5.Vector.add(pos, p5.Vector.mult(up, -b)), normals[4]);
      distances[5] = p5.Vector.dot(p5.Vector.sub(pos, p5.Vector.mult(up, t)), normals[5]);
    } else {
      const hfovr = Math.atan2(r, n), shfovr = Math.sin(hfovr), chfovr = Math.cos(hfovr);
      const hfovl = Math.atan2(l, n), shfovl = Math.sin(hfovl), chfovl = Math.cos(hfovl);
      normals[0] = p5.Vector.add(p5.Vector.mult(viewDir, shfovl), p5.Vector.mult(right, -chfovl));
      normals[1] = p5.Vector.add(p5.Vector.mult(viewDir, -shfovr), p5.Vector.mult(right, chfovr));
      const fovt = Math.atan2(t, n), sfovt = Math.sin(fovt), cfovt = Math.cos(fovt);
      const fovb = Math.atan2(b, n), sfovb = Math.sin(fovb), cfovb = Math.cos(fovb);
      normals[4] = p5.Vector.add(p5.Vector.mult(viewDir, -sfovt), p5.Vector.mult(up, cfovt));
      normals[5] = p5.Vector.add(p5.Vector.mult(viewDir, sfovb), p5.Vector.mult(up, -cfovb));
      distances[0] = shfovl * posViewDir - chfovl * p5.Vector.dot(pos, right);
      distances[1] = -shfovr * posViewDir + chfovr * p5.Vector.dot(pos, right);
      distances[4] = -sfovt * posViewDir + cfovt * p5.Vector.dot(pos, up);
      distances[5] = sfovb * posViewDir - cfovb * p5.Vector.dot(pos, up);
    }
    normals[2] = p5.Vector.mult(viewDir, -1); normals[3] = viewDir;
    distances[2] = -posViewDir - n; distances[3] = posViewDir + f;
    const bounds = {};
    bounds[p5.Tree.LEFT] = { a: normals[0].x, b: normals[0].y, c: normals[0].z, d: distances[0] };
    bounds[p5.Tree.RIGHT] = { a: normals[1].x, b: normals[1].y, c: normals[1].z, d: distances[1] };
    bounds[p5.Tree.NEAR] = { a: normals[2].x, b: normals[2].y, c: normals[2].z, d: distances[2] };
    bounds[p5.Tree.FAR] = { a: normals[3].x, b: normals[3].y, c: normals[3].z, d: distances[3] };
    bounds[p5.Tree.TOP] = { a: normals[4].x, b: normals[4].y, c: normals[4].z, d: distances[4] };
    bounds[p5.Tree.BOTTOM] = { a: normals[5].x, b: normals[5].y, c: normals[5].z, d: distances[5] };
    return bounds;
  };

  p5.Renderer3D.prototype.distanceToBound = function (...args) {
    let point, key, bounds = this.bounds();
    const asVec3 = v => v instanceof p5.Vector ? v : new p5.Vector(v?.[0] ?? 0, v?.[1] ?? 0, v?.[2] ?? 0);
    for (const arg of args) {
      if (arg instanceof p5.Vector || Array.isArray(arg)) { point = asVec3(arg); }
      else if (typeof arg === 'string' || typeof arg === 'number') { key = arg; }
      else if (arg && typeof arg === 'object' && !Array.isArray(arg)) { bounds = arg; }
    }
    if (!point || key === undefined) { console.error('[p5.tree] distanceToBound: could not parse query.'); return 0; }
    const eq = bounds[key];
    return p5.Vector.dot(point, new p5.Vector(eq.a, eq.b, eq.c)) - eq.d;
  };
}
