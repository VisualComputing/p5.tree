/**
 * @file Matrix construction from geometric specs and partial decomposition.
 * @module tree/form
 * @license AGPL-3.0-only
 *
 * Constructs mat4s from higher-level specs: TRS transforms, orthonormal
 * bases, lookat parameters, projection parameters, and special-purpose
 * matrices (bias, reflection).
 *
 * Design invariant: form.js has no dependency on query.js. Construction
 * from specs requires only scalar arithmetic and quaternion conversions.
 * Callers compose the resulting matrices using query.js (mat4Mul etc.).
 *
 * Lookat constructors live here because a camera is just a frame — the eye
 * matrix is the camera object's model matrix, not a camera-specific concept.
 * There is no camera module; mat4View and mat4Eye are frame
 * constructions that happen to use lookat parameterisation.
 *
 * Projection constructors live here because they construct matrices from
 * geometric parameters. Projection scalar reads (projNear, projFov, etc.)
 * live in query.js — they interrogate an existing projection matrix.
 *
 * Partial decomposers (mat4To___) are the inverse of construction — they
 * extract a single component from an existing matrix. Kept alongside
 * constructors because they are paired operations on the same components.
 *
 * Imports quat.js only. No dependency on query.js, visibility.js, or track.js.
 *
 * All functions follow the out-first, zero-allocation contract.
 * Returns null on degeneracy where applicable.
 */

'use strict';

import { qFromRotMat3x3 } from './quat.js';

// =========================================================================
// Frame construction
// =========================================================================

/**
 * Rigid frame from orthonormal basis + translation.
 * The primitive that lookat constructors use internally.
 *
 * Column-major layout: col0=right, col1=up, col2=forward, col3=translation.
 *
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} rx,ry,rz  Right vector (col 0).
 * @param {number} ux,uy,uz  Up vector    (col 1).
 * @param {number} fx,fy,fz  Forward vec  (col 2).
 * @param {number} tx,ty,tz  Translation  (col 3).
 * @returns {Float32Array|number[]} out
 */
export function mat4FromBasis(out, rx,ry,rz, ux,uy,uz, fx,fy,fz, tx,ty,tz) {
  out[0]=rx;  out[1]=ry;  out[2]=rz;  out[3]=0;
  out[4]=ux;  out[5]=uy;  out[6]=uz;  out[7]=0;
  out[8]=fx;  out[9]=fy;  out[10]=fz; out[11]=0;
  out[12]=tx; out[13]=ty; out[14]=tz; out[15]=1;
  return out;
}

/**
 * View matrix (world→eye) from lookat parameters.
 * Cheaper than building the eye matrix and inverting.
 *
 * Convention: −Z axis points toward center (camera looks along −Z in eye space).
 *
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} ex,ey,ez   Eye (camera) position.
 * @param {number} cx,cy,cz   Center (look-at target).
 * @param {number} ux,uy,uz   World up hint (need not be unit).
 * @returns {Float32Array|number[]} out
 */
export function mat4View(out, ex,ey,ez, cx,cy,cz, ux,uy,uz) {
  // z = normalize(eye - center)  (camera +Z away from target)
  let zx=ex-cx, zy=ey-cy, zz=ez-cz;
  const zl=Math.sqrt(zx*zx+zy*zy+zz*zz)||1;
  zx/=zl; zy/=zl; zz/=zl;
  // x = normalize(up × z)  (right)
  let xx=uy*zz-uz*zy, xy=uz*zx-ux*zz, xz=ux*zy-uy*zx;
  const xl=Math.sqrt(xx*xx+xy*xy+xz*xz)||1;
  xx/=xl; xy/=xl; xz/=xl;
  // y = z × x  (up_ortho, guaranteed perpendicular)
  const yx=zy*xz-zz*xy, yy=zz*xx-zx*xz, yz=zx*xy-zy*xx;
  // View = [R | -R·t]  (column-major)
  out[0]=xx;              out[1]=yx;              out[2]=zx;              out[3]=0;
  out[4]=xy;              out[5]=yy;              out[6]=zy;              out[7]=0;
  out[8]=xz;              out[9]=yz;              out[10]=zz;             out[11]=0;
  out[12]=-(xx*ex+xy*ey+xz*ez);
  out[13]=-(yx*ex+yy*ey+yz*ez);
  out[14]=-(zx*ex+zy*ey+zz*ez);
  out[15]=1;
  return out;
}

