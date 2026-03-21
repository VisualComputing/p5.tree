/**
 * @file Pure quaternion/spline math + track state machines.
 * @module tree/track
 * @license AGPL-3.0-only
 *
 * Zero dependencies.  No p5, DOM, WebGL, or WebGPU usage.
 *
 * ── Exports ──────────────────────────────────────────────────────────────────
 *  Quaternion helpers
 *    qSet qCopy qDot qNormalize qNegate qMul qSlerp qNlerp
 *    qFromAxisAngle qFromLookDir qFromRotMat3x3 qFromMat4 qToMat4
 *    quatToAxisAngle
 *  Spline / vector helpers
 *    catmullRomVec3  lerpVec3
 *  Transform / mat4 helpers
 *    transformToMat4  mat4ToTransform
 *  Tracks
 *    PoseTrack    — { pos, rot, scl } TRS keyframes
 *    CameraTrack  — { eye, center, up } lookat keyframes
 *
 * ── Class hierarchy ───────────────────────────────────────────────────────────
 *  Track (unexported, never instantiated directly)
 *    └── PoseTrack   (exported)
 *    └── CameraTrack (exported)
 *
 *  Track holds all transport machinery: cursor, play/stop/seek/tick,
 *  hooks, rate semantics.  Subclasses add only keyframe storage and
 *  add() / eval() for their respective data shape.
 *
 * ── Hook architecture ─────────────────────────────────────────────────────────
 *  _onActivate / _onDeactivate  — lib-space (underscore, set by host layer)
 *    Fire on playing transitions: false→true / true→false.
 *
 *  onPlay / onEnd / onStop      — user-space (public)
 *    onPlay : fires in play()  on false→true transition.
 *    onEnd  : fires in tick()  at natural boundary (once mode only).
 *    onStop : fires in stop() / reset() — explicit deactivation.
 *    onEnd and onStop are mutually exclusive per event.
 *
 *  Firing order:
 *    play()  → onPlay → _onActivate
 *    tick()  → onEnd  → _onDeactivate
 *    stop()  → onStop → _onDeactivate
 *    reset() → onStop → _onDeactivate
 *
 * ── Playback semantics (rate) ─────────────────────────────────────────────────
 *  rate > 0   forward
 *  rate < 0   backward
 *  rate === 0 frozen: tick() no-op; playing unchanged
 *
 *  play() is the sole setter of playing = true.
 *  stop() is the sole setter of playing = false.
 *  Assigning rate never starts or stops playback.
 *
 * ── One-keyframe behaviour ────────────────────────────────────────────────────
 *  play() with exactly one keyframe snaps eval() to that keyframe without
 *  setting playing = true and without firing hooks.
 */

'use strict';

// =========================================================================
// S1  Quaternion helpers  (flat [x, y, z, w], w-last)
// =========================================================================

/** Set all four components. @returns {number[]} out */
export const qSet = (out, x, y, z, w) => {
  out[0] = x; out[1] = y; out[2] = z; out[3] = w; return out;
};

/** Copy quaternion a into out. @returns {number[]} out */
export const qCopy = (out, a) => {
  out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3]; return out;
};

/** Dot product of two quaternions. */
export const qDot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3];

/** Normalise quaternion in-place. @returns {number[]} out */
export const qNormalize = (out) => {
  const l = Math.sqrt(out[0]*out[0]+out[1]*out[1]+out[2]*out[2]+out[3]*out[3]) || 1;
  out[0]/=l; out[1]/=l; out[2]/=l; out[3]/=l; return out;
};

/** Negate quaternion (same rotation, different hemisphere). @returns {number[]} out */
export const qNegate = (out, a) => {
  out[0]=-a[0]; out[1]=-a[1]; out[2]=-a[2]; out[3]=-a[3]; return out;
};

/** Hamilton product out = a * b. @returns {number[]} out */
export const qMul = (out, a, b) => {
  const ax=a[0],ay=a[1],az=a[2],aw=a[3], bx=b[0],by=b[1],bz=b[2],bw=b[3];
  out[0]=aw*bx+ax*bw+ay*bz-az*by;
  out[1]=aw*by-ax*bz+ay*bw+az*bx;
  out[2]=aw*bz+ax*by-ay*bx+az*bw;
  out[3]=aw*bw-ax*bx-ay*by-az*bz;
  return out;
};

/** Spherical linear interpolation. @returns {number[]} out */
export const qSlerp = (out, a, b, t) => {
  let bx=b[0],by=b[1],bz=b[2],bw=b[3];
  let d = a[0]*bx+a[1]*by+a[2]*bz+a[3]*bw;
  if (d < 0) { bx=-bx; by=-by; bz=-bz; bw=-bw; d=-d; }
  let f0, f1;
  if (1-d > 1e-10) {
    const th=Math.acos(d), st=Math.sin(th);
    f0=Math.sin((1-t)*th)/st; f1=Math.sin(t*th)/st;
  } else {
    f0=1-t; f1=t;
  }
  out[0]=a[0]*f0+bx*f1; out[1]=a[1]*f0+by*f1;
  out[2]=a[2]*f0+bz*f1; out[3]=a[3]*f0+bw*f1;
  return qNormalize(out);
};

/**
 * Normalised linear interpolation (nlerp).
 * Cheaper than slerp; slightly non-constant angular velocity.
 * Handles antipodal quats by flipping b when dot < 0.
 * @returns {number[]} out
 */
export const qNlerp = (out, a, b, t) => {
  let bx=b[0],by=b[1],bz=b[2],bw=b[3];
  if (a[0]*bx+a[1]*by+a[2]*bz+a[3]*bw < 0) { bx=-bx; by=-by; bz=-bz; bw=-bw; }
  out[0]=a[0]+t*(bx-a[0]); out[1]=a[1]+t*(by-a[1]);
  out[2]=a[2]+t*(bz-a[2]); out[3]=a[3]+t*(bw-a[3]);
  return qNormalize(out);
};

/**
 * Build a quaternion from axis-angle.
 * @param {number[]} out
 * @param {number} ax @param {number} ay @param {number} az  Axis (need not be unit).
 * @param {number} angle  Radians.
 * @returns {number[]} out
 */
export const qFromAxisAngle = (out, ax, ay, az, angle) => {
  const half = angle * 0.5;
  const s    = Math.sin(half);
  const len  = Math.sqrt(ax*ax + ay*ay + az*az) || 1;
  out[0] = s * ax / len; out[1] = s * ay / len; out[2] = s * az / len;
  out[3] = Math.cos(half);
  return out;
};

