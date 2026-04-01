/**
 * @file Matrix arithmetic, space-transform dispatch, and projection queries.
 * @module tree/query
 * @license AGPL-3.0-only
 *
 * The operative layer — receives existing matrices and extracts information.
 * Contrast with form.js which constructs matrices from specs.
 *
 *   form.js  — you have specs, you want a matrix
 *   query.js  — you have a matrix, you want information
 *
 * No dependency on form.js. Operating on matrices requires no knowledge
 * of how they were constructed.
 *
 * Storage: column-major Float32Array / ArrayLike<number>.
 * Element [col*4 + row] = M[row, col].
 *
 * Multiply: mat4Mul(out, A, B) = A · B  (standard math order).
 *
 * Pipeline: clip = P · V · M · v
 *   P = projection (eye → clip)
 *   V = view       (world → eye)
 *   M = model      (local → world)
 *
 * NDC convention parameter (ndcZMin):
 *   WEBGL  = -1   z ∈ [−1, 1]
 *   WEBGPU =  0   z ∈ [0, 1]
 *
 * All functions follow the out-first, zero-allocation contract.
 * Returns null on degeneracy (singular matrix, etc.).
 */

'use strict';

import {
  WORLD, EYE, NDC, SCREEN, MATRIX,
} from './constants.js';

// ═══════════════════════════════════════════════════════════════════════════
// Mat4 math
// ═══════════════════════════════════════════════════════════════════════════

/** out = A · B  (column-major, standard math order) */
export function mat4Mul(out, A, B) {
  const a0=A[0],a1=A[1],a2=A[2],a3=A[3],
        a4=A[4],a5=A[5],a6=A[6],a7=A[7],
        a8=A[8],a9=A[9],a10=A[10],a11=A[11],
        a12=A[12],a13=A[13],a14=A[14],a15=A[15];
  let b0=B[0],b1=B[1],b2=B[2],b3=B[3];
  out[0]=a0*b0+a4*b1+a8*b2+a12*b3;
  out[1]=a1*b0+a5*b1+a9*b2+a13*b3;
  out[2]=a2*b0+a6*b1+a10*b2+a14*b3;
  out[3]=a3*b0+a7*b1+a11*b2+a15*b3;
  b0=B[4];b1=B[5];b2=B[6];b3=B[7];
  out[4]=a0*b0+a4*b1+a8*b2+a12*b3;
  out[5]=a1*b0+a5*b1+a9*b2+a13*b3;
  out[6]=a2*b0+a6*b1+a10*b2+a14*b3;
  out[7]=a3*b0+a7*b1+a11*b2+a15*b3;
  b0=B[8];b1=B[9];b2=B[10];b3=B[11];
  out[8]=a0*b0+a4*b1+a8*b2+a12*b3;
  out[9]=a1*b0+a5*b1+a9*b2+a13*b3;
  out[10]=a2*b0+a6*b1+a10*b2+a14*b3;
  out[11]=a3*b0+a7*b1+a11*b2+a15*b3;
  b0=B[12];b1=B[13];b2=B[14];b3=B[15];
  out[12]=a0*b0+a4*b1+a8*b2+a12*b3;
  out[13]=a1*b0+a5*b1+a9*b2+a13*b3;
  out[14]=a2*b0+a6*b1+a10*b2+a14*b3;
  out[15]=a3*b0+a7*b1+a11*b2+a15*b3;
  return out;
}

/** out = inverse(src).  Returns null if singular. */
export function mat4Invert(out, src) {
  const s=src;
  const a00=s[0],a01=s[1],a02=s[2],a03=s[3],
        a10=s[4],a11=s[5],a12=s[6],a13=s[7],
        a20=s[8],a21=s[9],a22=s[10],a23=s[11],
        a30=s[12],a31=s[13],a32=s[14],a33=s[15];
  const b00=a00*a11-a01*a10,b01=a00*a12-a02*a10,
        b02=a00*a13-a03*a10,b03=a01*a12-a02*a11,
        b04=a01*a13-a03*a11,b05=a02*a13-a03*a12,
        b06=a20*a31-a21*a30,b07=a20*a32-a22*a30,
        b08=a20*a33-a23*a30,b09=a21*a32-a22*a31,
        b10=a21*a33-a23*a31,b11=a22*a33-a23*a32;
  let det=b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;
  if (Math.abs(det) < 1e-12) return null;
  det=1/det;
  out[0]=(a11*b11-a12*b10+a13*b09)*det;
  out[1]=(a02*b10-a01*b11-a03*b09)*det;
  out[2]=(a31*b05-a32*b04+a33*b03)*det;
  out[3]=(a22*b04-a21*b05-a23*b03)*det;
  out[4]=(a12*b08-a10*b11-a13*b07)*det;
  out[5]=(a00*b11-a02*b08+a03*b07)*det;
  out[6]=(a32*b02-a30*b05-a33*b01)*det;
  out[7]=(a20*b05-a22*b02+a23*b01)*det;
  out[8]=(a10*b10-a11*b08+a13*b06)*det;
  out[9]=(a01*b08-a00*b10-a03*b06)*det;
  out[10]=(a30*b04-a31*b02+a33*b00)*det;
  out[11]=(a21*b02-a20*b04-a23*b00)*det;
  out[12]=(a11*b07-a10*b09-a12*b06)*det;
  out[13]=(a00*b09-a01*b07+a02*b06)*det;
  out[14]=(a31*b01-a30*b03-a32*b00)*det;
  out[15]=(a20*b03-a21*b01+a22*b00)*det;
  return out;
}