/**
 * Eye matrix (eye→world) from lookat parameters.
 * Transpose of the rotation block + direct translation column.
 * Same inputs as mat4View.
 *
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} ex,ey,ez   Eye (camera) position.
 * @param {number} cx,cy,cz   Center (look-at target).
 * @param {number} ux,uy,uz   World up hint (need not be unit).
 * @returns {Float32Array|number[]} out
 */
export function mat4Eye(out, ex,ey,ez, cx,cy,cz, ux,uy,uz) {
  // Same basis computation as mat4View.
  let zx=ex-cx, zy=ey-cy, zz=ez-cz;
  const zl=Math.sqrt(zx*zx+zy*zy+zz*zz)||1;
  zx/=zl; zy/=zl; zz/=zl;
  let xx=uy*zz-uz*zy, xy=uz*zx-ux*zz, xz=ux*zy-uy*zx;
  const xl=Math.sqrt(xx*xx+xy*xy+xz*xz)||1;
  xx/=xl; xy/=xl; xz/=xl;
  const yx=zy*xz-zz*xy, yy=zz*xx-zx*xz, yz=zx*xy-zy*xx;
  // Eye matrix = [R^T | t]  (rotation transposed, translation = eye position)
  out[0]=xx;  out[1]=xy;  out[2]=xz;  out[3]=0;
  out[4]=yx;  out[5]=yy;  out[6]=yz;  out[7]=0;
  out[8]=zx;  out[9]=zy;  out[10]=zz; out[11]=0;
  out[12]=ex; out[13]=ey; out[14]=ez; out[15]=1;
  return out;
}

// =========================================================================
// TRS construction
// =========================================================================

/**
 * Column-major mat4 from flat TRS scalars.
 * No struct allocation — all components passed as plain numbers.
 *
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} tx,ty,tz      Translation.
 * @param {number} qx,qy,qz,qw  Rotation quaternion [x,y,z,w].
 * @param {number} sx,sy,sz      Scale.
 * @returns {Float32Array|number[]} out
 */
export function mat4FromTRS(out, tx,ty,tz, qx,qy,qz,qw, sx,sy,sz) {
  const x2=qx+qx,y2=qy+qy,z2=qz+qz;
  const xx=qx*x2,xy=qx*y2,xz=qx*z2,yy=qy*y2,yz=qy*z2,zz=qz*z2;
  const wx=qw*x2,wy=qw*y2,wz=qw*z2;
  out[0]=(1-(yy+zz))*sx; out[1]=(xy+wz)*sx;     out[2]=(xz-wy)*sx;     out[3]=0;
  out[4]=(xy-wz)*sy;     out[5]=(1-(xx+zz))*sy; out[6]=(yz+wx)*sy;     out[7]=0;
  out[8]=(xz+wy)*sz;     out[9]=(yz-wx)*sz;     out[10]=(1-(xx+yy))*sz; out[11]=0;
  out[12]=tx; out[13]=ty; out[14]=tz; out[15]=1;
  return out;
}

/**
 * Translation-only mat4.
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} tx,ty,tz
 * @returns {Float32Array|number[]} out
 */
export function mat4FromTranslation(out, tx,ty,tz) {
  out[0]=1;  out[1]=0;  out[2]=0;  out[3]=0;
  out[4]=0;  out[5]=1;  out[6]=0;  out[7]=0;
  out[8]=0;  out[9]=0;  out[10]=1; out[11]=0;
  out[12]=tx; out[13]=ty; out[14]=tz; out[15]=1;
  return out;
}

/**
 * Scale-only mat4.
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} sx,sy,sz
 * @returns {Float32Array|number[]} out
 */