/**
 * Build a quaternion from a look direction (−Z forward) and optional up (default +Y).
 * @param {number[]} out
 * @param {number[]} dir  Forward direction [x,y,z].
 * @param {number[]} [up] Up vector [x,y,z].
 * @returns {number[]} out
 */
export const qFromLookDir = (out, dir, up) => {
  let fx=dir[0],fy=dir[1],fz=dir[2];
  const fl=Math.sqrt(fx*fx+fy*fy+fz*fz)||1;
  fx/=fl; fy/=fl; fz/=fl;
  let ux=up?up[0]:0, uy=up?up[1]:1, uz=up?up[2]:0;
  let rx=uy*fz-uz*fy, ry=uz*fx-ux*fz, rz=ux*fy-uy*fx;
  const rl=Math.sqrt(rx*rx+ry*ry+rz*rz)||1;
  rx/=rl; ry/=rl; rz/=rl;
  ux=fy*rz-fz*ry; uy=fz*rx-fx*rz; uz=fx*ry-fy*rx;
  return qFromRotMat3x3(out, rx,ry,rz, ux,uy,uz, -fx,-fy,-fz);
};

/**
 * Build a quaternion from a 3×3 rotation matrix (9 row-major scalars).
 * @returns {number[]} out (normalised)
 */
export const qFromRotMat3x3 = (out, m00,m01,m02, m10,m11,m12, m20,m21,m22) => {
  const tr = m00+m11+m22;
  if (tr > 0) {
    const s=0.5/Math.sqrt(tr+1);
    out[3]=0.25/s; out[0]=(m21-m12)*s; out[1]=(m02-m20)*s; out[2]=(m10-m01)*s;
  } else if (m00>m11 && m00>m22) {
    const s=2*Math.sqrt(1+m00-m11-m22);
    out[3]=(m21-m12)/s; out[0]=0.25*s; out[1]=(m01+m10)/s; out[2]=(m02+m20)/s;
  } else if (m11>m22) {
    const s=2*Math.sqrt(1+m11-m00-m22);
    out[3]=(m02-m20)/s; out[0]=(m01+m10)/s; out[1]=0.25*s; out[2]=(m12+m21)/s;
  } else {
    const s=2*Math.sqrt(1+m22-m00-m11);
    out[3]=(m10-m01)/s; out[0]=(m02+m20)/s; out[1]=(m12+m21)/s; out[2]=0.25*s;
  }
  return qNormalize(out);
};

/**
 * Extract a unit quaternion from the upper-left 3×3 of a column-major mat4.
 * @param {number[]} out
 * @param {Float32Array|number[]} m  Column-major mat4.
 * @returns {number[]} out
 */
export const qFromMat4 = (out, m) =>
  qFromRotMat3x3(out, m[0],m[4],m[8], m[1],m[5],m[9], m[2],m[6],m[10]);

/**
 * Write a quaternion into the rotation block of a column-major mat4.
 * Translation and perspective rows/cols are set to identity values.
 * @param {Float32Array|number[]} out  16-element array.
 * @param {number[]} q  [x,y,z,w].
 * @returns {Float32Array|number[]} out
 */
export const qToMat4 = (out, q) => {
  const x=q[0],y=q[1],z=q[2],w=q[3];
  const x2=x+x,y2=y+y,z2=z+z;
  const xx=x*x2,xy=x*y2,xz=x*z2,yy=y*y2,yz=y*z2,zz=z*z2,wx=w*x2,wy=w*y2,wz=w*z2;
  out[0]=1-(yy+zz); out[1]=xy+wz;     out[2]=xz-wy;     out[3]=0;
  out[4]=xy-wz;     out[5]=1-(xx+zz); out[6]=yz+wx;     out[7]=0;
  out[8]=xz+wy;     out[9]=yz-wx;     out[10]=1-(xx+yy); out[11]=0;
  out[12]=0;        out[13]=0;        out[14]=0;          out[15]=1;
  return out;
};

/**
 * Decompose a unit quaternion into { axis:[x,y,z], angle } (radians).
 * @param {number[]} q  [x,y,z,w].
 * @param {Object}  [out]
 * @returns {{ axis: number[], angle: number }}
 */
export const quatToAxisAngle = (q, out) => {
  out = out || {};
  const x=q[0],y=q[1],z=q[2],w=q[3];
  const sinHalf = Math.sqrt(x*x+y*y+z*z);
  if (sinHalf < 1e-8) { out.axis=[0,1,0]; out.angle=0; return out; }
  out.angle = 2*Math.atan2(sinHalf, w);
  out.axis  = [x/sinHalf, y/sinHalf, z/sinHalf];
  return out;
};

// =========================================================================
// S2  Spline / vector helpers
// =========================================================================

function _dist3(a, b) {
  const dx=a[0]-b[0], dy=a[1]-b[1], dz=a[2]-b[2];
  return Math.sqrt(dx*dx+dy*dy+dz*dz);
}

/**
 * Centripetal Catmull-Rom interpolation (alpha=0.5, Barry-Goldman).
 * out = interp(p0, p1, p2, p3, t) where t∈[0,1] maps p1→p2.
 * Boundary: p0===p1 or p2===p3 clamps the end tangent.
 * @param {number[]} out  3-element result.
 * @param {number[]} p0  Control point before p1.
 * @param {number[]} p1  Segment start.
 * @param {number[]} p2  Segment end.
 * @param {number[]} p3  Control point after p2.
 * @param {number}   t   Blend [0, 1].
 * @returns {number[]} out
 */
export const catmullRomVec3 = (out, p0, p1, p2, p3, t) => {
  const alpha = 0.5;
  const dt0 = Math.pow(_dist3(p0,p1), alpha) || 1;
  const dt1 = Math.pow(_dist3(p1,p2), alpha) || 1;
  const dt2 = Math.pow(_dist3(p2,p3), alpha) || 1;
  for (let i = 0; i < 3; i++) {
    const t1_0 = (p1[i]-p0[i])/dt0 - (p2[i]-p0[i])/(dt0+dt1) + (p2[i]-p1[i])/dt1;
    const t2_0 = (p2[i]-p1[i])/dt1 - (p3[i]-p1[i])/(dt1+dt2) + (p3[i]-p2[i])/dt2;
    const m1=t1_0*dt1, m2=t2_0*dt1;
    const a= 2*p1[i]-2*p2[i]+m1+m2;
    const b=-3*p1[i]+3*p2[i]-2*m1-m2;
    out[i] = a*t*t*t + b*t*t + m1*t + p1[i];
  }
  return out;
};

