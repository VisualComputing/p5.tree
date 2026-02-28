/**
 * @file TransformTrack, quaternion/spline helpers, adapters, and camera path API.
 * @module track
 * @license GPL-3.0-only
 *
 * Architecture:
 *   - Minimal quaternion math (flat [x,y,z,w] arrays, w-last = glTF layout)
 *   - Centripetal Catmull-Rom spline (α=0.5, Barry-Goldman)
 *   - TransformTrack: generic keyframe track storing {pos, rot, scl}
 *   - CameraAdapter: captures/applies transforms on p5.Camera via slerp
 *   - Camera path public API: addPath, playPath, stopPath, resetPath, seekPath, pathTime, pathInfo
 *   - Global fn.* forwarders to active camera
 *
 * Exports:
 *   installTrack(p5, fn) — installs everything onto p5/fn prototypes
 *   tickPlayers(pInst)   — called from lifecycles.predraw
 *   clearPlayers(pInst)  — called from lifecycles.remove
 */

'use strict';

// ===========================================================================
// §1  Minimal quaternion helpers  (flat [x, y, z, w])
// ===========================================================================

/** @type {number[]} */
const QUAT_IDENTITY = [0, 0, 0, 1];

const qSet = (out, x, y, z, w) => { out[0] = x; out[1] = y; out[2] = z; out[3] = w; return out; };
const qCopy = (out, a) => { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3]; return out; };
const qDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

const qNormalize = (out) => {
  const len = Math.sqrt(qDot(out, out)) || 1;
  out[0] /= len; out[1] /= len; out[2] /= len; out[3] /= len;
  return out;
};

const qNegate = (out) => { out[0] = -out[0]; out[1] = -out[1]; out[2] = -out[2]; out[3] = -out[3]; return out; };

/** out = a * b */
const qMul = (out, a, b) => {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
};

/**
 * SLERP between quaternions a and b at parameter t.
 * Shortest-arc: negates b if dot < 0.
 * Near-equal fallback: nlerp when dot ≈ 1.
 */
