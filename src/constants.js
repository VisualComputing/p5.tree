/**
 * @file The constants and the math helpers p5.tree exposes on `p5.Tree`.
 * @module p5.tree/constants
 * @license AGPL-3.0-only
 *
 * Everything here lives on `p5.Tree`: the space names `WORLD`, `EYE`, `NDC`,
 * `SCREEN` and `MODEL` that `mapLocation` and `mapDirection` accept, the
 * results of `visibility`, the basis vectors, the `createHandle` constraint
 * kinds, and the bit sets that tell `axes`, `viewFrustum`, `trackPath`,
 * `helmRig` and the `Handle` drawers what to draw. Bit sets belong to one
 * gizmo each: the same number means different things to different gizmos, so
 * never mix them. Reach for this page whenever a call asks for a space, a
 * shape or a bit set.
 *
 * It also carries the quaternion helpers (`qMul`, `qSlerp`, `qFromAxisAngle`,
 * `qToMat4`, …), the ray intersections a custom `Handle` constraint builds on,
 * and the input helpers `oneEuro` and `poseDelta` for a `PoseHelm` or
 * `CameraHelm`.
 *
 * @details
 * Bit namespaces are gizmo-local: the same numeric value carries different
 * meanings to different gizmos. Pass each gizmo its own bit set and never mix
 * them across gizmos.
 *
 * Core re-exports surface a `@nakednous/tree` symbol only when p5 has no
 * adequate native equivalent and a sketch-level consumer exists. Where p5 has
 * an adequate native type the bridge maps at seams instead (vec3 → `p5.Vector`
 * via `value()` / `mapLocation`; matrices via the matrix seams). All are flat,
 * out-first, zero-allocation functions — never wrapper classes. Full
 * signatures and semantics live in the
 * [core README](https://github.com/nakednous/tree#readme).
 */

import * as C from '@nakednous/tree';
import { VIEW } from '@nakednous/host';