export function mat4FromScale(out, sx,sy,sz) {
  out[0]=sx; out[1]=0;  out[2]=0;  out[3]=0;
  out[4]=0;  out[5]=sy; out[6]=0;  out[7]=0;
  out[8]=0;  out[9]=0;  out[10]=sz; out[11]=0;
  out[12]=0; out[13]=0; out[14]=0;  out[15]=1;
  return out;
}

// =========================================================================
// Projection construction
// =========================================================================

/**
 * Perspective projection matrix.
 *
 * NDC convention: ndcZMin = WEBGL (−1) or WEBGPU (0).
 * near maps to ndcZMin, far maps to +1.
 *
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} fov      Vertical field of view (radians).
 * @param {number} aspect   Width / height.
 * @param {number} near     Near plane distance (positive).
 * @param {number} far      Far plane distance (positive, > near).
 * @param {number} ndcZMin  -1 (WEBGL) or 0 (WEBGPU).
 * @returns {Float32Array|number[]} out
 */
export function mat4Perspective(out, fov, aspect, near, far, ndcZMin) {
  const f = 1 / Math.tan(fov * 0.5);
  out[0]=f/aspect; out[1]=0; out[2]=0;  out[3]=0;
  out[4]=0;        out[5]=f; out[6]=0;  out[7]=0;
  out[8]=0;        out[9]=0;
  out[10]=(ndcZMin*near-far)/(far-near);
  out[11]=-1;
  out[12]=0; out[13]=0;
  out[14]=(ndcZMin-1)*far*near/(far-near);
  out[15]=0;
  return out;
}

/**
 * Orthographic projection matrix.
 *
 * NDC convention: ndcZMin = WEBGL (−1) or WEBGPU (0).
 *
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} left,right,bottom,top  Frustum extents.
 * @param {number} near,far              Clip plane distances (positive).
 * @param {number} ndcZMin               -1 (WEBGL) or 0 (WEBGPU).
 * @returns {Float32Array|number[]} out
 */
export function mat4Ortho(out, left, right, bottom, top, near, far, ndcZMin) {
  const rl=1/(right-left), tb=1/(top-bottom), fn=1/(far-near);
  out[0]=2*rl;              out[1]=0;                out[2]=0;                     out[3]=0;
  out[4]=0;                 out[5]=2*tb;             out[6]=0;                     out[7]=0;
  out[8]=0;                 out[9]=0;
  out[10]=(ndcZMin-1)*fn;
  out[11]=0;
  out[12]=-(right+left)*rl; out[13]=-(top+bottom)*tb;
  out[14]=(ndcZMin*far-near)*fn;
  out[15]=1;
  return out;
}

/**
 * Frustum (off-centre perspective) projection matrix.
 *
 * NDC convention: ndcZMin = WEBGL (−1) or WEBGPU (0).
 *
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} left,right,bottom,top  Near-plane extents.
 * @param {number} near,far              Clip plane distances (positive).
 * @param {number} ndcZMin               -1 (WEBGL) or 0 (WEBGPU).
 * @returns {Float32Array|number[]} out
 */
export function mat4Frustum(out, left, right, bottom, top, near, far, ndcZMin) {
  const rl=1/(right-left), tb=1/(top-bottom);
  out[0]=2*near*rl;         out[1]=0;               out[2]=0;  out[3]=0;
  out[4]=0;                 out[5]=2*near*tb;       out[6]=0;  out[7]=0;
  out[8]=(right+left)*rl;   out[9]=(top+bottom)*tb;
  out[10]=(ndcZMin*near-far)/(far-near);
  out[11]=-1;
  out[12]=0; out[13]=0;
  out[14]=(ndcZMin-1)*far*near/(far-near);
  out[15]=0;
  return out;
}

// =========================================================================
// Special-purpose construction
// =========================================================================