const qSlerp = (out, a, b, t) => {
  let d = qDot(a, b);
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  if (d < 0) { d = -d; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (d > 0.9995) {
    out[0] = a[0] + t * (bx - a[0]);
    out[1] = a[1] + t * (by - a[1]);
    out[2] = a[2] + t * (bz - a[2]);
    out[3] = a[3] + t * (bw - a[3]);
    return qNormalize(out);
  }
  const theta = Math.acos(d);
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  out[0] = wa * a[0] + wb * bx;
  out[1] = wa * a[1] + wb * by;
  out[2] = wa * a[2] + wb * bz;
  out[3] = wa * a[3] + wb * bw;
  return out;
};

/** Quaternion from axis-angle. */
const qFromAxisAngle = (out, ax, ay, az, angle) => {
  const half = angle * 0.5;
  const s = Math.sin(half);
  const len = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
  out[0] = (ax / len) * s; out[1] = (ay / len) * s; out[2] = (az / len) * s;
  out[3] = Math.cos(half);
  return out;
};

/** Quaternion from look direction (forward = -Z convention). */
const qFromLookDir = (out, dir, up) => {
  const ux = up ? up[0] : 0, uy = up ? up[1] : 1, uz = up ? up[2] : 0;
  let fx = -dir[0], fy = -dir[1], fz = -dir[2];
  let fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;
  let rx = uy * fz - uz * fy, ry = uz * fx - ux * fz, rz = ux * fy - uy * fx;
  let rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  const uux = fy * rz - fz * ry, uuy = fz * rx - fx * rz, uuz = fx * ry - fy * rx;
  return qFromRotMat3x3(out, rx, uux, fx, ry, uuy, fy, rz, uuz, fz);
};

/** Quaternion from 3×3 rotation matrix columns (col-major). Shepperd's method. */
const qFromRotMat3x3 = (out, m00, m01, m02, m10, m11, m12, m20, m21, m22) => {
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    out[3] = 0.25 / s; out[0] = (m21 - m12) * s; out[1] = (m02 - m20) * s; out[2] = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    out[3] = (m21 - m12) / s; out[0] = 0.25 * s; out[1] = (m01 + m10) / s; out[2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    out[3] = (m02 - m20) / s; out[0] = (m01 + m10) / s; out[1] = 0.25 * s; out[2] = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    out[3] = (m10 - m01) / s; out[0] = (m02 + m20) / s; out[1] = (m12 + m21) / s; out[2] = 0.25 * s;
  }
  return qNormalize(out);
};

/** Quaternion from column-major 4×4 matrix (rotation part, no shear). */
const qFromMat4 = (out, m) => {
  let c0x = m[0], c0y = m[1], c0z = m[2];
  let c1x = m[4], c1y = m[5], c1z = m[6];
  let c2x = m[8], c2y = m[9], c2z = m[10];
  let l = Math.sqrt(c0x * c0x + c0y * c0y + c0z * c0z) || 1; c0x /= l; c0y /= l; c0z /= l;
  l = Math.sqrt(c1x * c1x + c1y * c1y + c1z * c1z) || 1; c1x /= l; c1y /= l; c1z /= l;
  l = Math.sqrt(c2x * c2x + c2y * c2y + c2z * c2z) || 1; c2x /= l; c2y /= l; c2z /= l;
  return qFromRotMat3x3(out, c0x, c1x, c2x, c0y, c1y, c2y, c0z, c1z, c2z);
};

/** Convert quaternion to column-major 4×4 matrix (rotation only). */
const qToMat4 = (out, q) => {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = 1 - (yy + zz); out[1] = xy + wz;       out[2] = xz - wy;       out[3] = 0;
  out[4] = xy - wz;       out[5] = 1 - (xx + zz); out[6] = yz + wx;       out[7] = 0;
  out[8] = xz + wy;       out[9] = yz - wx;       out[10] = 1 - (xx + yy); out[11] = 0;
  out[12] = 0;             out[13] = 0;             out[14] = 0;             out[15] = 1;
  return out;
};

// ===========================================================================
// §2  Spline helpers
// ===========================================================================

/**
 * Centripetal Catmull-Rom for vec3 (α=0.5, Barry-Goldman).
 * Requires 4 control points. Clamped endpoints handled by caller.
 */
const catmullRomVec3 = (out, p0, p1, p2, p3, t) => {
  const chordLen = (a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    return Math.sqrt(Math.sqrt(dx * dx + dy * dy + dz * dz)) || 1e-6;
  };
  const dt0 = chordLen(p0, p1), dt1 = chordLen(p1, p2), dt2 = chordLen(p2, p3);
  const t1 = dt0, t2 = t1 + dt1, t3 = t2 + dt2;
  const tt = t1 + t * (t2 - t1);
  for (let i = 0; i < 3; i++) {
    const a1 = (t1 - tt) / (t1) * p0[i] + (tt) / (t1) * p1[i];
    const a2 = (t2 - tt) / (dt1) * p1[i] + (tt - t1) / (dt1) * p2[i];
    const a3 = (t3 - tt) / (dt2) * p2[i] + (tt - t2) / (dt2) * p3[i];
    const b1 = (t2 - tt) / (t2) * a1 + (tt) / (t2) * a2;
    const b2 = (t3 - tt) / (t3 - t1) * a2 + (tt - t1) / (t3 - t1) * a3;
    out[i] = (t2 - tt) / (dt1) * b1 + (tt - t1) / (dt1) * b2;
  }
  return out;
};

/** Linear interpolation for vec3. */
const lerpVec3 = (out, a, b, t) => {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
};

// ===========================================================================
// §3  TransformTrack
// ===========================================================================

/**
 * Generic transform keyframe track with playback state.
 * Keyframes store canonical `{ pos:[x,y,z], rot:[x,y,z,w], scl:[sx,sy,sz] }`.
 * @class TransformTrack
 */
class TransformTrack {
  constructor() {
    /** @type {Array<{pos:number[], rot:number[], scl:number[]}>} */
    this.keyframes = [];
    this.playing = false;
    this.loop = false;
    this.pingPong = false;
    this.onEnd = undefined;
    this.rate = 1;
    this.duration = 30;
    this.seg = 0;
    this.f = 0;
    /** @type {'catmullrom'|'linear'} */
    this.posInterp = 'catmullrom';
    this._pos = [0, 0, 0];
    this._rot = [0, 0, 0, 1];
    this._scl = [1, 1, 1];
  }

  get segments() { return Math.max(0, this.keyframes.length - 1); }

  /**
   * Add a keyframe from a transform spec.
   * @param {Object} spec  { pos, rot, scl } (flexible input shapes)
   * @param {Object} [opts]
   * @param {boolean} [opts.deduplicate=true]
   */
  addKeyframe(spec, opts) {
    const kf = _parseSpec(spec);
    if (!kf) return;
    const dedup = !opts || opts.deduplicate !== false;
    if (dedup && this.keyframes.length > 0) {
      if (_sameTransform(this.keyframes[this.keyframes.length - 1], kf)) return;
    }
    this.keyframes.push(kf);
  }

  /**
   * Start or update playback.
   * @param {number|Object} [rateOrOpts]
   */
  play(rateOrOpts) {
    const prevDir = this.rate >= 0 ? 1 : -1;
    const nSeg = this.segments;
    if (this.keyframes.length <= 1) { this.playing = false; return; }
    if (typeof rateOrOpts === 'number' && isFinite(rateOrOpts)) {
      this.rate = rateOrOpts;
    } else if (rateOrOpts && typeof rateOrOpts === 'object') {
      const o = rateOrOpts;
      if (_isNum(o.duration)) this.duration = o.duration;
      this.loop = !!o.loop;
      this.pingPong = !!o.pingPong;
      if (typeof o.onEnd === 'function') this.onEnd = o.onEnd;
      if (_isNum(o.rate)) this.rate = o.rate;
    }
    if (this.rate === 0) { this.playing = false; return; }
    const dur = Math.max(1, this.duration | 0);
    if (this.seg < 0) this.seg = 0; else if (this.seg >= nSeg) this.seg = nSeg - 1;
    if (this.f < 0) this.f = 0; else if (this.f > dur) this.f = dur;
    const dir = this.rate >= 0 ? 1 : -1;
    if (dir !== prevDir) this.f = dur - this.f;
    this.playing = true;
  }

  /** Stop playback. Does NOT reset time unless `reset` is true. */
  stop(reset) {
    this.playing = false;
    if (!reset) return;
    if (this.keyframes.length <= 1) return;
    this.seekGlobal(this.rate < 0 ? 1 : 0);
  }

  /** Clear all keyframes and reset cursor. */
  reset() {
    this.playing = false;
    this.keyframes.length = 0;
    this.seg = 0;
    this.f = 0;
  }

  /** Seek to normalized global time t ∈ [0,1]. */
  seekGlobal(t) {
    const nSeg = this.segments;
    if (nSeg === 0) return;
    const tt = _clamp01(t);
    const dur = Math.max(1, this.duration | 0);
    if (tt === 1) { this.seg = nSeg - 1; this.f = dur; return; }
    const x = tt * nSeg;
    this.seg = Math.min(nSeg - 1, Math.floor(x));
    this.f = Math.round((x - this.seg) * dur);
  }

  /** Seek within a specific segment. */
  seekSegment(amt, segIndex) {
    const nSeg = this.segments;
    if (nSeg === 0) return;
    this.seg = Math.max(0, Math.min(segIndex | 0, nSeg - 1));
    this.f = Math.round(_clamp01(amt) * Math.max(1, this.duration | 0));
  }

  /** Normalized playback time [0,1]. */
  time() {
    const nSeg = this.segments;
    if (nSeg === 0) return 0;
    const dur = Math.max(1, this.duration | 0);
    const dir = (this.playing && this.rate < 0) ? -1 : 1;
    const local = this.f / dur;
    const amt = dir > 0 ? local : (1 - local);
    return _clamp01((this.seg + amt) / nSeg);
  }

  /** Info snapshot (compatible with pathInfo()). */
  info() {
    return {
      keyframes: this.keyframes.length, segments: this.segments,
      playing: this.playing, loop: this.loop, pingPong: this.pingPong,
      rate: this.rate, duration: this.duration,
      time: this.segments > 0 ? this.time() : 0
    };
  }

  /**
   * Advance one frame. Identical boundary semantics to original tick().
   * @returns {boolean} true if still playing
   */
  tick() {
    if (!this.playing) return false;
    const nSeg = this.segments;
    if (nSeg === 0) { this.playing = false; return false; }
    const dur = Math.max(1, this.duration | 0);
    const speed = Math.abs(this.rate);
    if (speed === 0) { this.playing = false; return false; }
    if (this.seg < 0) this.seg = 0; else if (this.seg >= nSeg) this.seg = nSeg - 1;
    if (this.f < 0) this.f = 0; else if (this.f > dur) this.f = dur;
    let dir = this.rate >= 0 ? 1 : -1;
    this.f += speed;
    while (this.f >= dur) {
      this.f -= dur;
      this.seg += dir;
      if (this.seg >= nSeg || this.seg < 0) {
        if (this.pingPong) {
          if (dir > 0) { this.seg = nSeg - 1; this.f = 0; this.rate = -speed; }
          else { this.seg = 0; this.f = 0; this.rate = speed; }
          dir = this.rate >= 0 ? 1 : -1;
        } else if (this.loop) {
          this.seg = dir > 0 ? 0 : (nSeg - 1);
        } else {
          this.seekGlobal(dir > 0 ? 1 : 0);
          this.playing = false;
          if (typeof this.onEnd === 'function') { try { this.onEnd(); } catch (_) {} }
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Evaluate interpolated transform at current cursor.
   * @param {Object} [out] { pos, rot, scl }
   * @returns {Object}
   */
  eval(out) {
    out = out || { pos: this._pos, rot: this._rot, scl: this._scl };
    const nSeg = this.segments;
    if (nSeg === 0) {
      if (this.keyframes.length === 1) {
        const kf = this.keyframes[0];
        _v3Copy(out.pos, kf.pos); qCopy(out.rot, kf.rot); _v3Copy(out.scl, kf.scl);
      }
      return out;
    }
    const dur = Math.max(1, this.duration | 0);
    const dir = (this.playing && this.rate < 0) ? -1 : 1;
    const local = this.f / dur;
    const t = dir > 0 ? local : (1 - local);
    const seg = Math.max(0, Math.min(this.seg, nSeg - 1));
    const kfA = this.keyframes[seg], kfB = this.keyframes[seg + 1];
    // Position
    if (this.posInterp === 'linear') {
      lerpVec3(out.pos, kfA.pos, kfB.pos, t);
    } else {
      const kfP = this.keyframes[Math.max(0, seg - 1)];
      const kfN = this.keyframes[Math.min(this.keyframes.length - 1, seg + 2)];
      catmullRomVec3(out.pos, kfP.pos, kfA.pos, kfB.pos, kfN.pos, t);
    }
    // Rotation (segment-wise SLERP)
    qSlerp(out.rot, kfA.rot, kfB.rot, t);
    // Scale (linear)
    lerpVec3(out.scl, kfA.scl, kfB.scl, t);
    return out;
  }

  /** Apply evaluated transform through an adapter. */
  apply(adapter) { adapter.apply(this.eval()); }

  /** Compose transform to column-major mat4. */
  toMatrix(outMat4) { return transformToMat4(outMat4 || new Float32Array(16), this.eval()); }
}

// ===========================================================================
// §4  Transform ↔ Matrix
// ===========================================================================

/** Compose {pos, rot, scl} → column-major 4×4 matrix. No shear. */
const transformToMat4 = (out, xform) => {
  qToMat4(out, xform.rot);
  const sx = xform.scl[0], sy = xform.scl[1], sz = xform.scl[2];
  out[0] *= sx; out[1] *= sx; out[2] *= sx;
  out[4] *= sy; out[5] *= sy; out[6] *= sy;
  out[8] *= sz; out[9] *= sz; out[10] *= sz;
  out[12] = xform.pos[0]; out[13] = xform.pos[1]; out[14] = xform.pos[2]; out[15] = 1;
  return out;
};

/** Decompose column-major 4×4 matrix → {pos, rot, scl}. No shear. */
const mat4ToTransform = (out, m) => {
  out.pos[0] = m[12]; out.pos[1] = m[13]; out.pos[2] = m[14];
  const sx = Math.sqrt(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]) || 1;
  const sy = Math.sqrt(m[4] * m[4] + m[5] * m[5] + m[6] * m[6]) || 1;
  const sz = Math.sqrt(m[8] * m[8] + m[9] * m[9] + m[10] * m[10]) || 1;
  out.scl[0] = sx; out.scl[1] = sy; out.scl[2] = sz;
  qFromMat4(out.rot, m);
  return out;
};

// ===========================================================================
// §5  Adapters
// ===========================================================================

/** Abstract base for custom targets. */
class TransformAdapter {
  capture(out) { throw new Error('TransformAdapter.capture() must be overridden'); }
  apply(xform) { throw new Error('TransformAdapter.apply() must be overridden'); }
}

/** @private Camera adapter — captures/applies via p5.Camera.slerp. */
class CameraAdapter {
  constructor(cam) { this.cam = cam; }
  capture(out) {
    const cam = this.cam;
    out.pos[0] = cam.eyeX; out.pos[1] = cam.eyeY; out.pos[2] = cam.eyeZ;
    out.scl[0] = 1; out.scl[1] = 1; out.scl[2] = 1;
    if (cam.cameraMatrix && cam.cameraMatrix.mat4) qFromMat4(out.rot, cam.cameraMatrix.mat4);
    return out;
  }
  apply(xform) {
    const cam = this.cam, pos = xform.pos, rot = xform.rot;
    const rm = _SCRATCH_MAT4; qToMat4(rm, rot);
    const fwdX = -rm[8], fwdY = -rm[9], fwdZ = -rm[10];
    const upX = rm[4], upY = rm[5], upZ = rm[6];
    const dx = cam.centerX - cam.eyeX, dy = cam.centerY - cam.eyeY, dz = cam.centerZ - cam.eyeZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    cam.camera(pos[0], pos[1], pos[2],
      pos[0] + fwdX * dist, pos[1] + fwdY * dist, pos[2] + fwdZ * dist, upX, upY, upZ);
  }
}

// ===========================================================================
// §6  Private helpers
// ===========================================================================

const _SCRATCH_MAT4 = new Float32Array(16);
const _clamp01 = (x) => x < 0 ? 0 : (x > 1 ? 1 : x);
const _isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const _warn = (msg) => console.warn('[tree.camera.path] ' + msg);

const _v3Copy = (out, v) => { out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; return out; };

const _sameTransform = (a, b) => {
  for (let i = 0; i < 3; i++) if (a.pos[i] !== b.pos[i]) return false;
  for (let i = 0; i < 4; i++) if (a.rot[i] !== b.rot[i]) return false;
  for (let i = 0; i < 3; i++) if (a.scl[i] !== b.scl[i]) return false;
  return true;
};

/** Parse vec3 from p5.Vector, [x,y,z], or {x,y,z}. Returns new array or null. */
function _parseVec3(v, p5) {
  if (!v) return null;
  if (p5 && v instanceof p5.Vector) return [v.x, v.y, v.z];
  if (Array.isArray(v) && v.length >= 3) return [v[0], v[1], v[2]];
  if (typeof v === 'object' && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number') return [v.x, v.y, v.z];
  return null;
}

/** Parse quaternion from [x,y,z,w], { axis, angle }, or { dir, up }. Returns array or null. */
function _parseQuat(v) {
  if (!v) return null;
  if (Array.isArray(v) && v.length === 4 && v.every(n => typeof n === 'number')) return [v[0], v[1], v[2], v[3]];
  if (v.axis && typeof v.angle === 'number') {
    const a = Array.isArray(v.axis) ? v.axis : [v.axis.x || 0, v.axis.y || 0, v.axis.z || 0];
    return qFromAxisAngle([0, 0, 0, 1], a[0], a[1], a[2], v.angle);
  }
  if (v.dir) {
    const d = Array.isArray(v.dir) ? v.dir : [v.dir.x || 0, v.dir.y || 0, v.dir.z || 0];
    const u = v.up ? (Array.isArray(v.up) ? v.up : [v.up.x || 0, v.up.y || 0, v.up.z || 0]) : null;
    return qFromLookDir([0, 0, 0, 1], d, u);
  }
  return null;
}

/** Parse a flexible input spec into canonical { pos, rot, scl }. */
function _parseSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const pos = _parseVec3(spec.pos) || [0, 0, 0];
  const rot = _parseQuat(spec.rot || spec) || [0, 0, 0, 1];
  const scl = _parseVec3(spec.scl) || [1, 1, 1];
  return { pos, rot, scl };
}

// ===========================================================================
// §7  Per-camera storage + player registry
// ===========================================================================

const CAM_TRACK = new WeakMap();
const PATH_PLAYERS = new WeakMap();

function getCamTrack(cam) {
  let b = CAM_TRACK.get(cam);
  if (!b) {
    b = { track: new TransformTrack(), adapter: new CameraAdapter(cam),
          pathIsOrtho: undefined, camSnaps: [] };
    CAM_TRACK.set(cam, b);
  }
  return b;
}

function getPlayers(pInst) {
  let players = PATH_PLAYERS.get(pInst);
  if (!players) { players = new Set(); PATH_PLAYERS.set(pInst, players); }
  return players;
}

// ===========================================================================
// §8  Camera path helpers
// ===========================================================================

const isOrthoCam = (c) => {
  const m = c && c.projMatrix && c.projMatrix.mat4;
  return m && m.length === 16 ? (m[15] !== 0) : undefined;
};

function initProjBaseline(cam) {
  const b = getCamTrack(cam);
  if (b.pathIsOrtho !== undefined) return;
  b.pathIsOrtho = isOrthoCam(cam);
  if (b.pathIsOrtho === undefined) _warn('addPath: unable to verify projection type.');
}

function checkProjCompat(cam, snapCam) {
  const b = getCamTrack(cam);
  initProjBaseline(cam);
  const v = isOrthoCam(snapCam);
  if (b.pathIsOrtho === undefined || v === undefined) return true;
  if (v !== b.pathIsOrtho) { _warn('addPath rejected: mixed projection types.'); return false; }
  return true;
}

function addCamSnapshot(cam, snapCam) {
  const b = getCamTrack(cam);
  const last = b.camSnaps.length ? b.camSnaps[b.camSnaps.length - 1] : null;
  if (last && last.cameraMatrix && snapCam.cameraMatrix) {
    const aM = last.cameraMatrix.mat4, bM = snapCam.cameraMatrix.mat4;
    if (aM && bM) { let same = true; for (let i = 0; i < 16; i++) { if (aM[i] !== bM[i]) { same = false; break; } } if (same) return; }
  }
  const copy = snapCam.copy();
  b.camSnaps.push(copy);
  const kf = { pos: [copy.eyeX, copy.eyeY, copy.eyeZ], rot: [0, 0, 0, 1], scl: [1, 1, 1] };
  if (copy.cameraMatrix && copy.cameraMatrix.mat4) qFromMat4(kf.rot, copy.cameraMatrix.mat4);
  b.track.keyframes.push(kf);
}

function applyCamInterp(cam, seg, t) {
  const snaps = getCamTrack(cam).camSnaps;
  if (seg < 0 || seg >= snaps.length - 1) return;
  cam.slerp(snaps[seg], snaps[seg + 1], t);
}

function _applyCamAtCursor(cam) {
  const b = getCamTrack(cam);
  const track = b.track;
  const nSeg = track.segments;
  if (nSeg === 0) return;
  const dur = Math.max(1, track.duration | 0);
  const dir = (track.playing && track.rate < 0) ? -1 : 1;
  const local = track.f / dur;
  const t = dir > 0 ? local : (1 - local);
  applyCamInterp(cam, Math.max(0, Math.min(track.seg, nSeg - 1)), t);
}

function tickCamera(cam) {
  const track = getCamTrack(cam).track;
  if (!track.playing) return;
  track.tick();
  _applyCamAtCursor(cam);
}

// ===========================================================================
// §9  Shared parse helpers (used by addPath)
// ===========================================================================

const _isPlainObject = (v) => {
  if (!v || typeof v !== 'object') return false;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return false;
  return Object.getPrototypeOf(v) === Object.prototype;
};

function _addPathHelpers(p5) {
  const isVec3 = (v) => v instanceof p5.Vector ||
    (Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n)));
  const toVec3 = (v) => v instanceof p5.Vector ? [v.x, v.y, v.z] : [v[0], v[1], v[2]];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len3 = (v) => Math.sqrt(dot3(v, v));
  const norm3 = (v) => { const l = len3(v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const isMat4Array = (v) => (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length === 16 &&
    Array.prototype.every.call(v, n => typeof n === 'number' && Number.isFinite(n));
  const isView = (v) => v instanceof p5.Matrix || isMat4Array(v);
  const toMat4 = (v) => v instanceof p5.Matrix ? v.mat4 : v;

  const importViewToCamera = (cam, view) => {
    const m = toMat4(view);
    const right = norm3([m[0], m[4], m[8]]);
    const up = norm3([m[1], m[5], m[9]]);
    const negFwd = norm3([m[2], m[6], m[10]]);
    const fwd = [-negFwd[0], -negFwd[1], -negFwd[2]];
    const t = [m[12], m[13], m[14]];
    const eye = [-(t[0] * right[0] + t[1] * up[0]) + t[2] * fwd[0],
                 -(t[0] * right[1] + t[1] * up[1]) + t[2] * fwd[1],
                 -(t[0] * right[2] + t[1] * up[2]) + t[2] * fwd[2]];
    const dist = Math.sqrt((cam.centerX - cam.eyeX) ** 2 + (cam.centerY - cam.eyeY) ** 2 + (cam.centerZ - cam.eyeZ) ** 2) || 1;
    const center = [eye[0] + fwd[0] * dist, eye[1] + fwd[1] * dist, eye[2] + fwd[2] * dist];
    const c = cam.copy();
    c.camera(eye[0], eye[1], eye[2], center[0], center[1], center[2], up[0], up[1], up[2]);
    return c;
  };

  return { isVec3, toVec3, norm3, isView, importViewToCamera };
}

// ===========================================================================
// §10  Install function
// ===========================================================================

/**
 * Install TransformTrack, adapters, and camera path API.
 * @param {p5} p5
 * @param {Object} fn  p5 prototype
 */
export function installTrack(p5, fn) {
  // Expose for external use
  p5.Tree.TransformTrack = TransformTrack;
  p5.Tree.TransformAdapter = TransformAdapter;

  const H = _addPathHelpers(p5);

  // ---- addPath ----
  p5.Camera.prototype.addPath = function (...args) {
    const b = getCamTrack(this);
    const track = b.track;
    const o = args.length && _isPlainObject(args[args.length - 1]) ? args.pop() : {};
    if (o.reset) { track.reset(); b.camSnaps.length = 0; b.pathIsOrtho = undefined; }
    initProjBaseline(this);
    if (args.length === 0) { addCamSnapshot(this, this); return this; }
    if (args.length === 1) {
      const ov = args[0];
      if (H.isView(ov)) { const c = H.importViewToCamera(this, ov); checkProjCompat(this, c) && addCamSnapshot(this, c); return this; }
      if (Array.isArray(ov)) {
        if (ov.length && ov.every(H.isView)) { for (const v of ov) { const c = H.importViewToCamera(this, v); checkProjCompat(this, c) && addCamSnapshot(this, c); } return this; }
        for (const c of ov) { if (!(c instanceof p5.Camera)) { _warn('addPath: ignored non-camera.'); continue; } checkProjCompat(this, c) && addCamSnapshot(this, c); }
        return this;
      }
      if (ov instanceof p5.Camera) { checkProjCompat(this, ov) && addCamSnapshot(this, ov); return this; }
      _warn('addPath: ignored unsupported arguments.'); return this;
    }
    if (args.length === 3 && args.every(H.isVec3)) {
      const eye = H.toVec3(args[0]), center = H.toVec3(args[1]), up = H.norm3(H.toVec3(args[2]));
      const c = this.copy(); c.camera(eye[0], eye[1], eye[2], center[0], center[1], center[2], up[0], up[1], up[2]);
      checkProjCompat(this, c) && addCamSnapshot(this, c); return this;
    }
    _warn('addPath: ignored unsupported arguments.'); return this;
  };

  // ---- playPath ----
  p5.Camera.prototype.playPath = function (rateOrOpts) {
    const b = getCamTrack(this), track = b.track;
    const pInst = this._renderer && this._renderer._pInst;
    const unreg = () => pInst && getPlayers(pInst).delete(this);
    const reg = () => pInst && getPlayers(pInst).add(this);
    if (track.keyframes.length === 0) { _warn('playPath ignored: no keyframes.'); track.playing = false; unreg(); return this; }
    if (track.keyframes.length === 1) {
      track.playing = false; unreg();
      const kf = b.camSnaps[0];
      return kf ? this.camera(kf.eyeX, kf.eyeY, kf.eyeZ, kf.centerX, kf.centerY, kf.centerZ, kf.upX, kf.upY, kf.upZ) : this;
    }
    if (track.segments === 0) { _warn('playPath ignored: need ≥2 keyframes.'); track.playing = false; unreg(); return this; }
    const cam = this;
    if (_isNum(rateOrOpts)) { track.play(rateOrOpts); }
    else {
      const o = rateOrOpts || {}, opts = {};
      if (_isNum(o.duration)) opts.duration = o.duration;
      if ('loop' in o) opts.loop = !!o.loop;
      if ('pingPong' in o) opts.pingPong = !!o.pingPong;
      if (typeof o.onEnd === 'function') { const ucb = o.onEnd; opts.onEnd = () => { try { ucb(cam); } catch (_) {} }; }
      if (_isNum(o.rate)) opts.rate = o.rate;
      track.play(opts);
    }
    if (track.rate === 0 || !track.playing) { unreg(); return this; }
    reg(); return this;
  };

  // ---- stopPath ----
  p5.Camera.prototype.stopPath = function (reset = false) {
    const b = getCamTrack(this), track = b.track;
    track.playing = false;
    const pInst = this._renderer && this._renderer._pInst; pInst && getPlayers(pInst).delete(this);
    if (!reset) return this;
    if (b.camSnaps.length === 1) { const kf = b.camSnaps[0]; return this.camera(kf.eyeX, kf.eyeY, kf.eyeZ, kf.centerX, kf.centerY, kf.centerZ, kf.upX, kf.upY, kf.upZ); }
    track.seekGlobal(track.rate < 0 ? 1 : 0); _applyCamAtCursor(this); return this;
  };

  // ---- resetPath ----
  p5.Camera.prototype.resetPath = function () {
    const b = getCamTrack(this), track = b.track;
    track.playing = false;
    const pInst = this._renderer && this._renderer._pInst; pInst && getPlayers(pInst).delete(this);
    const kf0 = b.camSnaps.length ? b.camSnaps[0] : null;
    track.reset(); b.camSnaps.length = 0; b.pathIsOrtho = undefined;
    if (!kf0) return this;
    return this.camera(kf0.eyeX, kf0.eyeY, kf0.eyeZ, kf0.centerX, kf0.centerY, kf0.centerZ, kf0.upX, kf0.upY, kf0.upZ);
  };

  // ---- seekPath ----
  p5.Camera.prototype.seekPath = function (t, segIndex) {
    const track = getCamTrack(this).track;
    track.playing = false;
    const pInst = this._renderer && this._renderer._pInst; pInst && getPlayers(pInst).delete(this);
    _isNum(segIndex) ? track.seekSegment(t, segIndex) : track.seekGlobal(t);
    _applyCamAtCursor(this); return this;
  };

  // ---- pathTime / pathInfo ----
  p5.Camera.prototype.pathTime = function () { return getCamTrack(this).track.time(); };
  p5.Camera.prototype.pathInfo = function () { return getCamTrack(this).track.info(); };

  // ---- camera.path backward compat ----
  Object.defineProperty(p5.Camera.prototype, 'path', {
    get() { return getCamTrack(this).camSnaps; },
    set(v) { if (Array.isArray(v) && v.length === 0) { const b = getCamTrack(this); b.track.reset(); b.camSnaps.length = 0; b.pathIsOrtho = undefined; } },
    configurable: true
  });

  // ---- Global forwarders ----
  fn.addPath = function (...a) { const c = this._renderer.states.curCamera; c && c.addPath(...a); return this; };
  fn.playPath = function (...a) { const c = this._renderer.states.curCamera; c && c.playPath(...a); return this; };
  fn.seekPath = function (...a) { const c = this._renderer.states.curCamera; c && c.seekPath(...a); return this; };
  fn.resetPath = function (...a) { const c = this._renderer.states.curCamera; c && c.resetPath(...a); return this; };
  fn.stopPath = function (...a) { const c = this._renderer.states.curCamera; c && c.stopPath(...a); return this; };
  fn.pathTime = function () { const c = this._renderer.states.curCamera; return c && c.pathTime(); };
  fn.pathInfo = function () { const c = this._renderer.states.curCamera; return c && c.pathInfo(); };
}

// ===========================================================================
// §11  Lifecycle helpers (exported for entry point)
// ===========================================================================

/** Tick all active camera path players. Called from lifecycles.predraw. */
export function tickPlayers(pInst) {
  const players = getPlayers(pInst);
  players.forEach(cam => {
    tickCamera(cam);
    getCamTrack(cam).track.playing || players.delete(cam);
  });
}

/** Clear player registry. Called from lifecycles.remove. */
export function clearPlayers(pInst) {
  const players = PATH_PLAYERS.get(pInst);
  players && players.clear();
}