/**
 * Linear interpolation between two vec3s.
 * @param {number[]} out
 * @param {number[]} a
 * @param {number[]} b
 * @param {number}   t  Blend [0, 1].
 * @returns {number[]} out
 */
export const lerpVec3 = (out, a, b, t) => {
  out[0]=a[0]+t*(b[0]-a[0]);
  out[1]=a[1]+t*(b[1]-a[1]);
  out[2]=a[2]+t*(b[2]-a[2]);
  return out;
};

// =========================================================================
// S3  Transform <-> Mat4
// =========================================================================

/**
 * Write a TRS transform into a column-major mat4.
 * @param {Float32Array|number[]} out  16-element column-major mat4.
 * @param {{ pos:number[], rot:number[], scl:number[] }} xform
 * @returns {Float32Array|number[]} out
 */
export const transformToMat4 = (out, xform) => {
  qToMat4(out, xform.rot);
  const sx=xform.scl[0], sy=xform.scl[1], sz=xform.scl[2];
  out[0]*=sx; out[1]*=sx; out[2]*=sx;
  out[4]*=sy; out[5]*=sy; out[6]*=sy;
  out[8]*=sz; out[9]*=sz; out[10]*=sz;
  out[12]=xform.pos[0]; out[13]=xform.pos[1]; out[14]=xform.pos[2];
  return out;
};

/**
 * Decompose a column-major mat4 into a TRS transform.
 * Assumes no shear. Scale extracted from column lengths.
 * @param {{ pos:number[], rot:number[], scl:number[] }} out
 * @param {Float32Array|number[]} m  Column-major mat4.
 * @returns {{ pos:number[], rot:number[], scl:number[] }} out
 */
export const mat4ToTransform = (out, m) => {
  out.pos[0]=m[12]; out.pos[1]=m[13]; out.pos[2]=m[14];
  const sx=Math.sqrt(m[0]*m[0]+m[1]*m[1]+m[2]*m[2]);
  const sy=Math.sqrt(m[4]*m[4]+m[5]*m[5]+m[6]*m[6]);
  const sz=Math.sqrt(m[8]*m[8]+m[9]*m[9]+m[10]*m[10]);
  out.scl[0]=sx; out.scl[1]=sy; out.scl[2]=sz;
  qFromRotMat3x3(out.rot,
    m[0]/sx,m[4]/sy,m[8]/sz,
    m[1]/sx,m[5]/sy,m[9]/sz,
    m[2]/sx,m[6]/sy,m[10]/sz);
  return out;
};

// =========================================================================
// S4a  Spec parser — PoseTrack
// =========================================================================

const _isNum   = (x) => typeof x === 'number' && Number.isFinite(x);
const _clamp01 = (x) => x < 0 ? 0 : (x > 1 ? 1 : x);
const _clampS  = (x, lo, hi) => x < lo ? lo : (x > hi ? hi : x);

function _parseVec3(v) {
  if (!v) return null;
  if (ArrayBuffer.isView(v) && v.length >= 3) return [v[0], v[1], v[2]];
  if (Array.isArray(v) && v.length >= 3 && v.every(n => typeof n === 'number')) return [v[0], v[1], v[2]];
  if (typeof v === 'object' && 'x' in v) return [v.x || 0, v.y || 0, v.z || 0];
  return null;
}

// Euler: unit axis vectors and the six valid intrinsic orderings.
const _EULER_AXES   = { X:[1,0,0], Y:[0,1,0], Z:[0,0,1] };
const _EULER_ORDERS = new Set(['XYZ','XZY','YXZ','YZX','ZXY','ZYX']);

/**
 * Parse any rotation representation into a unit quaternion [x,y,z,w].
 *
 * Accepted forms:
 *
 *   [x,y,z,w]
 *     Raw quaternion array.
 *
 *   { axis:[x,y,z], angle }
 *     Axis-angle.  Axis need not be unit.
 *
 *   { dir:[x,y,z], up?:[x,y,z] }
 *     Object orientation — forward direction (−Z) with optional up hint.
 *
 *   { eMatrix: mat4 }
 *     Extract rotation block from an eye (eye→world) matrix.
 *     Column-major Float32Array(16), plain Array, or { mat4 } wrapper.
 *
 *   { mat3: mat3 }
 *     Column-major 3×3 rotation matrix — Float32Array(9) or plain Array.
 *
 *   { euler:[rx,ry,rz], order?:'YXZ' }
 *     Intrinsic Euler angles (radians).  Angles are indexed by order position:
 *     e[0] rotates around order[0] axis, e[1] around order[1], e[2] around order[2].
 *     Supported orders: YXZ (default), XYZ, ZYX, ZXY, XZY, YZX.
 *     Note: intrinsic ABC = extrinsic CBA with the same angles — to use
 *     extrinsic order ABC, reverse the string and use intrinsic CBA.
 *
 *   { from:[x,y,z], to:[x,y,z] }
 *     Shortest-arc rotation from one direction onto another.
 *     Both vectors are normalised internally.
 *     Antiparallel input: 180° rotation around a perpendicular axis.
 *
 * @param {*} v
 * @returns {number[]|null}  [x,y,z,w] or null if unparseable.
 */