/**
 * Bias matrix: remaps xyz from NDC to texture/UV space [0,1].
 * xy always remap from [−1,1]; z remaps from [ndcZMin,1].
 * Used to transform light-space NDC coordinates for shadow map sampling.
 *
 * Column-major (WebGL, ndcZMin=−1):
 *   [ 0.5  0    0    0.5 ]
 *   [ 0    0.5  0    0.5 ]
 *   [ 0    0    0.5  0.5 ]
 *   [ 0    0    0    1   ]
 *
 * Column-major (WebGPU, ndcZMin=0):
 *   [ 0.5  0    0    0.5 ]
 *   [ 0    0.5  0    0.5 ]
 *   [ 0    0    1    0   ]
 *   [ 0    0    0    1   ]
 *
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} ndcZMin  WEBGL (−1) or WEBGPU (0).
 * @returns {Float32Array|number[]} out
 */
export function mat4Bias(out, ndcZMin) {
  const sz = 1 / (1 - ndcZMin);
  const tz = -ndcZMin / (1 - ndcZMin);
  out[0]=0.5; out[1]=0;   out[2]=0;   out[3]=0;
  out[4]=0;   out[5]=0.5; out[6]=0;   out[7]=0;
  out[8]=0;   out[9]=0;   out[10]=sz; out[11]=0;
  out[12]=0.5; out[13]=0.5; out[14]=tz; out[15]=1;
  return out;
}

/**
 * Reflection matrix across a plane ax + by + cz = d.
 * [nx, ny, nz] must be a unit normal.
 *
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} nx,ny,nz  Unit plane normal.
 * @param {number} d         Plane offset (dot(point_on_plane, normal)).
 * @returns {Float32Array|number[]} out
 */
export function mat4Reflect(out, nx,ny,nz,d) {
  out[0]=1-2*nx*nx; out[1]=-2*ny*nx; out[2]=-2*nz*nx; out[3]=0;
  out[4]=-2*nx*ny;  out[5]=1-2*ny*ny; out[6]=-2*nz*ny; out[7]=0;
  out[8]=-2*nx*nz;  out[9]=-2*ny*nz; out[10]=1-2*nz*nz; out[11]=0;
  out[12]=2*d*nx;   out[13]=2*d*ny;  out[14]=2*d*nz;   out[15]=1;
  return out;
}

// =========================================================================
// Partial decomposition  (mat4To___ mirrors mat4From___)
// =========================================================================

/**
 * Extract translation from a column-major mat4 (column 3).
 * @param {Float32Array|number[]} out3  3-element destination.
 * @param {Float32Array|number[]} m     16-element source.
 * @returns {Float32Array|number[]} out3
 */
export function mat4ToTranslation(out3, m) {
  out3[0]=m[12]; out3[1]=m[13]; out3[2]=m[14];
  return out3;
}

/**
 * Extract scale from a column-major mat4 (column lengths of rotation block).
 * Assumes no shear.
 * @param {Float32Array|number[]} out3  3-element destination.
 * @param {Float32Array|number[]} m     16-element source.
 * @returns {Float32Array|number[]} out3
 */
export function mat4ToScale(out3, m) {
  out3[0]=Math.sqrt(m[0]*m[0]+m[1]*m[1]+m[2]*m[2]);
  out3[1]=Math.sqrt(m[4]*m[4]+m[5]*m[5]+m[6]*m[6]);
  out3[2]=Math.sqrt(m[8]*m[8]+m[9]*m[9]+m[10]*m[10]);
  return out3;
}

/**
 * Extract rotation as a unit quaternion from a column-major mat4.
 * Scale is factored out from each column before extraction.
 * Assumes no shear.
 * @param {number[]} out4  4-element [x,y,z,w] destination.
 * @param {Float32Array|number[]} m  16-element source.
 * @returns {number[]} out4
 */
export function mat4ToRotation(out4, m) {
  const sx=Math.sqrt(m[0]*m[0]+m[1]*m[1]+m[2]*m[2])||1;
  const sy=Math.sqrt(m[4]*m[4]+m[5]*m[5]+m[6]*m[6])||1;
  const sz=Math.sqrt(m[8]*m[8]+m[9]*m[9]+m[10]*m[10])||1;
  return qFromRotMat3x3(out4,
    m[0]/sx, m[4]/sy, m[8]/sz,
    m[1]/sx, m[5]/sy, m[9]/sz,
    m[2]/sx, m[6]/sy, m[10]/sz);
}