/** out = transpose(src) */
export function mat4Transpose(out, src) {
  if (out === src) {
    let t;
    t=src[1];out[1]=src[4];out[4]=t;
    t=src[2];out[2]=src[8];out[8]=t;
    t=src[3];out[3]=src[12];out[12]=t;
    t=src[6];out[6]=src[9];out[9]=t;
    t=src[7];out[7]=src[13];out[13]=t;
    t=src[11];out[11]=src[14];out[14]=t;
  } else {
    out[0]=src[0];out[1]=src[4];out[2]=src[8];out[3]=src[12];
    out[4]=src[1];out[5]=src[5];out[6]=src[9];out[7]=src[13];
    out[8]=src[2];out[9]=src[6];out[10]=src[10];out[11]=src[14];
    out[12]=src[3];out[13]=src[7];out[14]=src[11];out[15]=src[15];
  }
  return out;
}

/** out[0..8] = inverseTranspose(upper3×3(src))  (normal matrix) */
export function mat3NormalFromMat4(out, src) {
  const a00=src[0],a01=src[1],a02=src[2],
        a10=src[4],a11=src[5],a12=src[6],
        a20=src[8],a21=src[9],a22=src[10];
  const b01=a22*a11-a12*a21,
        b11=-a22*a01+a02*a21,
        b21=a12*a01-a02*a11;
  let det=a00*b01+a10*b11+a20*b21;
  if (Math.abs(det) < 1e-12) { for(let i=0;i<9;i++)out[i]=0; return out; }
  det=1/det;
  out[0]=b01*det;
  out[1]=(-a22*a10+a12*a20)*det;
  out[2]=(a21*a10-a11*a20)*det;
  out[3]=b11*det;
  out[4]=(a22*a00-a02*a20)*det;
  out[5]=(-a21*a00+a01*a20)*det;
  out[6]=b21*det;
  out[7]=(-a12*a00+a02*a10)*det;
  out[8]=(a11*a00-a01*a10)*det;
  return out;
}

/** out = mat4 * [x,y,z,1], perspective-divides, writes xyz */
export function mat4MulPoint(out, m, x, y, z) {
  const rx = m[0]*x + m[4]*y + m[8]*z  + m[12];
  const ry = m[1]*x + m[5]*y + m[9]*z  + m[13];
  const rz = m[2]*x + m[6]*y + m[10]*z + m[14];
  const rw = m[3]*x + m[7]*y + m[11]*z + m[15];
  if (rw !== 0 && rw !== 1) {
    out[0] = rx/rw; out[1] = ry/rw; out[2] = rz/rw;
  } else {
    out[0] = rx; out[1] = ry; out[2] = rz;
  }
  return out;
}

/**
 * Apply only the 3×3 linear block of a mat4 to a direction vector.
 * No translation, no perspective divide. Suitable for directions and normals
 * when the matrix is known to be orthogonal (use mat3NormalFromMat4 for normals
 * under non-uniform scale).
 *
 * @param {Float32Array|number[]} out  3-element destination.
 * @param {Float32Array|number[]} m    16-element mat4.
 * @param {number} dx,dy,dz           Input direction.
 * @returns {Float32Array|number[]} out
 */