function _parseQuat(v) {
  if (!v) return null;
  
  // raw [x,y,z,w] — plain array or typed array
  if ((Array.isArray(v) || ArrayBuffer.isView(v)) && v.length === 4) return [v[0], v[1], v[2], v[3]];

  // { axis, angle }
  if (v.axis && typeof v.angle === 'number') {
    const a = Array.isArray(v.axis) ? v.axis : [v.axis.x||0, v.axis.y||0, v.axis.z||0];
    return qFromAxisAngle([0,0,0,1], a[0],a[1],a[2], v.angle);
  }

  // { dir, up? }
  if (v.dir) {
    const d = Array.isArray(v.dir) ? v.dir : [v.dir.x||0, v.dir.y||0, v.dir.z||0];
    const u = v.up ? (Array.isArray(v.up) ? v.up : [v.up.x||0, v.up.y||0, v.up.z||0]) : null;
    return qFromLookDir([0,0,0,1], d, u);
  }

  // { eMatrix } — rotation block from eye (eye→world) matrix, col-major mat4
  if (v.eMatrix != null) {
    const m = (ArrayBuffer.isView(v.eMatrix) || Array.isArray(v.eMatrix))
      ? v.eMatrix : (v.eMatrix.mat4 ?? null);
    if (m && m.length >= 16) return qFromMat4([0,0,0,1], m);
  }

  // { mat3 } — column-major 3×3 rotation matrix
  // col0=[m0,m1,m2], col1=[m3,m4,m5], col2=[m6,m7,m8]
  // row-major for qFromRotMat3x3: row0=[m0,m3,m6], row1=[m1,m4,m7], row2=[m2,m5,m8]
  if (v.mat3 != null) {
    const m = v.mat3;
    if ((ArrayBuffer.isView(m) || Array.isArray(m)) && m.length >= 9)
      return qFromRotMat3x3([0,0,0,1], m[0],m[3],m[6], m[1],m[4],m[7], m[2],m[5],m[8]);
  }

  // { euler, order? } — intrinsic Euler angles (radians), default order YXZ
  if (v.euler != null) {
    const e = v.euler;
    if (!Array.isArray(e) || e.length < 3) return null;
    const order = (typeof v.order === 'string' && _EULER_ORDERS.has(v.order))
      ? v.order : 'YXZ';
    const q = [0,0,0,1];
    const s = [0,0,0,1]; // scratch — reused each step
    for (let i = 0; i < 3; i++) {
      const ax = _EULER_AXES[order[i]];
      qMul(q, q, qFromAxisAngle(s, ax[0],ax[1],ax[2], e[i]));
    }
    return q;
  }

  // { from, to } — shortest-arc rotation from one direction onto another
  if (v.from != null && v.to != null) {
    const f = Array.isArray(v.from) ? v.from : [v.from.x||0, v.from.y||0, v.from.z||0];
    const t = Array.isArray(v.to)   ? v.to   : [v.to.x||0,   v.to.y||0,   v.to.z||0];
    const fl = Math.sqrt(f[0]*f[0]+f[1]*f[1]+f[2]*f[2]) || 1;
    const tl = Math.sqrt(t[0]*t[0]+t[1]*t[1]+t[2]*t[2]) || 1;
    const fx=f[0]/fl, fy=f[1]/fl, fz=f[2]/fl;
    const tx=t[0]/tl, ty=t[1]/tl, tz=t[2]/tl;
    const dot = fx*tx + fy*ty + fz*tz;
    // parallel — identity
    if (dot >= 1 - 1e-8) return [0,0,0,1];
    // antiparallel — 180° around any perpendicular axis
    if (dot <= -1 + 1e-8) {
      // cross(from, X=[1,0,0]) = [0, fz, -fy]
      let px=0, py=fz, pz=-fy;
      let pl = Math.sqrt(px*px+py*py+pz*pz);
      if (pl < 1e-8) {
        // from ≈ ±X; try cross(from, Z=[0,0,1]) = [fy, -fx, 0]
        px=fy; py=-fx; pz=0;
        pl = Math.sqrt(px*px+py*py+pz*pz);
      }
      if (pl < 1e-8) return [0,0,0,1];
      return qFromAxisAngle([0,0,0,1], px/pl,py/pl,pz/pl, Math.PI);
    }
    // general case — axis = normalize(cross(from, to))
    let ax=fy*tz-fz*ty, ay=fz*tx-fx*tz, az=fx*ty-fy*tx;
    const al = Math.sqrt(ax*ax+ay*ay+az*az) || 1;
    return qFromAxisAngle([0,0,0,1], ax/al,ay/al,az/al,
      Math.acos(Math.max(-1, Math.min(1, dot))));
  }

  return null;
}

/**
 * Parse a PoseTrack keyframe spec.
 *
 * Accepted forms:
 *
 *   { mMatrix }
 *     Decompose a column-major mat4 into TRS via mat4ToTransform.
 *     Float32Array(16), plain Array, or { mat4 } wrapper.
 *     pos from col3, scl from column lengths, rot from normalised rotation block.
 *
 *   { pos, rot, scl }
 *     Explicit TRS.  pos and scl are vec3, rot accepts any form from _parseQuat.
 *     All fields are optional — missing pos/scl default to [0,0,0] / [1,1,1],
 *     missing rot defaults to identity.
 *
 * @param {Object} spec
 * @returns {{ pos:number[], rot:number[], scl:number[] }|null}
 */
function _parseSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;

  // { mMatrix } — full TRS decomposition from model matrix
  if (spec.mMatrix != null) {
    const m = (ArrayBuffer.isView(spec.mMatrix) || Array.isArray(spec.mMatrix))
      ? spec.mMatrix : (spec.mMatrix.mat4 ?? null);
    if (!m || m.length < 16) return null;
    return mat4ToTransform({ pos:[0,0,0], rot:[0,0,0,1], scl:[1,1,1] }, m);
  }

  const pos = _parseVec3(spec.pos) || [0,0,0];
  const rot = _parseQuat(spec.rot) || [0,0,0,1];
  const scl = _parseVec3(spec.scl) || [1,1,1];
  return { pos, rot, scl };
}

function _sameTransform(a, b) {
  for (let i=0;i<3;i++) if (a.pos[i]!==b.pos[i]||a.scl[i]!==b.scl[i]) return false;
  for (let i=0;i<4;i++) if (a.rot[i]!==b.rot[i]) return false;
  return true;
}

// =========================================================================
// S4b  Spec parser — CameraTrack
// =========================================================================

/**
 * Parse a camera keyframe spec into internal { eye, center, up } form.
 *
 * Accepted forms:
 *
 *   { eye, center?, up? }
 *     Explicit lookat.  center defaults to [0,0,0], up defaults to [0,1,0].
 *     Both are normalised/stored as-is.  eye must be a vec3.
 *
 *   { vMatrix: mat4 }
 *     Column-major view matrix (world→eye).
 *     eye reconstructed via -R^T·t; center = eye + forward·1; up = [0,1,0].
 *     The matrix's up_ortho (col1) is intentionally NOT used as up —
 *     passing it to cam.camera() shifts orbitControl's orbit reference.
 *     Float32Array(16), plain Array, or { mat4 } wrapper.
 *
 *   { eMatrix: mat4 }
 *     Column-major eye matrix (eye→world, i.e. inverse view).
 *     eye read directly from col3; center = eye + forward·1; up = [0,1,0].
 *     Simpler extraction than vMatrix; prefer this form when eMatrix is available.
 *     Float32Array(16), plain Array, or { mat4 } wrapper.
 *
 * @param {Object} spec
 * @returns {{ eye:number[], center:number[], up:number[] }|null}
 */
