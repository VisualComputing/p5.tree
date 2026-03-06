/**
 * @file Pure numeric math — mat4, mat3, projection queries, space transforms.
 * @module tree/math
 * @license GPL-3.0-only
 *
 * CONVENTIONS (all functions in this module follow these):
 *
 *   Storage:    Column-major Float32Array / ArrayLike<number>.
 *               Element [col*4 + row] = M[row, col].
 *
 *   Multiply:   mat4Mul(out, A, B) = A · B   (standard math order).
 *
 *   Pipeline:   clip = P · V · M · v
 *               P = projection (eye → clip)
 *               V = view       (world → eye)
 *               M = model      (local → world)
 *
 *   PV:         All functions expecting a "pv" matrix receive P · V.
 *               This is what _worldToScreen, _ensurePV, etc. compute.
 *
 *   Matrix stack (translate/rotate/scale in p5):
 *     Each call post-multiplies: M = M · T, so:
 *       translate(tx,ty,tz); rotateY(a); scale(s);
 *     yields M = T · R · S. A vertex v is transformed as M·v = T·R·S·v
 *     (scaled first, then rotated, then translated — last-written-first-applied).
 *
 *   p5 bridge note (for implementors of host layers):
 *     p5.Matrix.mult(B) computes  B · this  (pre-multiply, arg on LEFT).
 *     p5 translate/rotate/scale do this · T  (post-multiply, GL stack).
 *     So p5's pvMatrix() = V.clone().mult(P) = P · V — same as ours.
 *     The bridge extracts .mat4 (Float32Array) and feeds it directly,
 *     or uses mat4Mul(out, proj, view) for the non-cached path.
 *
 * Every function uses only stack locals for intermediates (zero shared state).
 * Every mutating function writes to a caller-provided `out` and returns `out`.
 */

import {
  WORLD, EYE, NDC, SCREEN, MODEL, MATRIX, WEBGL
} from './constants.js';

// ═══════════════════════════════════════════════════════════════════════════
// Mat4 operations
// ═══════════════════════════════════════════════════════════════════════════

/** out = identity 4×4 */
export function mat4Identity(out) {
  out[0]=1;out[1]=0;out[2]=0;out[3]=0;
  out[4]=0;out[5]=1;out[6]=0;out[7]=0;
  out[8]=0;out[9]=0;out[10]=1;out[11]=0;
  out[12]=0;out[13]=0;out[14]=0;out[15]=1;
  return out;
}

/** out = a * b  (column-major) */
export function mat4Mul(out, a, b) {
  const a0=a[0],a1=a[1],a2=a[2],a3=a[3],
        a4=a[4],a5=a[5],a6=a[6],a7=a[7],
        a8=a[8],a9=a[9],a10=a[10],a11=a[11],
        a12=a[12],a13=a[13],a14=a[14],a15=a[15];
  let b0,b1,b2,b3;
  b0=b[0];b1=b[1];b2=b[2];b3=b[3];
  out[0]=a0*b0+a4*b1+a8*b2+a12*b3;
  out[1]=a1*b0+a5*b1+a9*b2+a13*b3;
  out[2]=a2*b0+a6*b1+a10*b2+a14*b3;
  out[3]=a3*b0+a7*b1+a11*b2+a15*b3;
  b0=b[4];b1=b[5];b2=b[6];b3=b[7];
  out[4]=a0*b0+a4*b1+a8*b2+a12*b3;
  out[5]=a1*b0+a5*b1+a9*b2+a13*b3;
  out[6]=a2*b0+a6*b1+a10*b2+a14*b3;
  out[7]=a3*b0+a7*b1+a11*b2+a15*b3;
  b0=b[8];b1=b[9];b2=b[10];b3=b[11];
  out[8]=a0*b0+a4*b1+a8*b2+a12*b3;
  out[9]=a1*b0+a5*b1+a9*b2+a13*b3;
  out[10]=a2*b0+a6*b1+a10*b2+a14*b3;
  out[11]=a3*b0+a7*b1+a11*b2+a15*b3;
  b0=b[12];b1=b[13];b2=b[14];b3=b[15];
  out[12]=a0*b0+a4*b1+a8*b2+a12*b3;
  out[13]=a1*b0+a5*b1+a9*b2+a13*b3;
  out[14]=a2*b0+a6*b1+a10*b2+a14*b3;
  out[15]=a3*b0+a7*b1+a11*b2+a15*b3;
  return out;
}