export function mat4MulDir(out, m, dx, dy, dz) {
  out[0] = m[0]*dx + m[4]*dy + m[8]*dz;
  out[1] = m[1]*dx + m[5]*dy + m[9]*dz;
  out[2] = m[2]*dx + m[6]*dy + m[10]*dz;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Projection queries  (read scalars from a projection mat4)
// ═══════════════════════════════════════════════════════════════════════════

/** @returns {boolean} true if orthographic */
export function projIsOrtho(p) { return p[15] !== 0; }

/**
 * Near plane distance.
 * @param {ArrayLike<number>} p  Projection Mat4.
 * @param {number} ndcZMin  WEBGL (−1) or WEBGPU (0).
 */
export function projNear(p, ndcZMin) {
  return p[15] === 0
    ? p[14] / (p[10] + ndcZMin)
    : (p[14] - ndcZMin) / p[10];
}

/** Far plane distance (convention-independent: far always maps to NDC z=1). */
export function projFar(p) {
  return p[15] === 0
    ? p[14] / (1 + p[10])
    : (p[14] - 1) / p[10];
}

export function projLeft(p, ndcZMin) {
  return p[15] === 1
    ? -(1 + p[12]) / p[0]
    : projNear(p, ndcZMin) * (p[8] - 1) / p[0];
}

export function projRight(p, ndcZMin) {
  return p[15] === 1
    ? (1 - p[12]) / p[0]
    : projNear(p, ndcZMin) * (1 + p[8]) / p[0];
}

export function projTop(p, ndcZMin) {
  return p[15] === 1
    ? (p[13] - 1) / p[5]
    : projNear(p, ndcZMin) * (p[9] - 1) / p[5];
}

export function projBottom(p, ndcZMin) {
  return p[15] === 1
    ? (1 + p[13]) / p[5]
    : projNear(p, ndcZMin) * (1 + p[9]) / p[5];
}

/** Vertical fov (radians, perspective only). */
export function projFov(p) {
  return Math.abs(2 * Math.atan(1 / p[5]));
}

/** Horizontal fov (radians, perspective only). */
export function projHfov(p) {
  return Math.abs(2 * Math.atan(1 / p[0]));
}

// ═══════════════════════════════════════════════════════════════════════════
// Derived matrices (convenience)
// ═══════════════════════════════════════════════════════════════════════════

/** out = P · V */
export function mat4PV(out, proj, view) { return mat4Mul(out, proj, view); }

/** out = V · M */
export function mat4MV(out, model, view) { return mat4Mul(out, view, model); }

// ═══════════════════════════════════════════════════════════════════════════
// Location / Direction transforms
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Relative transform for locations (points): out = inv(to) · from.
 * @param {ArrayLike<number>} out   16-element destination.
 * @param {ArrayLike<number>} from  Source frame transform.
 * @param {ArrayLike<number>} to    Destination frame transform.
 * @returns {ArrayLike<number>|null} out, or null if to is singular.
 */
export function mat4Location(out, from, to) {
  return mat4Invert(out, to) && mat4Mul(out, out, from);
}

/**
 * Relative transform for directions (vectors): out = to₃ · inv(from₃).
 * Uses only the upper-left 3×3 blocks, ignoring translation.
 * @param {ArrayLike<number>} out   9-element destination.
 * @param {ArrayLike<number>} from  Source frame transform.
 * @param {ArrayLike<number>} to    Destination frame transform.
 * @returns {ArrayLike<number>|null} out, or null if from is singular.
 */
export function mat3Direction(out, from, to) {
  const a00=from[0], a01=from[1], a02=from[2],
        a10=from[4], a11=from[5], a12=from[6],
        a20=from[8], a21=from[9], a22=from[10];
  const b01=a22*a11-a12*a21,
        b11=a12*a20-a22*a10,
        b21=a21*a10-a11*a20;
  let det=a00*b01+a01*b11+a02*b21;
  if (Math.abs(det) < 1e-12) return null;
  det=1/det;
  const i00=b01*det, i01=(a02*a21-a22*a01)*det, i02=(a12*a01-a02*a11)*det;
  const i10=b11*det, i11=(a22*a00-a02*a20)*det, i12=(a02*a10-a12*a00)*det;
  const i20=b21*det, i21=(a01*a20-a21*a00)*det, i22=(a11*a00-a01*a10)*det;
  const t00=to[0], t01=to[1], t02=to[2],
        t10=to[4], t11=to[5], t12=to[6],
        t20=to[8], t21=to[9], t22=to[10];
  const m00=t00*i00+t10*i01+t20*i02, m01=t01*i00+t11*i01+t21*i02, m02=t02*i00+t12*i01+t22*i02;
  const m10=t00*i10+t10*i11+t20*i12, m11=t01*i10+t11*i11+t21*i12, m12=t02*i10+t12*i11+t22*i12;
  const m20=t00*i20+t10*i21+t20*i22, m21=t01*i20+t11*i21+t21*i22, m22=t02*i20+t12*i21+t22*i22;
  out[0]=m00; out[1]=m10; out[2]=m20;
  out[3]=m01; out[4]=m11; out[5]=m21;
  out[6]=m02; out[7]=m12; out[8]=m22;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Space transforms — mapLocation / mapDirection
// ═══════════════════════════════════════════════════════════════════════════
//
// FLAT DISPATCH: every from→to pair is a self-contained leaf.
// No path calls back into mapLocation/mapDirection (no reentrancy).
// All intermediates are stack locals (zero shared state).
//
// Matrices bag m:
//   {
//     pMatrix:    Float32Array(16)  — projection (eye → clip)
//     vMatrix:    Float32Array(16)  — view        (world → eye)
//     eMatrix?:   Float32Array(16)  — eye         (eye → world, inv view); lazy
//     pvMatrix?:  Float32Array(16)  — P · V;      lazy
//     ipvMatrix?: Float32Array(16)  — inv(P · V); lazy
//     fromFrame?: Float32Array(16)  — MATRIX source frame (custom space)
//     toFrameInv?:Float32Array(16)  — inv(MATRIX dest frame)
//   }
//

// ── Location leaf helpers ────────────────────────────────────────────────

function _worldToScreen(out, px, py, pz, pv, vp, ndcZMin) {
  const x = pv[0]*px+pv[4]*py+pv[8]*pz+pv[12];
  const y = pv[1]*px+pv[5]*py+pv[9]*pz+pv[13];
  const z = pv[2]*px+pv[6]*py+pv[10]*pz+pv[14];
  const w = pv[3]*px+pv[7]*py+pv[11]*pz+pv[15];
  const xi = (w !== 0 && w !== 1) ? 1/w : 1;
  const nx = x*xi, ny = y*xi, nz = z*xi;
  const vpX=vp[0], vpY=vp[1], vpW=Math.abs(vp[2]), vpH=Math.abs(vp[3]);
  out[0] = vpX + vpW * (nx + 1) * 0.5;
  out[1] = vpY + vpH * (1 - (ny + 1) * 0.5);
  out[2] = (nz - ndcZMin) / (1 - ndcZMin);
  return out;
}

function _screenToWorld(out, sx, sy, sz, ipv, vp, ndcZMin) {
  const vpX=vp[0], vpY=vp[1], vpW=Math.abs(vp[2]), vpH=Math.abs(vp[3]);
  const nx = (sx - vpX) / vpW * 2 - 1;
  const ny = 1 - (sy - vpY) / vpH * 2;
  const nz = sz * (1 - ndcZMin) + ndcZMin;
  return mat4MulPoint(out, ipv, nx, ny, nz);
}

function _worldToNDC(out, px, py, pz, pv) {
  const x=pv[0]*px+pv[4]*py+pv[8]*pz+pv[12];
  const y=pv[1]*px+pv[5]*py+pv[9]*pz+pv[13];
  const z=pv[2]*px+pv[6]*py+pv[10]*pz+pv[14];
  const w=pv[3]*px+pv[7]*py+pv[11]*pz+pv[15];
  const xi = (w !== 0 && w !== 1) ? 1/w : 1;
  out[0]=x*xi; out[1]=y*xi; out[2]=z*xi;
  return out;
}

function _ndcToWorld(out, nx, ny, nz, ipv) {
  return mat4MulPoint(out, ipv, nx, ny, nz);
}

function _screenToNDC(out, sx, sy, sz, vp, ndcZMin) {
  const vpX=vp[0], vpY=vp[1], vpW=Math.abs(vp[2]), vpH=Math.abs(vp[3]);
  out[0] = (sx - vpX) / vpW * 2 - 1;
  out[1] = 1 - (sy - vpY) / vpH * 2;
  out[2] = sz * (1 - ndcZMin) + ndcZMin;
  return out;
}

function _ndcToScreen(out, nx, ny, nz, vp, ndcZMin) {
  const vpX=vp[0], vpY=vp[1], vpW=Math.abs(vp[2]), vpH=Math.abs(vp[3]);
  out[0] = vpX + vpW * (nx + 1) * 0.5;
  out[1] = vpY + vpH * (1 - (ny + 1) * 0.5);
  out[2] = (nz - ndcZMin) / (1 - ndcZMin);
  return out;
}

function _ensurePV(m) {
  if (m.pvMatrix) return m.pvMatrix;
  m.pvMatrix = new Float32Array(16);
  mat4Mul(m.pvMatrix, m.pMatrix, m.vMatrix);
  return m.pvMatrix;
}

/**
 * Map a point between named coordinate spaces.
 *
 * @param {Vec3}   out         Result written here.
 * @param {number} px,py,pz    Input point.
 * @param {string} from        Source space constant.
 * @param {string} to          Target space constant.
 * @param {object} m           Matrices bag:
 *   { pMatrix, vMatrix, eMatrix?, pvMatrix?, ipvMatrix?, fromFrame?, toFrameInv? }
 * @param {Vec4}   vp          Viewport [x, y, width, height].
 * @param {number} ndcZMin     WEBGL (−1) or WEBGPU (0).
 */
export function mapLocation(out, px, py, pz, from, to, m, vp, ndcZMin) {
  // WORLD ↔ SCREEN
  if (from === WORLD && to === SCREEN)
    return _worldToScreen(out, px,py,pz, _ensurePV(m), vp, ndcZMin);
  if (from === SCREEN && to === WORLD)
    return _screenToWorld(out, px,py,pz, m.ipvMatrix, vp, ndcZMin);

  // WORLD ↔ NDC
  if (from === WORLD && to === NDC)
    return _worldToNDC(out, px,py,pz, _ensurePV(m));
  if (from === NDC && to === WORLD)
    return _ndcToWorld(out, px,py,pz, m.ipvMatrix);

  // SCREEN ↔ NDC
  if (from === SCREEN && to === NDC)
    return _screenToNDC(out, px,py,pz, vp, ndcZMin);
  if (from === NDC && to === SCREEN)
    return _ndcToScreen(out, px,py,pz, vp, ndcZMin);

  // WORLD ↔ EYE
  if (from === WORLD && to === EYE)
    return mat4MulPoint(out, m.vMatrix, px,py,pz);
  if (from === EYE && to === WORLD)
    return mat4MulPoint(out, m.eMatrix, px,py,pz);

  // EYE ↔ SCREEN
  if (from === EYE && to === SCREEN) {
    const e = m.eMatrix;
    const ex=e[0]*px+e[4]*py+e[8]*pz+e[12],
          ey=e[1]*px+e[5]*py+e[9]*pz+e[13],
          ez=e[2]*px+e[6]*py+e[10]*pz+e[14];
    return _worldToScreen(out, ex,ey,ez, _ensurePV(m), vp, ndcZMin);
  }
  if (from === SCREEN && to === EYE) {
    _screenToWorld(out, px,py,pz, m.ipvMatrix, vp, ndcZMin);
    const wx=out[0],wy=out[1],wz=out[2];
    return mat4MulPoint(out, m.vMatrix, wx,wy,wz);
  }

  // EYE ↔ NDC
  if (from === EYE && to === NDC) {
    const e = m.eMatrix;
    const ex=e[0]*px+e[4]*py+e[8]*pz+e[12],
          ey=e[1]*px+e[5]*py+e[9]*pz+e[13],
          ez=e[2]*px+e[6]*py+e[10]*pz+e[14];
    return _worldToNDC(out, ex,ey,ez, _ensurePV(m));
  }
  if (from === NDC && to === EYE) {
    _ndcToWorld(out, px,py,pz, m.ipvMatrix);
    const wx=out[0],wy=out[1],wz=out[2];
    return mat4MulPoint(out, m.vMatrix, wx,wy,wz);
  }

  // MATRIX (custom frame) ↔ WORLD
  if (from === MATRIX && to === WORLD)
    return mat4MulPoint(out, m.fromFrame, px,py,pz);
  if (from === WORLD && to === MATRIX)
    return mat4MulPoint(out, m.toFrameInv, px,py,pz);

  // MATRIX ↔ EYE
  if (from === MATRIX && to === EYE) {
    const f = m.fromFrame;
    const fx=f[0]*px+f[4]*py+f[8]*pz+f[12],
          fy=f[1]*px+f[5]*py+f[9]*pz+f[13],
          fz=f[2]*px+f[6]*py+f[10]*pz+f[14];
    return mat4MulPoint(out, m.vMatrix, fx,fy,fz);
  }
  if (from === EYE && to === MATRIX) {
    const e = m.eMatrix;
    const ex=e[0]*px+e[4]*py+e[8]*pz+e[12],
          ey=e[1]*px+e[5]*py+e[9]*pz+e[13],
          ez=e[2]*px+e[6]*py+e[10]*pz+e[14];
    return mat4MulPoint(out, m.toFrameInv, ex,ey,ez);
  }

  // MATRIX ↔ SCREEN
  if (from === MATRIX && to === SCREEN) {
    const f = m.fromFrame;
    const fx=f[0]*px+f[4]*py+f[8]*pz+f[12],
          fy=f[1]*px+f[5]*py+f[9]*pz+f[13],
          fz=f[2]*px+f[6]*py+f[10]*pz+f[14];
    return _worldToScreen(out, fx,fy,fz, _ensurePV(m), vp, ndcZMin);
  }
  if (from === SCREEN && to === MATRIX) {
    _screenToWorld(out, px,py,pz, m.ipvMatrix, vp, ndcZMin);
    const wx=out[0],wy=out[1],wz=out[2];
    return mat4MulPoint(out, m.toFrameInv, wx,wy,wz);
  }

  // MATRIX ↔ NDC
  if (from === MATRIX && to === NDC) {
    const f = m.fromFrame;
    const fx=f[0]*px+f[4]*py+f[8]*pz+f[12],
          fy=f[1]*px+f[5]*py+f[9]*pz+f[13],
          fz=f[2]*px+f[6]*py+f[10]*pz+f[14];
    return _worldToNDC(out, fx,fy,fz, _ensurePV(m));
  }
  if (from === NDC && to === MATRIX) {
    _ndcToWorld(out, px,py,pz, m.ipvMatrix);
    const wx=out[0],wy=out[1],wz=out[2];
    return mat4MulPoint(out, m.toFrameInv, wx,wy,wz);
  }

  // MATRIX ↔ MATRIX
  if (from === MATRIX && to === MATRIX) {
    const f = m.fromFrame;
    const fx=f[0]*px+f[4]*py+f[8]*pz+f[12],
          fy=f[1]*px+f[5]*py+f[9]*pz+f[13],
          fz=f[2]*px+f[6]*py+f[10]*pz+f[14];
    return mat4MulPoint(out, m.toFrameInv, fx,fy,fz);
  }

  // Fallback
  out[0]=px; out[1]=py; out[2]=pz;
  return out;
}

// ── Direction leaf helpers ───────────────────────────────────────────────

/** Apply the 3×3 linear part of a mat4 (rotation/scale, no translation). */
function _applyDir(out, m, dx, dy, dz) {
  out[0]=m[0]*dx+m[4]*dy+m[8]*dz;
  out[1]=m[1]*dx+m[5]*dy+m[9]*dz;
  out[2]=m[2]*dx+m[6]*dy+m[10]*dz;
  return out;
}

function _worldToScreenDir(out, dx, dy, dz, proj, view, vpW, vpH, ndcZMin) {
  // Transform to clip space (no w divide for direction).
  const vx=view[0]*dx+view[4]*dy+view[8]*dz;
  const vy=view[1]*dx+view[5]*dy+view[9]*dz;
  const vz=view[2]*dx+view[6]*dy+view[10]*dz;
  const cx=proj[0]*vx+proj[4]*vy+proj[8]*vz;
  const cy=proj[1]*vx+proj[5]*vy+proj[9]*vz;
  const cz=proj[2]*vx+proj[6]*vy+proj[10]*vz;
  // NDC→screen scale (direction, no offset).
  out[0]=cx*vpW*0.5; out[1]=-cy*vpH*0.5;
  out[2]=cz*(1-ndcZMin)*0.5;
  return out;
}

function _screenToWorldDir(out, dx, dy, dz, proj, eMatrix, vpW, vpH, ndcZMin) {
  // Screen direction → NDC direction.
  const nx=dx/(vpW*0.5), ny=-dy/(vpH*0.5);
  const nz=dz/((1-ndcZMin)*0.5);
  // NDC direction → eye direction (inverse projection, linear only).
  const ex=nx/proj[0], ey=ny/proj[5], ez=nz;
  // Eye direction → world direction.
  _applyDir(out, eMatrix, ex, ey, ez);
  return out;
}

function _screenToNDCDir(out, dx, dy, dz, vpW, vpH, ndcZMin) {
  out[0]=dx/(vpW*0.5); out[1]=-dy/(vpH*0.5);
  out[2]=dz/((1-ndcZMin)*0.5);
  return out;
}

function _ndcToScreenDir(out, dx, dy, dz, vpW, vpH, ndcZMin) {
  out[0]=dx*vpW*0.5; out[1]=-dy*vpH*0.5;
  out[2]=dz*(1-ndcZMin)*0.5;
  return out;
}

/**
 * Map a direction between named coordinate spaces.
 * Same bag contract as mapLocation.
 */
export function mapDirection(out, dx, dy, dz, from, to, m, vp, ndcZMin) {
  const vpW = Math.abs(vp[2]), vpH = Math.abs(vp[3]);

  // EYE ↔ WORLD (most common)
  if (from === EYE && to === WORLD) return _applyDir(out, m.eMatrix, dx, dy, dz);
  if (from === WORLD && to === EYE) return _applyDir(out, m.vMatrix, dx, dy, dz);

  // WORLD ↔ SCREEN
  if (from === WORLD && to === SCREEN)
    return _worldToScreenDir(out, dx,dy,dz, m.pMatrix, m.vMatrix, vpW, vpH, ndcZMin);
  if (from === SCREEN && to === WORLD)
    return _screenToWorldDir(out, dx,dy,dz, m.pMatrix, m.eMatrix, vpW, vpH, ndcZMin);

  // SCREEN ↔ NDC
  if (from === SCREEN && to === NDC)
    return _screenToNDCDir(out, dx,dy,dz, vpW, vpH, ndcZMin);
  if (from === NDC && to === SCREEN)
    return _ndcToScreenDir(out, dx,dy,dz, vpW, vpH, ndcZMin);

  // WORLD ↔ NDC
  if (from === WORLD && to === NDC) {
    _worldToScreenDir(out, dx,dy,dz, m.pMatrix, m.vMatrix, vpW, vpH, ndcZMin);
    const sx=out[0],sy=out[1],sz=out[2];
    return _screenToNDCDir(out, sx,sy,sz, vpW, vpH, ndcZMin);
  }
  if (from === NDC && to === WORLD) {
    _ndcToScreenDir(out, dx,dy,dz, vpW, vpH, ndcZMin);
    const sx=out[0],sy=out[1],sz=out[2];
    return _screenToWorldDir(out, sx,sy,sz, m.pMatrix, m.eMatrix, vpW, vpH, ndcZMin);
  }

  // EYE ↔ SCREEN
  if (from === EYE && to === SCREEN) {
    _applyDir(out, m.eMatrix, dx,dy,dz);
    const wx=out[0],wy=out[1],wz=out[2];
    return _worldToScreenDir(out, wx,wy,wz, m.pMatrix, m.vMatrix, vpW, vpH, ndcZMin);
  }
  if (from === SCREEN && to === EYE) {
    _screenToWorldDir(out, dx,dy,dz, m.pMatrix, m.eMatrix, vpW, vpH, ndcZMin);
    const wx=out[0],wy=out[1],wz=out[2];
    return _applyDir(out, m.vMatrix, wx,wy,wz);
  }

  // EYE ↔ NDC
  if (from === EYE && to === NDC) {
    _applyDir(out, m.eMatrix, dx,dy,dz);
    const wx=out[0],wy=out[1],wz=out[2];
    _worldToScreenDir(out, wx,wy,wz, m.pMatrix, m.vMatrix, vpW, vpH, ndcZMin);
    const sx=out[0],sy=out[1],sz=out[2];
    return _screenToNDCDir(out, sx,sy,sz, vpW, vpH, ndcZMin);
  }
  if (from === NDC && to === EYE) {
    _ndcToScreenDir(out, dx,dy,dz, vpW, vpH, ndcZMin);
    const sx=out[0],sy=out[1],sz=out[2];
    _screenToWorldDir(out, sx,sy,sz, m.pMatrix, m.eMatrix, vpW, vpH, ndcZMin);
    const wx=out[0],wy=out[1],wz=out[2];
    return _applyDir(out, m.vMatrix, wx,wy,wz);
  }

  // MATRIX ↔ WORLD
  if (from === MATRIX && to === WORLD) return _applyDir(out, m.fromFrame, dx,dy,dz);
  if (from === WORLD && to === MATRIX) return _applyDir(out, m.toFrameInv, dx,dy,dz);

  // MATRIX ↔ EYE
  if (from === MATRIX && to === EYE) {
    _applyDir(out, m.fromFrame, dx,dy,dz);
    const wx=out[0],wy=out[1],wz=out[2];
    return _applyDir(out, m.vMatrix, wx,wy,wz);
  }
  if (from === EYE && to === MATRIX) {
    _applyDir(out, m.eMatrix, dx,dy,dz);
    const wx=out[0],wy=out[1],wz=out[2];
    return _applyDir(out, m.toFrameInv, wx,wy,wz);
  }

  // MATRIX ↔ SCREEN
  if (from === MATRIX && to === SCREEN) {
    _applyDir(out, m.fromFrame, dx,dy,dz);
    const wx=out[0],wy=out[1],wz=out[2];
    return _worldToScreenDir(out, wx,wy,wz, m.pMatrix, m.vMatrix, vpW, vpH, ndcZMin);
  }
  if (from === SCREEN && to === MATRIX) {
    _screenToWorldDir(out, dx,dy,dz, m.pMatrix, m.eMatrix, vpW, vpH, ndcZMin);
    const wx=out[0],wy=out[1],wz=out[2];
    return _applyDir(out, m.toFrameInv, wx,wy,wz);
  }

  // MATRIX ↔ NDC
  if (from === MATRIX && to === NDC) {
    _applyDir(out, m.fromFrame, dx,dy,dz);
    const wx=out[0],wy=out[1],wz=out[2];
    _worldToScreenDir(out, wx,wy,wz, m.pMatrix, m.vMatrix, vpW, vpH, ndcZMin);
    const sx=out[0],sy=out[1],sz=out[2];
    return _screenToNDCDir(out, sx,sy,sz, vpW, vpH, ndcZMin);
  }
  if (from === NDC && to === MATRIX) {
    _ndcToScreenDir(out, dx,dy,dz, vpW, vpH, ndcZMin);
    const sx=out[0],sy=out[1],sz=out[2];
    _screenToWorldDir(out, sx,sy,sz, m.pMatrix, m.eMatrix, vpW, vpH, ndcZMin);
    const wx=out[0],wy=out[1],wz=out[2];
    return _applyDir(out, m.toFrameInv, wx,wy,wz);
  }

  // MATRIX ↔ MATRIX
  if (from === MATRIX && to === MATRIX) {
    _applyDir(out, m.fromFrame, dx,dy,dz);
    const wx=out[0],wy=out[1],wz=out[2];
    return _applyDir(out, m.toFrameInv, wx,wy,wz);
  }

  // Fallback
  out[0]=dx; out[1]=dy; out[2]=dz;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// pixelRatio
// ═══════════════════════════════════════════════════════════════════════════

/**
 * World-units-per-pixel at a given eye-space Z depth.
 * @param {ArrayLike<number>} proj  Projection mat4.
 * @param {number} vpH      Viewport height (pixels).
 * @param {number} eyeZ     Eye-space Z (negative for in-front-of camera).
 * @param {number} ndcZMin  WEBGL or WEBGPU.
 */
export function pixelRatio(proj, vpH, eyeZ, ndcZMin) {
  if (projIsOrtho(proj)) {
    return Math.abs(projTop(proj, ndcZMin) - projBottom(proj, ndcZMin)) / vpH;
  }
  return 2 * Math.abs(eyeZ) * Math.tan(projFov(proj) / 2) / vpH;
}

// ═══════════════════════════════════════════════════════════════════════════
// Pick-matrix
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply the pick-matrix in-place:  proj ← M_pick · proj
 *
 * Zooms the frustum so that pixel (px, py) maps to the full NDC square,
 * making a 1×1 framebuffer render contain exactly that pixel's content.
 * Convention-independent — correct for both perspective and orthographic.
 *
 * M_pick (column-major):
 *   [ sx   0   0   tx ]     sx = W,  sy = H
 *   [  0  sy   0   ty ]     cx = NDC X of pixel centre =  2*(px+0.5)/W − 1
 *   [  0   0   1    0 ]     cy = NDC Y of pixel centre =  1 − 2*(py+0.5)/H
 *   [  0   0   0    1 ]     tx = −cx·W,  ty = −cy·H
 *
 * @param {Float32Array} proj  Projection mat4 — mutated in place.
 * @param {number} px  Query X (CSS pixels).
 * @param {number} py  Query Y (CSS pixels).
 * @param {number} W   Canvas width  (CSS pixels).
 * @param {number} H   Canvas height (CSS pixels).
 * @returns {Float32Array} proj (same reference)
 */
export function mat4Pick(proj, px, py, W, H) {
  const cx =  2 * (px + 0.5) / W - 1;
  const cy = -2 * (py + 0.5) / H + 1;
  const sx = W;
  const sy = H;
  const tx = -cx * W;
  const ty = -cy * H;
  for (let j = 0; j < 4; j++) {
    const a = proj[j * 4];
    const b = proj[j * 4 + 1];
    const d = proj[j * 4 + 3];
    proj[j * 4]     = sx * a + tx * d;
    proj[j * 4 + 1] = sy * b + ty * d;
  }
  return proj;
}