// Install the constants and core re-exports onto p5.Tree.
export function installConstants(p5) {
  p5.Tree ||= {};

  const CONST = value => ({ value, writable: false, enumerable: true, configurable: false });

  Object.defineProperties(p5.Tree, {
    /** Library version string.
     * @constant {string} VERSION
     * @memberof p5.Tree */
    VERSION: CONST('0.0.62'),
    /** The empty bit set — pass as a gizmo's `bits` to draw nothing.
     * @constant {number} NONE
     * @memberof p5.Tree */
    NONE: CONST(0),

    // ── Spaces (mapLocation / mapDirection `from` / `to`) ───────────────────
    /** World space. The default `to` of {@link mapLocation} / {@link mapDirection}.
     * @constant {string} WORLD
     * @memberof p5.Tree */
    WORLD:  CONST(C.WORLD),
    /** Eye (camera) space. The default `from` of {@link mapLocation} / {@link mapDirection}.
     * @constant {string} EYE
     * @memberof p5.Tree */
    EYE:    CONST(C.EYE),
    /** A `PoseHelm`'s own current pose, so motion applies relative to the body.
     * A `from` of {@link createPoseHelm} only; not a mapping space.
     * @constant {string} SELF
     * @memberof p5.Tree */
    SELF:   CONST(C.SELF),
    /** Normalized device coordinates: x, y ∈ [−1, 1]; z per {@link WEBGL} / {@link WEBGPU}.
     * @constant {string} NDC
     * @memberof p5.Tree */
    NDC:    CONST(C.NDC),
    /** Screen space — the surface's logical pixels: x ∈ [0, width], y ∈ [0, height],
     * origin top-left, z ∈ [0, 1] normalized depth; what p5's `mouseX` / `mouseY`
     * and `beginHUD` count. `fragCoord` and `drawingBufferSize` answer in its
     * counterpart, window space — the drawing buffer's device pixels, bottom-left, y up.
     * @constant {string} SCREEN
     * @memberof p5.Tree */
    SCREEN: CONST(C.SCREEN),
    /** The live model matrix's local space, resolved at call time.
     * @constant {string} MODEL
     * @memberof p5.Tree */
    MODEL:  CONST(C.MODEL),
    /** Alias of {@link MODEL}.
     * @constant {string} OBJECT
     * @memberof p5.Tree */
    OBJECT: CONST(C.MODEL),

    /** The depth range of a `WEBGL` canvas: z ∈ [−1, 1]. Pass as the depth-range
     * argument of {@link mat4Persp} / {@link mat4Ortho}.
     * @details
     * The value is the NDC z-minimum, −1; the sketch canvas selects it once.
     * @constant {number} WEBGL
     * @memberof p5.Tree */
    WEBGL:  CONST(C.WEBGL),
    /** The depth range of a `WEBGPU` canvas: z ∈ [0, 1]. Pass as the depth-range
     * argument of {@link mat4Persp} / {@link mat4Ortho}.
     * @details
     * The value is the NDC z-minimum, 0; the sketch canvas selects it once.
     * @constant {number} WEBGPU
     * @memberof p5.Tree */
    WEBGPU: CONST(C.WEBGPU),

    // ── Visibility results ──────────────────────────────────────────────────
    /** {@link visibility} result: fully outside the frustum.
     * @constant {number} INVISIBLE
     * @memberof p5.Tree */
    INVISIBLE:   CONST(C.INVISIBLE),
    /** {@link visibility} result: fully inside the frustum.
     * @constant {number} VISIBLE
     * @memberof p5.Tree */
    VISIBLE:     CONST(C.VISIBLE),
    /** {@link visibility} result: straddles at least one frustum plane.
     * @constant {number} SEMIVISIBLE
     * @memberof p5.Tree */
    SEMIVISIBLE: CONST(C.SEMIVISIBLE),

    // ── Basis vectors (frozen plain arrays) ─────────────────────────────────
    /** `[0, 0, 0]` — the default point of {@link mapLocation}.
     * @constant {number[]} ORIGIN
     * @memberof p5.Tree */
    ORIGIN: CONST(C.ORIGIN),
    /** `[1, 0, 0]` — the +X unit vector.
     * @constant {number[]} i
     * @memberof p5.Tree */
    i:  CONST(C.i),
    /** `[0, 1, 0]` — the +Y unit vector.
     * @constant {number[]} j
     * @memberof p5.Tree */
    j:  CONST(C.j),
    /** `[0, 0, 1]` — the +Z unit vector.
     * @constant {number[]} k
     * @memberof p5.Tree */
    k:  CONST(C.k),
    /** `[−1, 0, 0]` — the −X unit vector.
     * @constant {number[]} _i
     * @memberof p5.Tree */
    _i: CONST(C._i),
    /** `[0, −1, 0]` — the −Y unit vector.
     * @constant {number[]} _j
     * @memberof p5.Tree */
    _j: CONST(C._j),
    /** `[0, 0, −1]` — the −Z unit vector, the look direction; the default
     * direction of {@link mapDirection}.
     * @constant {number[]} _k
     * @memberof p5.Tree */
    _k: CONST(C._k),

    // ── axes bits ───────────────────────────────────────────────────────────
    /** {@link axes} bit: the +X half-axis.
     * @constant {number} X
     * @memberof p5.Tree */
    X:      CONST(1 << 0),
    /** {@link axes} bit: the −X half-axis.
     * @constant {number} _X
     * @memberof p5.Tree */
    _X:     CONST(1 << 1),
    /** {@link axes} bit: the +Y half-axis.
     * @constant {number} Y
     * @memberof p5.Tree */
    Y:      CONST(1 << 2),
    /** {@link axes} bit: the −Y half-axis.
     * @constant {number} _Y
     * @memberof p5.Tree */
    _Y:     CONST(1 << 3),
    /** {@link axes} bit: the +Z half-axis.
     * @constant {number} Z
     * @memberof p5.Tree */
    Z:      CONST(1 << 4),
    /** {@link axes} bit: the −Z half-axis.
     * @constant {number} _Z
     * @memberof p5.Tree */
    _Z:     CONST(1 << 5),
    /** {@link axes} bit: the X / Y / Z letter glyphs at the axis tips.
     * @constant {number} LABELS
     * @memberof p5.Tree */
    LABELS: CONST(1 << 6),

    // ── bullsEye / pointerHit shape ─────────────────────────────────────────
    /** {@link bullsEye} / {@link pointerHit} shape: circular.
     * @constant {number} CIRCLE
     * @memberof p5.Tree */
    CIRCLE: CONST(0),
    /** {@link bullsEye} / {@link pointerHit} shape: square.
     * @constant {number} SQUARE
     * @memberof p5.Tree */
    SQUARE: CONST(1),

    // ── viewFrustum bits — also the {@link bounds} plane keys ───────────────
    /** {@link viewFrustum} bit: the near plane (outline, or textured quad).
     * Also the near-plane key of the {@link bounds} object.
     * @constant {number} NEAR
     * @memberof p5.Tree */
    NEAR:   CONST(1 << 0),
    /** {@link viewFrustum} bit: the far plane (outline, or textured quad).
     * Also the far-plane key of the {@link bounds} object.
     * @constant {number} FAR
     * @memberof p5.Tree */
    FAR:    CONST(1 << 1),
    /** Left-plane key of the {@link bounds} object.
     * @constant {number} LEFT
     * @memberof p5.Tree */
    LEFT:   CONST(1 << 2),
    /** Right-plane key of the {@link bounds} object.
     * @constant {number} RIGHT
     * @memberof p5.Tree */
    RIGHT:  CONST(1 << 3),
    /** Bottom-plane key of the {@link bounds} object.
     * @constant {number} BOTTOM
     * @memberof p5.Tree */
    BOTTOM: CONST(1 << 4),
    /** Top-plane key of the {@link bounds} object.
     * @constant {number} TOP
     * @memberof p5.Tree */
    TOP:    CONST(1 << 5),
    /** {@link viewFrustum} bit: the four edges joining near to far corners.
     * @constant {number} BODY
     * @memberof p5.Tree */
    BODY:   CONST(1 << 6),
    /** {@link viewFrustum} bit: perspective only — lines from the eye to the
     * near corners.
     * @constant {number} APEX
     * @memberof p5.Tree */
    APEX:   CONST(1 << 7),

    // ── trackPath bits ──────────────────────────────────────────────────────
    /** {@link trackPath} bit: the sampled polyline along the target path.
     * @constant {number} PATH
     * @memberof p5.Tree */
    PATH:         CONST(1 << 0),
    /** {@link trackPath} bit, `CameraTrack` only: the gaze line from each
     * keyframe's eye to its center, with a dot at the center.
     * @constant {number} CENTER
     * @memberof p5.Tree */
    CENTER:       CONST(1 << 1),
    /** {@link trackPath} bit: the straight control polygon along the target path.
     * @constant {number} CONTROLS
     * @memberof p5.Tree */
    CONTROLS:     CONST(1 << 2),
    /** {@link trackPath} bit: the incoming tangent arrow at each keyframe.
     * @constant {number} TANGENTS_IN
     * @memberof p5.Tree */
    TANGENTS_IN:  CONST(1 << 3),
    /** {@link trackPath} bit: the outgoing tangent arrow at each keyframe.
     * @constant {number} TANGENTS_OUT
     * @memberof p5.Tree */
    TANGENTS_OUT: CONST(1 << 4),
    /** `TANGENTS_IN | TANGENTS_OUT`.
     * @constant {number} TANGENTS
     * @memberof p5.Tree */
    TANGENTS:     CONST((1 << 3) | (1 << 4)),
    /** {@link trackPath} bit: the keyframe dots of a track created with the
     * `handles` option (its `TrackHandles`, `track.handles`); draws nothing otherwise.
     * @constant {number} HANDLES
     * @memberof p5.Tree */
    HANDLES:      CONST(1 << 5),

    // ── helmRig bits ────────────────────────────────────────────────────────
    /** {@link helmRig} bit: the three translation arrows (Tx / Ty / Tz).
     * @constant {number} TRANSLATE
     * @memberof p5.Tree */
    TRANSLATE: CONST(1 << 0),
    /** {@link helmRig} bit: the three rotation rings (pitch / yaw / roll).
     * @constant {number} ROTATE
     * @memberof p5.Tree */
    ROTATE:    CONST(1 << 1),

    // ── handle constraint kinds + report modes ──────────────────────────────
    /** {@link createHandle} constraint: a heading on a sphere (2 DOF).
     * @constant {number} SPHERE
     * @memberof p5.Tree */
    SPHERE:    CONST(C.SPHERE),
    /** {@link createHandle} constraint: a point on a fixed plane (2 DOF).
     * @constant {number} PLANE
     * @memberof p5.Tree */
    PLANE:     CONST(C.PLANE),
    /** {@link createHandle} constraint: a point on a line (1 DOF, signed scalar).
     * @constant {number} AXIS
     * @memberof p5.Tree */
    AXIS:      CONST(C.AXIS),
    /** {@link createHandle} constraint: an accumulated angle on a circle — the
     * rotation handle (1 DOF).
     * @constant {number} DIAL
     * @memberof p5.Tree */
    DIAL:      CONST(C.DIAL),
    /** {@link createHandle} constraint: a camera-facing plane re-aimed every
     * frame — screen-parallel drag at constant depth, reported as a world position.
     * @constant {number} VIEW
     * @memberof p5.Tree */
    VIEW:      CONST(VIEW),
    /** {@link createHandle} `report` mode: a position.
     * @constant {number} POINT
     * @memberof p5.Tree */
    POINT:     CONST(C.POINT),
    /** {@link createHandle} `report` mode: a unit direction.
     * @constant {number} DIRECTION
     * @memberof p5.Tree */
    DIRECTION: CONST(C.DIRECTION),

    // ── handle draw bits ────────────────────────────────────────────────────
    /** `Handle` draw bit: the draggable dot.
     * @constant {number} HANDLE
     * @memberof p5.Tree */
    HANDLE: CONST(1 << 0),
    /** `Handle` draw bit: the anchor → point line (a DIAL's spoke).
     * @constant {number} AIM
     * @memberof p5.Tree */
    AIM:    CONST(1 << 1),
    /** `Handle` draw bit: the constraint surface — sphere wire, plane quad, axis
     * segment, dial ring, or view square.
     * @constant {number} LOCUS
     * @memberof p5.Tree */
    LOCUS:  CONST(1 << 2),
    /** `Handle` draw bit: the SPHERE view-facing limb / the PLANE border.
     * @constant {number} RING
     * @memberof p5.Tree */
    RING:   CONST(1 << 3),

    // ── Core re-exports: quaternions — flat [x, y, z, w], out-first ──────────
    /** `qSet(out, x, y, z, w)` — set the four components.
     * @constant {Function} qSet
     * @memberof p5.Tree */
    qSet:             CONST(C.qSet),
    /** `qCopy(out, a)`.
     * @constant {Function} qCopy
     * @memberof p5.Tree */
    qCopy:            CONST(C.qCopy),
    /** `qDot(a, b)` — four-component dot product.
     * @constant {Function} qDot
     * @memberof p5.Tree */
    qDot:             CONST(C.qDot),
    /** `qNormalize(out)` — in place.
     * @constant {Function} qNormalize
     * @memberof p5.Tree */
    qNormalize:       CONST(C.qNormalize),
    /** `qNegate(out, a)` — the same rotation on the other hemisphere.
     * @constant {Function} qNegate
     * @memberof p5.Tree */
    qNegate:          CONST(C.qNegate),
    /** `qConjugate(out, a)` — the inverse of a unit quaternion.
     * @constant {Function} qConjugate
     * @memberof p5.Tree */
    qConjugate:       CONST(C.qConjugate),
    /** `qMul(out, a, b)` — Hamilton product; alias-safe (`out` may be `a` or `b`).
     * @constant {Function} qMul
     * @memberof p5.Tree */
    qMul:             CONST(C.qMul),
    /** `qRotateVec3(out, q, v)` — rotate a vec3 by a unit quaternion.
     * @constant {Function} qRotateVec3
     * @memberof p5.Tree */
    qRotateVec3:      CONST(C.qRotateVec3),
    /** `qSlerp(out, a, b, t)` — spherical linear interpolation.
     * @constant {Function} qSlerp
     * @memberof p5.Tree */
    qSlerp:           CONST(C.qSlerp),
    /** `qNlerp(out, a, b, t)` — normalized linear interpolation.
     * @constant {Function} qNlerp
     * @memberof p5.Tree */
    qNlerp:           CONST(C.qNlerp),
    /** `qFromUnitVectors(out, a, b)` — the shortest arc taking unit `a` to unit `b`.
     * @constant {Function} qFromUnitVectors
     * @memberof p5.Tree */
    qFromUnitVectors: CONST(C.qFromUnitVectors),
    /** `qFromAxisAngle(out, ax, ay, az, angle)` — axis need not be unit; radians.
     * @constant {Function} qFromAxisAngle
     * @memberof p5.Tree */
    qFromAxisAngle:   CONST(C.qFromAxisAngle),
    /** `qFromLookDir(out, dir, [up])` — −Z forward, up defaults to +Y.
     * @constant {Function} qFromLookDir
     * @memberof p5.Tree */
    qFromLookDir:     CONST(C.qFromLookDir),
    /** `qFromRotMat3x3(out, m00, m01, m02, m10, m11, m12, m20, m21, m22)` — nine
     * row-major scalars.
     * @constant {Function} qFromRotMat3x3
     * @memberof p5.Tree */
    qFromRotMat3x3:   CONST(C.qFromRotMat3x3),
    /** `qFromMat4(out, m)` — from the rotation part (the upper-left 3×3) of a
     * mat4 such as {@link mat4Model} gives.
     * @details
     * Column-major, as every mat4 here.
     * @constant {Function} qFromMat4
     * @memberof p5.Tree */
    qFromMat4:        CONST(C.qFromMat4),
    /** `qToMat4(out, q)` — a rotation mat4 ready for `p5.applyMatrix`.
     * @details
     * Column-major, as every mat4 here.
     * @constant {Function} qToMat4
     * @memberof p5.Tree */
    qToMat4:          CONST(C.qToMat4),
    /** `qToAxisAngle(q, [out])` → `{ axis, angle }` in radians.
     * @constant {Function} qToAxisAngle
     * @memberof p5.Tree */
    qToAxisAngle:     CONST(C.qToAxisAngle),

    // ── Core re-exports: ray primitives + angular utilities ─────────────────
    /** Ray–sphere intersection — a building block of a custom `Handle` constraint's `solve()`.
     * @constant {Function} raySphere
     * @memberof p5.Tree */
    raySphere:              CONST(C.raySphere),
    /** Ray–plane intersection — a building block of a custom `Handle` constraint's `solve()`.
     * @constant {Function} rayPlane
     * @memberof p5.Tree */
    rayPlane:               CONST(C.rayPlane),
    /** Closest point on an axis to a ray — a building block of a custom
     * `Handle` constraint's `solve()`.
     * @constant {Function} rayClosestPointOnAxis
     * @memberof p5.Tree */
    rayClosestPointOnAxis:  CONST(C.rayClosestPointOnAxis),
    /** Unit direction from azimuth / elevation.
     * @constant {Function} dirFromAzEl
     * @memberof p5.Tree */
    dirFromAzEl:            CONST(C.dirFromAzEl),
    /** Azimuth / elevation from a unit direction.
     * @constant {Function} azElFromDir
     * @memberof p5.Tree */
    azElFromDir:            CONST(C.azElFromDir),

    // ── Core re-exports: input conditioning ─────────────────────────────────
    /** `oneEuro([opts])` — a stateful 1€ filter `f(out, raw, dt)` / `f(raw, dt)`;
     * assign it to the `filter` of a `PoseHelm` or `CameraHelm`.
     * @constant {Function} oneEuro
     * @memberof p5.Tree */
    oneEuro:   CONST(C.oneEuro),
    /** Turns an absolute pose stream into the rate stream a `PoseHelm` or
     * `CameraHelm`'s `feed()` wants, guarding against quaternion double cover.
     * @constant {Function} poseDelta
     * @memberof p5.Tree */
    poseDelta: CONST(C.poseDelta),
  });
}