function _parseCameraSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;

  // { vMatrix } — view matrix (world→eye); reconstruct eye via -R^T·t
  if (spec.vMatrix != null) {
    const m = (ArrayBuffer.isView(spec.vMatrix) || Array.isArray(spec.vMatrix))
      ? spec.vMatrix : (spec.vMatrix.mat4 ?? null);
    if (!m || m.length < 16) return null;
    const ex = -(m[0]*m[12] + m[4]*m[13] + m[8]*m[14]);
    const ey = -(m[1]*m[12] + m[5]*m[13] + m[9]*m[14]);
    const ez = -(m[2]*m[12] + m[6]*m[13] + m[10]*m[14]);
    const fx=-m[8], fy=-m[9], fz=-m[10];
    const fl=Math.sqrt(fx*fx+fy*fy+fz*fz)||1;
    return { eye:[ex,ey,ez], center:[ex+fx/fl,ey+fy/fl,ez+fz/fl], up:[0,1,0],
             fov:null, halfHeight:null };
  }

  // { eMatrix } — eye matrix (eye→world); eye = col3, forward = -col2
  if (spec.eMatrix != null) {
    const m = (ArrayBuffer.isView(spec.eMatrix) || Array.isArray(spec.eMatrix))
      ? spec.eMatrix : (spec.eMatrix.mat4 ?? null);
    if (!m || m.length < 16) return null;
    const ex=m[12], ey=m[13], ez=m[14];
    const fx=-m[8], fy=-m[9], fz=-m[10];
    const fl=Math.sqrt(fx*fx+fy*fy+fz*fz)||1;
    return { eye:[ex,ey,ez], center:[ex+fx/fl,ey+fy/fl,ez+fz/fl], up:[0,1,0],
             fov:null, halfHeight:null };
  }

  // { eye, center?, up? } — explicit lookat (eye is a vec3, not a mat4)
  const eye    = _parseVec3(spec.eye);
  if (!eye) return null;
  const center = _parseVec3(spec.center) || [0,0,0];
  const upRaw = spec.up ? _parseVec3(spec.up) : null;
  const up    = upRaw || [0,1,0];
  const ul    = Math.sqrt(up[0]*up[0]+up[1]*up[1]+up[2]*up[2]) || 1;
  return {
    eye, center,
    up: [up[0]/ul, up[1]/ul, up[2]/ul],
    fov:        typeof spec.fov        === 'number' ? spec.fov        : null,
    halfHeight: typeof spec.halfHeight === 'number' ? spec.halfHeight : null,
  };
}

function _sameCameraKeyframe(a, b) {
  for (let i=0;i<3;i++) {
    if (a.eye[i]!==b.eye[i]) return false;
    if (a.center[i]!==b.center[i]) return false;
    if (a.up[i]!==b.up[i]) return false;
  }
  if (a.fov !== b.fov) return false;
  if (a.halfHeight !== b.halfHeight) return false;
  return true;
}

// =========================================================================
// S5  Track — unexported base class (transport machinery only)
// =========================================================================

class Track {
  constructor() {
    /** @type {Array} Keyframe array — shape depends on subclass. */
    this.keyframes = [];
    /** Whether playback is active. @type {boolean} */
    this.playing   = false;
    /** Loop at boundaries. @type {boolean} */
    this.loop      = false;
    /** Ping-pong bounce (takes precedence over loop). @type {boolean} */
    this.pingPong  = false;
    /** Frames per segment (≥1). @type {number} */
    this.duration  = 30;
    /** Current segment index. @type {number} */
    this.seg       = 0;
    /** Frame offset within segment (can be fractional). @type {number} */
    this.f         = 0;

    // Internal rate — never directly starts/stops playback
    this._rate = 1;

    // User-space hooks
    /** @type {Function|null} */ this.onPlay = null;
    /** @type {Function|null} */ this.onEnd  = null;
    /** @type {Function|null} */ this.onStop = null;

    // Lib-space hooks (set by host layer, e.g. p5 bridge)
    /** @type {Function|null} */ this._onActivate   = null;
    /** @type {Function|null} */ this._onDeactivate = null;
  }

  /** Playback rate. Assigning never starts/stops playback. @type {number} */
  get rate()  { return this._rate; }
  set rate(v) { this._rate = (_isNum(v)) ? v : 1; }

  /** Number of interpolatable segments (keyframes.length − 1, min 0). @type {number} */
  get segments() { return Math.max(0, this.keyframes.length - 1); }

  /**
   * Start or update playback.
   * @param {number|Object} [rateOrOpts]  Numeric rate or options object:
   *   { rate, duration, loop, pingPong, onPlay, onEnd, onStop }
   * @returns {Track} this
   */
  play(rateOrOpts) {
    if (this.keyframes.length === 0) return this;

    // One keyframe: snap cursor, no animation
    if (this.keyframes.length === 1) {
      this.seg = 0; this.f = 0;
      return this;
    }

    if (typeof rateOrOpts === 'number' && Number.isFinite(rateOrOpts)) {
      this._rate = rateOrOpts;
    } else if (rateOrOpts && typeof rateOrOpts === 'object') {
      const o = rateOrOpts;
      if (_isNum(o.duration))             this.duration = Math.max(1, o.duration | 0);
      if ('loop'     in o)                this.loop     = !!o.loop;
      if ('pingPong' in o)                this.pingPong = !!o.pingPong;
      if (typeof o.onPlay === 'function') this.onPlay   = o.onPlay;
      if (typeof o.onEnd  === 'function') this.onEnd    = o.onEnd;
      if (typeof o.onStop === 'function') this.onStop   = o.onStop;
      if (_isNum(o.rate))                 this._rate    = o.rate;
    }

    const nSeg = this.segments, dur = Math.max(1, this.duration | 0);
    if (this.seg < 0)     this.seg = 0;
    if (this.seg >= nSeg) this.seg = nSeg - 1;
    if (this.f   < 0)     this.f   = 0;
    if (this.f   > dur)   this.f   = dur;

    const wasPlaying = this.playing;
    this.playing = true;
    if (!wasPlaying) {
      if (typeof this.onPlay === 'function') { try { this.onPlay(this); } catch (_) {} }
      this._onActivate?.();
    }
    return this;
  }