/** out = inverse(src). Returns null if singular. */
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

/** out = mat4 * [x,y,z,0]  (direction, no translation) */
export function mat4MulDir(out, m, x, y, z) {
  out[0] = m[0]*x + m[4]*y + m[8]*z;
  out[1] = m[1]*x + m[5]*y + m[9]*z;
  out[2] = m[2]*x + m[6]*y + m[10]*z;
  return out;
}

/** out = upper-left 3×3 transposed from mat4 (direction / dMatrix extraction) */
export function mat3FromMat4T(out, m) {
  out[0]=m[0]; out[1]=m[4]; out[2]=m[8];
  out[3]=m[1]; out[4]=m[5]; out[5]=m[9];
  out[6]=m[2]; out[7]=m[6]; out[8]=m[10];
  return out;
}

/** out = mat3 * vec3 */
export function mat3MulVec3(out, m, x, y, z) {
  out[0] = m[0]*x + m[3]*y + m[6]*z;
  out[1] = m[1]*x + m[4]*y + m[7]*z;
  out[2] = m[2]*x + m[5]*y + m[8]*z;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Projection queries
// ═══════════════════════════════════════════════════════════════════════════

/** @returns {boolean} true if orthographic */
export function projIsOrtho(p) { return p[15] !== 0; }

/**
 * Near plane distance.
 * @param {ArrayLike<number>} p  Projection Mat4
 * @param {number} ndcZMin  WEBGL (−1) or WEBGPU (0)
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

/** out = proj * view = P · V  (standard GL) */
export function mat4PV(out, proj, view) { return mat4Mul(out, proj, view); }

/** out = view * model = V · M  (standard GL) */
export function mat4MV(out, model, view) { return mat4Mul(out, view, model); }

/** out = proj * view * model = P · V · M  (standard GL) */
export function mat4PMV(out, proj, model, view) {
  // MV = view * model (V · M)
  const t0=view[0],t1=view[1],t2=view[2],t3=view[3],
        t4=view[4],t5=view[5],t6=view[6],t7=view[7],
        t8=view[8],t9=view[9],t10=view[10],t11=view[11],
        t12=view[12],t13=view[13],t14=view[14],t15=view[15];
  let b0,b1,b2,b3;
  b0=model[0];b1=model[1];b2=model[2];b3=model[3];
  const mv0=t0*b0+t4*b1+t8*b2+t12*b3, mv1=t1*b0+t5*b1+t9*b2+t13*b3,
        mv2=t2*b0+t6*b1+t10*b2+t14*b3, mv3=t3*b0+t7*b1+t11*b2+t15*b3;
  b0=model[4];b1=model[5];b2=model[6];b3=model[7];
  const mv4=t0*b0+t4*b1+t8*b2+t12*b3, mv5=t1*b0+t5*b1+t9*b2+t13*b3,
        mv6=t2*b0+t6*b1+t10*b2+t14*b3, mv7=t3*b0+t7*b1+t11*b2+t15*b3;
  b0=model[8];b1=model[9];b2=model[10];b3=model[11];
  const mv8=t0*b0+t4*b1+t8*b2+t12*b3, mv9=t1*b0+t5*b1+t9*b2+t13*b3,
        mv10=t2*b0+t6*b1+t10*b2+t14*b3, mv11=t3*b0+t7*b1+t11*b2+t15*b3;
  b0=model[12];b1=model[13];b2=model[14];b3=model[15];
  const mv12=t0*b0+t4*b1+t8*b2+t12*b3, mv13=t1*b0+t5*b1+t9*b2+t13*b3,
        mv14=t2*b0+t6*b1+t10*b2+t14*b3, mv15=t3*b0+t7*b1+t11*b2+t15*b3;
  // PMV = proj * MV  (P · V · M)
  const p0=proj[0],p1=proj[1],p2=proj[2],p3=proj[3],
        p4=proj[4],p5=proj[5],p6=proj[6],p7=proj[7],
        p8=proj[8],p9=proj[9],p10=proj[10],p11=proj[11],
        p12=proj[12],p13=proj[13],p14=proj[14],p15=proj[15];
  out[0]=p0*mv0+p4*mv1+p8*mv2+p12*mv3;
  out[1]=p1*mv0+p5*mv1+p9*mv2+p13*mv3;
  out[2]=p2*mv0+p6*mv1+p10*mv2+p14*mv3;
  out[3]=p3*mv0+p7*mv1+p11*mv2+p15*mv3;
  out[4]=p0*mv4+p4*mv5+p8*mv6+p12*mv7;
  out[5]=p1*mv4+p5*mv5+p9*mv6+p13*mv7;
  out[6]=p2*mv4+p6*mv5+p10*mv6+p14*mv7;
  out[7]=p3*mv4+p7*mv5+p11*mv6+p15*mv7;
  out[8]=p0*mv8+p4*mv9+p8*mv10+p12*mv11;
  out[9]=p1*mv8+p5*mv9+p9*mv10+p13*mv11;
  out[10]=p2*mv8+p6*mv9+p10*mv10+p14*mv11;
  out[11]=p3*mv8+p7*mv9+p11*mv10+p15*mv11;
  out[12]=p0*mv12+p4*mv13+p8*mv14+p12*mv15;
  out[13]=p1*mv12+p5*mv13+p9*mv14+p13*mv15;
  out[14]=p2*mv12+p6*mv13+p10*mv14+p14*mv15;
  out[15]=p3*mv12+p7*mv13+p11*mv14+p15*mv15;
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

// ── Location leaf helpers ────────────────────────────────────────────────

function _worldToScreen(out, px, py, pz, pv, vp, ndcZMin) {
  const x = pv[0]*px+pv[4]*py+pv[8]*pz+pv[12];
  const y = pv[1]*px+pv[5]*py+pv[9]*pz+pv[13];
  const z = pv[2]*px+pv[6]*py+pv[10]*pz+pv[14];
  const w = pv[3]*px+pv[7]*py+pv[11]*pz+pv[15];
  if (w === 0) { out[0]=px; out[1]=py; out[2]=pz; return out; }
  const nx=x/w, ny=y/w, nz=z/w;
  const ndcZRange = 1 - ndcZMin;
  out[0] = (nx*0.5+0.5)*vp[2]+vp[0];
  out[1] = (ny*0.5+0.5)*vp[3]+vp[1];
  out[2] = (nz - ndcZMin) / ndcZRange;
  return out;
}

function _screenToWorld(out, px, py, pz, ipv, vp, ndcZMin) {
  const sx=(px-vp[0])/vp[2], sy=(py-vp[1])/vp[3];
  const nx=sx*2-1, ny=sy*2-1;
  const ndcZRange = 1 - ndcZMin;
  const nz = pz * ndcZRange + ndcZMin;
  const x=ipv[0]*nx+ipv[4]*ny+ipv[8]*nz+ipv[12];
  const y=ipv[1]*nx+ipv[5]*ny+ipv[9]*nz+ipv[13];
  const z=ipv[2]*nx+ipv[6]*ny+ipv[10]*nz+ipv[14];
  const w=ipv[3]*nx+ipv[7]*ny+ipv[11]*nz+ipv[15];
  if (w === 0) { out[0]=px; out[1]=py; out[2]=pz; return out; }
  out[0]=x/w; out[1]=y/w; out[2]=z/w;
  return out;
}

function _worldToNDC(out, px, py, pz, pv) {
  const x=pv[0]*px+pv[4]*py+pv[8]*pz+pv[12];
  const y=pv[1]*px+pv[5]*py+pv[9]*pz+pv[13];
  const z=pv[2]*px+pv[6]*py+pv[10]*pz+pv[14];
  const w=pv[3]*px+pv[7]*py+pv[11]*pz+pv[15];
  if (w === 0) { out[0]=px; out[1]=py; out[2]=pz; return out; }
  out[0]=x/w; out[1]=y/w; out[2]=z/w;
  return out;
}

function _ndcToWorld(out, px, py, pz, ipv) {
  const x=ipv[0]*px+ipv[4]*py+ipv[8]*pz+ipv[12];
  const y=ipv[1]*px+ipv[5]*py+ipv[9]*pz+ipv[13];
  const z=ipv[2]*px+ipv[6]*py+ipv[10]*pz+ipv[14];
  const w=ipv[3]*px+ipv[7]*py+ipv[11]*pz+ipv[15];
  if (w === 0) { out[0]=px; out[1]=py; out[2]=pz; return out; }
  out[0]=x/w; out[1]=y/w; out[2]=z/w;
  return out;
}

function _screenToNDC(out, px, py, pz, vp, ndcZMin) {
  const ndcZRange = 1 - ndcZMin;
  out[0] = ((px-vp[0])/vp[2])*2-1;
  out[1] = ((py-vp[1])/vp[3])*2-1;
  out[2] = pz * ndcZRange + ndcZMin;
  return out;
}

function _ndcToScreen(out, px, py, pz, vp, ndcZMin) {
  const ndcZRange = 1 - ndcZMin;
  out[0] = (px*0.5+0.5)*vp[2]+vp[0];
  out[1] = (py*0.5+0.5)*vp[3]+vp[1];
  out[2] = (pz - ndcZMin) / ndcZRange;
  return out;
}

// ── Inline PV and IPV helpers (stack-local, for paths that need them) ────

function _ensurePV(m) {
  if (m.pv) return m.pv;
  // Inline P · V (standard GL: clip = P · V · world_point)
  const p = m.proj, v = m.view;
  return [
    p[0]*v[0]+p[4]*v[1]+p[8]*v[2]+p[12]*v[3],
    p[1]*v[0]+p[5]*v[1]+p[9]*v[2]+p[13]*v[3],
    p[2]*v[0]+p[6]*v[1]+p[10]*v[2]+p[14]*v[3],
    p[3]*v[0]+p[7]*v[1]+p[11]*v[2]+p[15]*v[3],
    p[0]*v[4]+p[4]*v[5]+p[8]*v[6]+p[12]*v[7],
    p[1]*v[4]+p[5]*v[5]+p[9]*v[6]+p[13]*v[7],
    p[2]*v[4]+p[6]*v[5]+p[10]*v[6]+p[14]*v[7],
    p[3]*v[4]+p[7]*v[5]+p[11]*v[6]+p[15]*v[7],
    p[0]*v[8]+p[4]*v[9]+p[8]*v[10]+p[12]*v[11],
    p[1]*v[8]+p[5]*v[9]+p[9]*v[10]+p[13]*v[11],
    p[2]*v[8]+p[6]*v[9]+p[10]*v[10]+p[14]*v[11],
    p[3]*v[8]+p[7]*v[9]+p[11]*v[10]+p[15]*v[11],
    p[0]*v[12]+p[4]*v[13]+p[8]*v[14]+p[12]*v[15],
    p[1]*v[12]+p[5]*v[13]+p[9]*v[14]+p[13]*v[15],
    p[2]*v[12]+p[6]*v[13]+p[10]*v[14]+p[14]*v[15],
    p[3]*v[12]+p[7]*v[13]+p[11]*v[14]+p[15]*v[15],
  ];
}

/**
 * Map a point between coordinate spaces.
 *
 * @param {Vec3}   out        Result written here.
 * @param {number} px,py,pz   Input point.
 * @param {string} from       Source space.
 * @param {string} to         Target space.
 * @param {object} m          Matrices bag { proj, view, eye?, pv?, ipv?, model?,
 *                             fromFrame?, toFrameInv? }.
 * @param {Vec4}   vp         Viewport [x, y, width, height].
 * @param {number} ndcZMin    WEBGL (−1) or WEBGPU (0).
 */
export function mapLocation(out, px, py, pz, from, to, m, vp, ndcZMin) {
  // WORLD ↔ SCREEN
  if (from === WORLD && to === SCREEN)
    return _worldToScreen(out, px,py,pz, _ensurePV(m), vp, ndcZMin);
  if (from === SCREEN && to === WORLD)
    return _screenToWorld(out, px,py,pz, m.ipv, vp, ndcZMin);

  // WORLD ↔ NDC
  if (from === WORLD && to === NDC)
    return _worldToNDC(out, px,py,pz, _ensurePV(m));
  if (from === NDC && to === WORLD)
    return _ndcToWorld(out, px,py,pz, m.ipv);

  // SCREEN ↔ NDC
  if (from === SCREEN && to === NDC)
    return _screenToNDC(out, px,py,pz, vp, ndcZMin);
  if (from === NDC && to === SCREEN)
    return _ndcToScreen(out, px,py,pz, vp, ndcZMin);

  // WORLD ↔ EYE
  if (from === WORLD && to === EYE)
    return mat4MulPoint(out, m.view, px,py,pz);
  if (from === EYE && to === WORLD)
    return mat4MulPoint(out, m.eye, px,py,pz);

  // EYE ↔ SCREEN (inline: eye→world→screen / screen→world→eye)
  if (from === EYE && to === SCREEN) {
    const ex=m.eye[0]*px+m.eye[4]*py+m.eye[8]*pz+m.eye[12],
          ey=m.eye[1]*px+m.eye[5]*py+m.eye[9]*pz+m.eye[13],
          ez=m.eye[2]*px+m.eye[6]*py+m.eye[10]*pz+m.eye[14];
    return _worldToScreen(out, ex,ey,ez, _ensurePV(m), vp, ndcZMin);
  }
  if (from === SCREEN && to === EYE) {
    _screenToWorld(out, px,py,pz, m.ipv, vp, ndcZMin);
    const wx=out[0],wy=out[1],wz=out[2];
    return mat4MulPoint(out, m.view, wx,wy,wz);
  }

  // EYE ↔ NDC (inline: eye→world→ndc / ndc→world→eye)
  if (from === EYE && to === NDC) {
    const ex=m.eye[0]*px+m.eye[4]*py+m.eye[8]*pz+m.eye[12],
          ey=m.eye[1]*px+m.eye[5]*py+m.eye[9]*pz+m.eye[13],
          ez=m.eye[2]*px+m.eye[6]*py+m.eye[10]*pz+m.eye[14];
    return _worldToNDC(out, ex,ey,ez, _ensurePV(m));
  }
  if (from === NDC && to === EYE) {
    _ndcToWorld(out, px,py,pz, m.ipv);
    const wx=out[0],wy=out[1],wz=out[2];
    return mat4MulPoint(out, m.view, wx,wy,wz);
  }

  // MATRIX (custom frame) ↔ WORLD
  if (from === MATRIX && to === WORLD)
    return mat4MulPoint(out, m.fromFrame, px,py,pz);
  if (from === WORLD && to === MATRIX)
    return mat4MulPoint(out, m.toFrameInv, px,py,pz);

  // MATRIX ↔ EYE
  if (from === MATRIX && to === EYE) {
    const fx=m.fromFrame[0]*px+m.fromFrame[4]*py+m.fromFrame[8]*pz+m.fromFrame[12],
          fy=m.fromFrame[1]*px+m.fromFrame[5]*py+m.fromFrame[9]*pz+m.fromFrame[13],
          fz=m.fromFrame[2]*px+m.fromFrame[6]*py+m.fromFrame[10]*pz+m.fromFrame[14];
    return mat4MulPoint(out, m.view, fx,fy,fz);
  }
  if (from === EYE && to === MATRIX) {
    const ex=m.eye[0]*px+m.eye[4]*py+m.eye[8]*pz+m.eye[12],
          ey=m.eye[1]*px+m.eye[5]*py+m.eye[9]*pz+m.eye[13],
          ez=m.eye[2]*px+m.eye[6]*py+m.eye[10]*pz+m.eye[14];
    return mat4MulPoint(out, m.toFrameInv, ex,ey,ez);
  }

  // MATRIX ↔ SCREEN
  if (from === MATRIX && to === SCREEN) {
    const fx=m.fromFrame[0]*px+m.fromFrame[4]*py+m.fromFrame[8]*pz+m.fromFrame[12],
          fy=m.fromFrame[1]*px+m.fromFrame[5]*py+m.fromFrame[9]*pz+m.fromFrame[13],
          fz=m.fromFrame[2]*px+m.fromFrame[6]*py+m.fromFrame[10]*pz+m.fromFrame[14];
    return _worldToScreen(out, fx,fy,fz, _ensurePV(m), vp, ndcZMin);
  }
  if (from === SCREEN && to === MATRIX) {
    _screenToWorld(out, px,py,pz, m.ipv, vp, ndcZMin);
    const wx=out[0],wy=out[1],wz=out[2];
    return mat4MulPoint(out, m.toFrameInv, wx,wy,wz);
  }

  // MATRIX ↔ NDC
  if (from === MATRIX && to === NDC) {
    const fx=m.fromFrame[0]*px+m.fromFrame[4]*py+m.fromFrame[8]*pz+m.fromFrame[12],
          fy=m.fromFrame[1]*px+m.fromFrame[5]*py+m.fromFrame[9]*pz+m.fromFrame[13],
          fz=m.fromFrame[2]*px+m.fromFrame[6]*py+m.fromFrame[10]*pz+m.fromFrame[14];
    return _worldToNDC(out, fx,fy,fz, _ensurePV(m));
  }
  if (from === NDC && to === MATRIX) {
    _ndcToWorld(out, px,py,pz, m.ipv);
    const wx=out[0],wy=out[1],wz=out[2];
    return mat4MulPoint(out, m.toFrameInv, wx,wy,wz);
  }

  // MATRIX ↔ MATRIX
  if (from === MATRIX && to === MATRIX) {
    const fx=m.fromFrame[0]*px+m.fromFrame[4]*py+m.fromFrame[8]*pz+m.fromFrame[12],
          fy=m.fromFrame[1]*px+m.fromFrame[5]*py+m.fromFrame[9]*pz+m.fromFrame[13],
          fz=m.fromFrame[2]*px+m.fromFrame[6]*py+m.fromFrame[10]*pz+m.fromFrame[14];
    return mat4MulPoint(out, m.toFrameInv, fx,fy,fz);
  }

  // Fallback
  out[0]=px; out[1]=py; out[2]=pz;
  return out;
}

// ── Direction helpers ────────────────────────────────────────────────────

/** Apply the 3×3 linear part of a mat4 (rotation/scale, no translation) */
function _applyDir(out, mat, dx, dy, dz) {
  out[0]=mat[0]*dx+mat[4]*dy+mat[8]*dz;
  out[1]=mat[1]*dx+mat[5]*dy+mat[9]*dz;
  out[2]=mat[2]*dx+mat[6]*dy+mat[10]*dz;
  return out;
}

/**
 * World→Screen direction. Self-contained: reads proj scalars + view mat.
 * The existing p5.tree code nested _direction and _location calls here;
 * this version inlines all math with stack locals.
 */
function _worldToScreenDir(out, dx, dy, dz, proj, view, vpW, vpH, ndcZMin) {
  // 1. World → Eye direction: R · d (standard column-major mat × vec)
  const edx = view[0]*dx + view[4]*dy + view[8]*dz;
  const edy = view[1]*dx + view[5]*dy + view[9]*dz;
  const edz = view[2]*dx + view[6]*dy + view[10]*dz;

  const isPersp = proj[15] === 0;
  let sdx = edx, sdy = edy;

  if (isPersp) {
    // Camera-eye Z of world origin (inline WORLD→EYE for [0,0,0]):
    // view * [0,0,0,1] = column 3 of view
    const zEye = view[8]*0 + view[9]*0 + view[10]*0 + view[14]; // = view[14]
    const halfTan = Math.tan(projFov(proj) / 2);
    const k = Math.abs(zEye * halfTan);
    const pixPerUnit = vpH / (2 * k);
    sdx *= pixPerUnit;
    sdy *= pixPerUnit;
  } else {
    // Ortho: pixels per world unit along X/Y
    const orthoW = Math.abs(projRight(proj, ndcZMin) - projLeft(proj, ndcZMin));
    sdx *= vpW / orthoW;
    sdy *= vpH / Math.abs(projTop(proj, ndcZMin) - projBottom(proj, ndcZMin));
  }

  // Z: map eye-space dz to screen-space dz
  const near = projNear(proj, ndcZMin), far = projFar(proj);
  const depthRange = near - far;
  const ndcZRange = 1 - ndcZMin;
  let sdz;
  if (isPersp) {
    sdz = edz / (depthRange / Math.tan(projFov(proj) / 2));
  } else {
    sdz = edz / (depthRange / (Math.abs(projRight(proj, ndcZMin) - projLeft(proj, ndcZMin)) / vpW));
  }

  out[0] = sdx; out[1] = sdy; out[2] = sdz;
  return out;
}

function _screenToWorldDir(out, dx, dy, dz, proj, view, eye, vpW, vpH, ndcZMin) {
  const isPersp = proj[15] === 0;
  let edx = dx, edy = dy;

  if (isPersp) {
    const zEye = view[14];
    const halfTan = Math.tan(projFov(proj) / 2);
    const k = Math.abs(zEye * halfTan);
    edx *= 2 * k / vpH;
    edy *= 2 * k / vpH;
  } else {
    const orthoW = Math.abs(projRight(proj, ndcZMin) - projLeft(proj, ndcZMin));
    edx *= orthoW / vpW;
    edy *= Math.abs(projTop(proj, ndcZMin) - projBottom(proj, ndcZMin)) / vpH;
  }

  const near = projNear(proj, ndcZMin), far = projFar(proj);
  const depthRange = near - far;
  let edz;
  if (isPersp) {
    edz = dz * (depthRange / Math.tan(projFov(proj) / 2));
  } else {
    edz = dz * (depthRange / (Math.abs(projRight(proj, ndcZMin) - projLeft(proj, ndcZMin)) / vpW));
  }

  // Eye → World direction (dMatrix = upper-left 3×3 of eye = inv(view))
  _applyDir(out, eye, edx, edy, edz);
  return out;
}

function _screenToNDCDir(out, dx, dy, dz, vpW, vpH, ndcZMin) {
  const ndcZRange = 1 - ndcZMin;
  out[0] = 2 * dx / vpW;
  out[1] = 2 * dy / vpH;
  out[2] = dz * ndcZRange;
  return out;
}

function _ndcToScreenDir(out, dx, dy, dz, vpW, vpH, ndcZMin) {
  const ndcZRange = 1 - ndcZMin;
  out[0] = vpW * dx / 2;
  out[1] = vpH * dy / 2;
  out[2] = dz / ndcZRange;
  return out;
}

/**
 * Map a direction between coordinate spaces.
 * Same flat-dispatch as mapLocation.
 */
export function mapDirection(out, dx, dy, dz, from, to, m, vp, ndcZMin) {
  const vpW = Math.abs(vp[2]), vpH = Math.abs(vp[3]);

  // EYE ↔ WORLD (most common: dMatrix operation)
  if (from === EYE && to === WORLD) return _applyDir(out, m.eye, dx, dy, dz);
  if (from === WORLD && to === EYE) return _applyDir(out, m.view, dx, dy, dz);

  // WORLD ↔ SCREEN
  if (from === WORLD && to === SCREEN)
    return _worldToScreenDir(out, dx,dy,dz, m.proj, m.view, vpW, vpH, ndcZMin);
  if (from === SCREEN && to === WORLD)
    return _screenToWorldDir(out, dx,dy,dz, m.proj, m.view, m.eye, vpW, vpH, ndcZMin);

  // SCREEN ↔ NDC
  if (from === SCREEN && to === NDC)
    return _screenToNDCDir(out, dx,dy,dz, vpW, vpH, ndcZMin);
  if (from === NDC && to === SCREEN)
    return _ndcToScreenDir(out, dx,dy,dz, vpW, vpH, ndcZMin);

  // WORLD ↔ NDC (chain: world→screen→ndc / ndc→screen→world)
  if (from === WORLD && to === NDC) {
    _worldToScreenDir(out, dx,dy,dz, m.proj, m.view, vpW, vpH, ndcZMin);
    const sx=out[0],sy=out[1],sz=out[2];
    return _screenToNDCDir(out, sx,sy,sz, vpW, vpH, ndcZMin);
  }
  if (from === NDC && to === WORLD) {
    _ndcToScreenDir(out, dx,dy,dz, vpW, vpH, ndcZMin);
    const sx=out[0],sy=out[1],sz=out[2];
    return _screenToWorldDir(out, sx,sy,sz, m.proj, m.view, m.eye, vpW, vpH, ndcZMin);
  }

  // EYE ↔ SCREEN
  if (from === EYE && to === SCREEN) {
    // eye→world→screen
    _applyDir(out, m.eye, dx,dy,dz);
    const wx=out[0],wy=out[1],wz=out[2];
    return _worldToScreenDir(out, wx,wy,wz, m.proj, m.view, vpW, vpH, ndcZMin);
  }
  if (from === SCREEN && to === EYE) {
    _screenToWorldDir(out, dx,dy,dz, m.proj, m.view, m.eye, vpW, vpH, ndcZMin);
    const wx=out[0],wy=out[1],wz=out[2];
    return _applyDir(out, m.view, wx,wy,wz);
  }

  // EYE ↔ NDC
  if (from === EYE && to === NDC) {
    _applyDir(out, m.eye, dx,dy,dz);
    const wx=out[0],wy=out[1],wz=out[2];
    _worldToScreenDir(out, wx,wy,wz, m.proj, m.view, vpW, vpH, ndcZMin);
    const sx=out[0],sy=out[1],sz=out[2];
    return _screenToNDCDir(out, sx,sy,sz, vpW, vpH, ndcZMin);
  }
  if (from === NDC && to === EYE) {
    _ndcToScreenDir(out, dx,dy,dz, vpW, vpH, ndcZMin);
    const sx=out[0],sy=out[1],sz=out[2];
    _screenToWorldDir(out, sx,sy,sz, m.proj, m.view, m.eye, vpW, vpH, ndcZMin);
    const wx=out[0],wy=out[1],wz=out[2];
    return _applyDir(out, m.view, wx,wy,wz);
  }

  // MATRIX ↔ WORLD
  if (from === MATRIX && to === WORLD) return _applyDir(out, m.fromFrame, dx,dy,dz);
  if (from === WORLD && to === MATRIX) return _applyDir(out, m.toFrameInv, dx,dy,dz);

  // MATRIX ↔ EYE
  if (from === MATRIX && to === EYE) {
    _applyDir(out, m.fromFrame, dx,dy,dz);
    const wx=out[0],wy=out[1],wz=out[2];
    return _applyDir(out, m.view, wx,wy,wz);
  }
  if (from === EYE && to === MATRIX) {
    _applyDir(out, m.eye, dx,dy,dz);
    const wx=out[0],wy=out[1],wz=out[2];
    return _applyDir(out, m.toFrameInv, wx,wy,wz);
  }

  // MATRIX ↔ SCREEN
  if (from === MATRIX && to === SCREEN) {
    _applyDir(out, m.fromFrame, dx,dy,dz);
    const wx=out[0],wy=out[1],wz=out[2];
    return _worldToScreenDir(out, wx,wy,wz, m.proj, m.view, vpW, vpH, ndcZMin);
  }
  if (from === SCREEN && to === MATRIX) {
    _screenToWorldDir(out, dx,dy,dz, m.proj, m.view, m.eye, vpW, vpH, ndcZMin);
    const wx=out[0],wy=out[1],wz=out[2];
    return _applyDir(out, m.toFrameInv, wx,wy,wz);
  }

  // MATRIX ↔ NDC
  if (from === MATRIX && to === NDC) {
    _applyDir(out, m.fromFrame, dx,dy,dz);
    const wx=out[0],wy=out[1],wz=out[2];
    _worldToScreenDir(out, wx,wy,wz, m.proj, m.view, vpW, vpH, ndcZMin);
    const sx=out[0],sy=out[1],sz=out[2];
    return _screenToNDCDir(out, sx,sy,sz, vpW, vpH, ndcZMin);
  }
  if (from === NDC && to === MATRIX) {
    _ndcToScreenDir(out, dx,dy,dz, vpW, vpH, ndcZMin);
    const sx=out[0],sy=out[1],sz=out[2];
    _screenToWorldDir(out, sx,sy,sz, m.proj, m.view, m.eye, vpW, vpH, ndcZMin);
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
 * @param {ArrayLike<number>} proj  Projection Mat4.
 * @param {number} vpH      Viewport height (pixels).
 * @param {number} eyeZ     Eye-space Z of the point (negative for in-front-of camera).
 * @param {number} ndcZMin  WEBGL or WEBGPU.
 */
export function pixelRatio(proj, vpH, eyeZ, ndcZMin) {
  if (projIsOrtho(proj)) {
    return Math.abs(projTop(proj, ndcZMin) - projBottom(proj, ndcZMin)) / vpH;
  }
  return 2 * Math.abs(eyeZ) * Math.tan(projFov(proj) / 2) / vpH;
}