  /**
   * Stop playback.
   * @param {boolean} [rewind=false]  Seek to origin after stopping.
   * @returns {Track} this
   */
  stop(rewind) {
    const wasPlaying = this.playing;
    this.playing = false;
    if (wasPlaying) {
      if (typeof this.onStop === 'function') { try { this.onStop(this); } catch (_) {} }
      this._onDeactivate?.();
      if (rewind && this.keyframes.length > 1) this.seek(this._rate < 0 ? 1 : 0);
    }
    return this;
  }

  /**
   * Clear all keyframes and stop.
   * @returns {Track} this
   */
  reset() {
    const wasPlaying = this.playing;
    this.playing = false;
    if (wasPlaying) {
      if (typeof this.onStop === 'function') { try { this.onStop(this); } catch (_) {} }
      this._onDeactivate?.();
    }
    this.keyframes.length = 0;
    this.seg = 0; this.f = 0;
    return this;
  }

  /**
   * Remove the keyframe at index. Adjusts cursor if needed.
   * @param {number} index
   * @returns {boolean}
   */
  remove(index) {
    if (!_isNum(index)) return false;
    const i = index | 0;
    if (i < 0 || i >= this.keyframes.length) return false;
    this.keyframes.splice(i, 1);
    const nSeg = this.segments;
    if (nSeg === 0) { this.seg = 0; this.f = 0; }
    else if (this.seg >= nSeg) { this.seg = nSeg - 1; }
    return true;
  }

  /**
   * Seek to a normalised position [0,1] across the full path.
   * @param {number} t           Normalised time [0, 1].
   * @param {number} [segIndex]  Optional segment override.
   * @returns {Track} this
   */
  seek(t, segIndex) {
    const nSeg = this.segments;
    if (nSeg === 0) { this.seg = 0; this.f = 0; return this; }
    const dur = Math.max(1, this.duration | 0);
    if (_isNum(segIndex)) {
      this.seg = _clampS(segIndex | 0, 0, nSeg - 1);
      this.f   = _clamp01(t) * dur;
    } else {
      this._setCursorFromScalar(_clamp01(t) * nSeg * dur);
    }
    return this;
  }

  /**
   * Normalised playback position [0,1].
   * @returns {number}
   */
  time() {
    const nSeg = this.segments;
    if (nSeg === 0) return 0;
    const dur = Math.max(1, this.duration | 0);
    return _clamp01((this.seg * dur + this.f) / (nSeg * dur));
  }

  /**
   * Snapshot of transport state.
   * @returns {Object}
   */
  info() {
    return {
      keyframes: this.keyframes.length,
      segments:  this.segments,
      seg:       this.seg,
      f:         this.f,
      playing:   this.playing,
      loop:      this.loop,
      pingPong:  this.pingPong,
      rate:      this._rate,
      duration:  this.duration,
      time:      this.segments > 0 ? this.time() : 0
    };
  }

  /**
   * Advance cursor by rate frames.
   * Returns true while playing, false when stopping.
   * @returns {boolean}
   */
  tick() {
    if (!this.playing) return false;
    const nSeg = this.segments;
    if (nSeg === 0) {
      this.playing = false; this._onDeactivate?.(); return false;
    }
    if (this._rate === 0) return true;

    const dur   = Math.max(1, this.duration | 0);
    const total = nSeg * dur;
    const s     = _clampS(this.seg * dur + this.f, 0, total);
    const next  = s + this._rate;

    if (this.pingPong) {
      let pos = next, flips = 0;
      while (pos < 0 || pos > total) {
        if (pos < 0) { pos = -pos; flips++; }
        else         { pos = 2 * total - pos; flips++; }
      }
      if (flips & 1) this._rate = -this._rate;
      this._setCursorFromScalar(pos);
      return true;
    }

    if (this.loop) {
      this._setCursorFromScalar(((next % total) + total) % total);
      return true;
    }

    if (next <= 0) {
      this._setCursorFromScalar(0);
      this.playing = false;
      if (typeof this.onEnd === 'function') { try { this.onEnd(this); } catch (_) {} }
      this._onDeactivate?.();
      return false;
    }
    if (next >= total) {
      this._setCursorFromScalar(total);
      this.playing = false;
      if (typeof this.onEnd === 'function') { try { this.onEnd(this); } catch (_) {} }
      this._onDeactivate?.();
      return false;
    }

    this._setCursorFromScalar(next);
    return true;
  }

  /** @private */
  _setCursorFromScalar(s) {
    const dur  = Math.max(1, this.duration | 0);
    const nSeg = this.segments;
    this.seg = Math.floor(s / dur);
    this.f   = s - this.seg * dur;
    if (this.seg >= nSeg) { this.seg = nSeg - 1; this.f = dur; }
    if (this.seg < 0)     { this.seg = 0;         this.f = 0;   }
  }
}

// =========================================================================
// S6  PoseTrack
// =========================================================================

/**
 * Renderer-agnostic TRS keyframe track.
 *
 * Keyframe shape: { pos:[x,y,z], rot:[x,y,z,w], scl:[x,y,z] }
 *
 * add() accepts individual specs or a bulk array of specs:
 *
 *   { mMatrix }                           — full TRS from model matrix
 *   { pos?, rot?, scl? }                  — direct TRS; all fields optional
 *   { pos?, rot: [x,y,z,w] }             — explicit quaternion
 *   { pos?, rot: { axis, angle } }        — axis-angle
 *   { pos?, rot: { dir, up? } }           — look direction
 *   { pos?, rot: { eMatrix: mat4 } }      — rotation from eye matrix
 *   { pos?, rot: { mat3 } }               — column-major 3×3 rotation matrix
 *   { pos?, rot: { euler, order? } }      — intrinsic Euler angles (default YXZ)
 *   { pos?, rot: { from, to } }           — shortest-arc between two directions
 *   [ spec, spec, ... ]                   — bulk
 *
 * Missing fields default to: pos → [0,0,0], rot → [0,0,0,1], scl → [1,1,1].
 *
 * eval() writes { pos, rot, scl }:
 *   pos — Catmull-Rom (posInterp='catmullrom') or lerp
 *   rot — slerp (rotInterp='slerp') or nlerp
 *   scl — lerp
 *
 * @example
 * const track = new PoseTrack()
 * track.add({ pos:[0,0,0] })                           // identity rot, uniform scl
 * track.add({ pos:[100,0,0], rot: { euler:[0, Math.PI/2, 0] } })
 * track.add({ rot: { axis:[0,1,0], angle: Math.PI } }) // pos defaults to [0,0,0]
 * track.add({ mMatrix: someModelMatrix })
 * track.play({ loop: true })
 * // per frame:
 * track.tick()
 * const out = { pos:[0,0,0], rot:[0,0,0,1], scl:[1,1,1] }
 * track.eval(out)
 */
export class PoseTrack extends Track {
  constructor() {
    super();
    /**
     * Position interpolation mode.
     * @type {'catmullrom'|'linear'}
     */
    this.posInterp = 'catmullrom';
    /**
     * Rotation interpolation mode.
     * - 'slerp'  — constant angular velocity (default)
     * - 'nlerp'  — normalised lerp; cheaper, slightly non-constant speed
     * @type {'slerp'|'nlerp'}
     */
    this.rotInterp = 'slerp';
    // Scratch for toMatrix() — avoids hot-path allocations
    this._pos = [0,0,0];
    this._rot = [0,0,0,1];
    this._scl = [1,1,1];
  }

  /**
   * Append one or more keyframes. Adjacent duplicates are skipped by default.
   * @param {Object|Object[]} spec
   * @param {{ deduplicate?: boolean }} [opts]
   */
  add(spec, opts) {
    if (Array.isArray(spec)) {
      for (const s of spec) this.add(s, opts);
      return;
    }
    const kf = _parseSpec(spec);
    if (!kf) return;
    const dedup = !opts || opts.deduplicate !== false;
    if (dedup && this.keyframes.length > 0) {
      if (_sameTransform(this.keyframes[this.keyframes.length - 1], kf)) return;
    }
    this.keyframes.push(kf);
  }

  /**
   * Replace (or append at end) the keyframe at index.
   * @param {number} index
   * @param {Object} spec
   * @returns {boolean}
   */
  set(index, spec) {
    if (!_isNum(index)) return false;
    const i = index | 0, kf = _parseSpec(spec);
    if (!kf || i < 0 || i > this.keyframes.length) return false;
    if (i === this.keyframes.length) this.keyframes.push(kf);
    else this.keyframes[i] = kf;
    return true;
  }

  /**
   * Evaluate interpolated TRS pose at current cursor.
   * @param {{ pos:number[], rot:number[], scl:number[] }} [out]
   * @returns {{ pos:number[], rot:number[], scl:number[] }} out
   */
  eval(out) {
    out = out || { pos:[0,0,0], rot:[0,0,0,1], scl:[1,1,1] };
    const n = this.keyframes.length;
    if (n === 0) return out;

    if (n === 1) {
      const k = this.keyframes[0];
      out.pos[0]=k.pos[0]; out.pos[1]=k.pos[1]; out.pos[2]=k.pos[2];
      out.rot[0]=k.rot[0]; out.rot[1]=k.rot[1]; out.rot[2]=k.rot[2]; out.rot[3]=k.rot[3];
      out.scl[0]=k.scl[0]; out.scl[1]=k.scl[1]; out.scl[2]=k.scl[2];
      return out;
    }

    const nSeg = n - 1;
    const dur  = Math.max(1, this.duration | 0);
    const seg  = _clampS(this.seg, 0, nSeg - 1);
    const t    = _clamp01(this.f / dur);
    const k0   = this.keyframes[seg];
    const k1   = this.keyframes[seg + 1];

    // pos — Catmull-Rom or lerp
    if (this.posInterp === 'catmullrom') {
      const p0 = seg > 0      ? this.keyframes[seg - 1].pos : k0.pos;
      const p3 = seg + 2 < n ? this.keyframes[seg + 2].pos : k1.pos;
      catmullRomVec3(out.pos, p0, k0.pos, k1.pos, p3, t);
    } else {
      lerpVec3(out.pos, k0.pos, k1.pos, t);
    }

    // rot — slerp or nlerp
    if (this.rotInterp === 'nlerp') {
      qNlerp(out.rot, k0.rot, k1.rot, t);
    } else {
      qSlerp(out.rot, k0.rot, k1.rot, t);
    }

    // scl — lerp
    lerpVec3(out.scl, k0.scl, k1.scl, t);

    return out;
  }

  /**
   * Evaluate into an existing column-major mat4.
   * @param {Float32Array|number[]} outMat4  16-element array.
   * @returns {Float32Array|number[]} outMat4
   */
  toMatrix(outMat4) {
    const xf = this.eval({ pos: this._pos, rot: this._rot, scl: this._scl });
    return transformToMat4(outMat4, xf);
  }
}

// =========================================================================
// S7  CameraTrack
// =========================================================================

/**
 * Lookat camera keyframe track.
 *
 * Keyframe shape: { eye:[x,y,z], center:[x,y,z], up:[x,y,z], fov?:number, halfHeight?:number }
 *
 * fov        — vertical fov (radians) for perspective cameras; null for ortho.
 * halfHeight — world-unit half-height of ortho frustum; null for perspective.
 * Both are optional and nullable. eval() lerps each only when both adjacent
 * keyframes carry a non-null value for that field.
 *
 * Each field is independently interpolated — eye and center along their
 * own paths, up nlerped on the unit sphere. This correctly handles cameras
 * that always look at a fixed target (center stays at origin throughout)
 * as well as free-fly paths where center moves independently.
 * 
 * Missing fields default to: center → [0,0,0], up → [0,1,0].
 *
 * add() accepts individual specs or a bulk array of specs:
 *
 *   { eye, center?, up?, fov?, halfHeight? }
 *                         explicit lookat; center defaults to [0,0,0], up to [0,1,0].
 *                         fov and halfHeight are mutually exclusive nullable scalars.
 *   { vMatrix: mat4 }      view matrix (world→eye); eye reconstructed via -R^T·t
 *   { eMatrix: mat4 }      eye matrix (eye→world); eye read from col3 directly
 *   [ spec, spec, ... ]    bulk
 *
 * Note on up for matrix forms:
 *   up is always [0,1,0].  The matrix's col1 (up_ortho) is intentionally
 *   not used — it differs from the hint [0,1,0] for upright cameras and
 *   passing it to cam.camera() shifts orbitControl's orbit reference.
 *   Use capturePose() (p5.tree bridge) when the real up hint is needed.
 *
 * eval() writes { eye, center, up, fov, halfHeight }:
 *   eye        — Catmull-Rom (eyeInterp='catmullrom') or lerp
 *   center     — Catmull-Rom (centerInterp='catmullrom') or lerp
 *   up         — nlerp (normalize-after-lerp on unit sphere)
 *   fov        — lerp when both keyframes carry non-null fov; else null
 *   halfHeight — lerp when both keyframes carry non-null halfHeight; else null
 *
 * @example
 * const track = new CameraTrack()
 * track.add({ eye:[0,0,500] })                 // center defaults to [0,0,0]
 * track.add({ eye:[300,-150,0], center:[0,0,0] })
 * track.add({ eMatrix: myEyeMatrix })
 * track.add({ vMatrix: myViewMatrix })
 * track.play({ loop: true })
 * // per frame:
 * track.tick()
 * const out = { eye:[0,0,0], center:[0,0,0], up:[0,1,0] }
 * track.eval(out)
 * cam.camera(out.eye[0],out.eye[1],out.eye[2],
 *            out.center[0],out.center[1],out.center[2],
 *            out.up[0],out.up[1],out.up[2])
 */
export class CameraTrack extends Track {
  constructor() {
    super();
    /**
     * Eye position interpolation mode.
     * @type {'catmullrom'|'linear'}
     */
    this.eyeInterp = 'catmullrom';
    /**
     * Center (lookat target) interpolation mode.
     * 'linear' suits fixed or predictably moving targets.
     * 'catmullrom' gives smoother paths when center is also flying freely.
     * @type {'catmullrom'|'linear'}
     */
    this.centerInterp = 'linear';
    // Scratch for toCamera() — avoids hot-path allocations
    this._eye    = [0,0,0];
    this._center = [0,0,0];
    this._up     = [0,1,0];
  }

  /**
   * Append one or more camera keyframes. Adjacent duplicates are skipped by default.
   *
   * @param {Object|Object[]} spec
   *   { eye, center?, up? }  or  { vMatrix: mat4 }  or  { eMatrix: mat4 }  or  an array of either.
   * @param {{ deduplicate?: boolean }} [opts]
   */
  add(spec, opts) {
    if (Array.isArray(spec)) {
      for (const s of spec) this.add(s, opts);
      return;
    }
    const kf = _parseCameraSpec(spec);
    if (!kf) return;
    const dedup = !opts || opts.deduplicate !== false;
    if (dedup && this.keyframes.length > 0) {
      if (_sameCameraKeyframe(this.keyframes[this.keyframes.length - 1], kf)) return;
    }
    this.keyframes.push(kf);
  }

  /**
   * Replace (or append at end) the keyframe at index.
   * @param {number} index
   * @param {Object} spec
   * @returns {boolean}
   */
  set(index, spec) {
    if (!_isNum(index)) return false;
    const i = index | 0, kf = _parseCameraSpec(spec);
    if (!kf || i < 0 || i > this.keyframes.length) return false;
    if (i === this.keyframes.length) this.keyframes.push(kf);
    else this.keyframes[i] = kf;
    return true;
  }

  /**
   * Evaluate interpolated camera pose at current cursor.
   *
   * @param {{ eye:number[], center:number[], up:number[] }} [out]
   * @returns {{ eye:number[], center:number[], up:number[] }} out
   */
  eval(out) {
    out = out || { eye:[0,0,0], center:[0,0,0], up:[0,1,0], fov:null, halfHeight:null };
    const n = this.keyframes.length;
    if (n === 0) return out;

    if (n === 1) {
      const k = this.keyframes[0];
      out.eye[0]=k.eye[0];       out.eye[1]=k.eye[1];       out.eye[2]=k.eye[2];
      out.center[0]=k.center[0]; out.center[1]=k.center[1]; out.center[2]=k.center[2];
      out.up[0]=k.up[0];         out.up[1]=k.up[1];         out.up[2]=k.up[2];
      out.fov        = k.fov;
      out.halfHeight = k.halfHeight;
      return out;
    }

    const nSeg = n - 1;
    const dur  = Math.max(1, this.duration | 0);
    const seg  = _clampS(this.seg, 0, nSeg - 1);
    const t    = _clamp01(this.f / dur);
    const k0   = this.keyframes[seg];
    const k1   = this.keyframes[seg + 1];

    // eye — Catmull-Rom or lerp
    if (this.eyeInterp === 'catmullrom') {
      const p0 = seg > 0      ? this.keyframes[seg - 1].eye : k0.eye;
      const p3 = seg + 2 < n ? this.keyframes[seg + 2].eye : k1.eye;
      catmullRomVec3(out.eye, p0, k0.eye, k1.eye, p3, t);
    } else {
      lerpVec3(out.eye, k0.eye, k1.eye, t);
    }

    // center — Catmull-Rom or lerp (independent lookat target)
    if (this.centerInterp === 'catmullrom') {
      const c0 = seg > 0      ? this.keyframes[seg - 1].center : k0.center;
      const c3 = seg + 2 < n ? this.keyframes[seg + 2].center : k1.center;
      catmullRomVec3(out.center, c0, k0.center, k1.center, c3, t);
    } else {
      lerpVec3(out.center, k0.center, k1.center, t);
    }

    // up — nlerp (normalize after lerp; correct for typical near-upright cameras)
    const ux = k0.up[0] + t*(k1.up[0]-k0.up[0]);
    const uy = k0.up[1] + t*(k1.up[1]-k0.up[1]);
    const uz = k0.up[2] + t*(k1.up[2]-k0.up[2]);
    const ul = Math.sqrt(ux*ux+uy*uy+uz*uz) || 1;
    out.up[0]=ux/ul; out.up[1]=uy/ul; out.up[2]=uz/ul;

    // fov — lerp (perspective); null when either keyframe lacks it
    out.fov        = (k0.fov        !== null && k1.fov        !== null)
      ? k0.fov        + t * (k1.fov        - k0.fov)        : null;
    // halfHeight — lerp (ortho); null when either keyframe lacks it
    out.halfHeight = (k0.halfHeight !== null && k1.halfHeight !== null)
      ? k0.halfHeight + t * (k1.halfHeight - k0.halfHeight) : null;

    return out;
  }
}
