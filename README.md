# p5.tree

[![npm version](https://img.shields.io/npm/v/p5.tree?color=1f6feb)](https://www.npmjs.com/package/p5.tree)

Render pipeline for [p5.js v2](https://beta.p5js.org/) — [pose and camera interpolation](https://en.wikipedia.org/wiki/Key_frame), [space transforms](https://wikis.khronos.org/opengl/Rendering_Pipeline_Overview), [frustum visibility](https://en.wikipedia.org/wiki/Hidden-surface_determination), [HUD](https://en.wikipedia.org/wiki/Head-up_display), [post-processing pipe](https://en.wikipedia.org/wiki/Video_post-processing#Uses_in_3D_rendering), [picking](https://webglfundamentals.org/webgl/lessons/webgl-picking.html), and [declarative control panels](https://github.com/dataarts/dat.gui).

![A non-Euclidean geometry cube with faces showcasing teapot, bunny, and Buddha models.](p5.tree.png)

-   [Tracks](#tracks)
    -   [PoseTrack --- object animation](#posetrack--object-animation)
    -   [CameraTrack --- camera keyframe paths](#cameratrack--camera-keyframe-paths)
    -   [Playback options](#playback-options)
    -   [Camera helpers](#camera-helpers)
-   [Space transformations](#space-transformations)
    -   [Matrix operations](#matrix-operations)
    -   [Frustum queries](#frustum-queries)
    -   [Coordinate space conversions](#coordinate-space-conversions)
    -   [Heads Up Display](#heads-up-display)
-   [Panels](#panels)
    -   [Parameter panel](#parameter-panel)
    -   [Track transport panel](#track-transport-panel)
    -   [Collapsible panels](#collapsible-panels)
-   [Post-processing](#post-processing)
    -   [pipe](#pipe)
    -   [releasePipe](#releasepipe)
-   [Picking](#picking)
    -   [GPU color-ID picking](#gpu-color-id-picking)
    -   [CPU proximity picking](#cpu-proximity-picking)
-   [Utilities](#utilities)
-   [Gizmos](#gizmos)
-   [Releases](#releases)
-   [Usage](#usage)
    -   [CDN](#cdn)
    -   [npm (ESM)](#npm-esm)

---

# Tracks

A unified factory creates either a **PoseTrack** (object animation) or a **CameraTrack** (camera keyframe path).

```js
const track = createPoseTrack()       // PoseTrack — animates any object
const track = createCameraTrack()     // CameraTrack — binds to the current camera
const track = createCameraTrack(cam)  // CameraTrack — binds to a specific camera
```

## PoseTrack — object animation

Stores `{ pos, rot, scl }` keyframes. Interpolates position with cubic Hermite (auto-computed centripetal Catmull-Rom tangents by default), rotation with slerp or nlerp, scale with linear.

```js
const track = createPoseTrack()
const out   = { pos:[0,0,0], rot:[0,0,0,1], scl:[1,1,1] }

track.add({ pos:[-150, 0, 0], rot:[0,0,0,1], scl:[1,1,1] })
track.add({ pos:[ 150, 0, 0], rot:[0,0,0,1], scl:[1,1,1] })
track.play({ loop: true, duration: 60 })

function draw() {
  background(20)
  if (track.playing) {
    push()
    applyPose(track.eval(out))
    box(60)
    pop()
  }
}
```

`add()` accepts flexible specs. Top-level forms:

```js
track.add({ pos, rot, scl })                      // explicit TRS — rot accepts any form below
track.add({ pos, rot, scl, tanIn, tanOut })        // with Hermite tangents (vec3, optional)
track.add({ mMatrix: mat4 })                       // decompose model matrix into TRS
track.add([ spec, spec, ... ])                     // bulk
```

`tanIn` is the incoming position tangent at this keyframe; `tanOut` is the outgoing tangent. When only one is given, the other mirrors it. When neither is given, centripetal Catmull-Rom tangents are auto-computed — identical to the default smooth behavior.

```js
track.add({ pos:[0,0,0] })                                      // auto tangents
track.add({ pos:[100,0,0], tanOut:[0,50,0] })                   // leave heading +Y
track.add({ pos:[200,0,0], tanIn:[0,50,0], tanOut:[-30,0,0] })  // arrive from +Y, leave heading -X
track.add({ pos:[300,0,0] })                                    // auto tangents
```

`rot` sub-forms — all normalised internally, no pre-processing needed:

```js
track.add({ pos:[0,0,0], rot: [x,y,z,w] })                          // raw quaternion
track.add({ pos:[0,0,0], rot: { axis:[0,1,0], angle: PI/4 } })      // axis-angle
track.add({ pos:[0,0,0], rot: { dir:[1,0,0] } })                    // look direction
track.add({ pos:[0,0,0], rot: { euler:[rx,ry,rz] } })               // intrinsic YXZ (default)
track.add({ pos:[0,0,0], rot: { euler:[rx,ry,rz], order:'XYZ' } })  // explicit order
track.add({ pos:[0,0,0], rot: { from:[0,0,1], to:[1,0,0] } })       // shortest arc
track.add({ pos:[0,0,0], rot: { mat3: rotationMatrix } })           // 3×3 col-major
track.add({ pos:[0,0,0], rot: { eMatrix: eyeMat } })                // from eye matrix
```

Supported Euler orders: `YXZ` (default, matches p5 Y-up), `XYZ`, `ZYX`, `ZXY`, `XZY`, `YZX`. All are intrinsic — extrinsic `ABC` equals intrinsic `CBA` with the same angles.

Interpolation modes:

```js
track.posInterp = 'hermite'  // default — Hermite; auto-CR tangents when none stored
track.posInterp = 'linear'
track.posInterp = 'step'     // snap to k0; useful for discrete state changes

track.rotInterp = 'slerp'    // default — constant angular velocity
track.rotInterp = 'nlerp'    // faster, slightly non-constant speed
track.rotInterp = 'step'     // snap to k0 quaternion
```

`eval(out)` writes into a pre-allocated buffer — zero heap allocation per frame. Use `toMatrix(outMat4)` to evaluate directly into a column-major mat4.

## CameraTrack — camera keyframe paths

Stores `{ eye, center, up }` lookat keyframes. Playback applies automatically each frame via `cam.camera()` — no draw-loop guard needed.

```js
let track

function setup() {
  createCanvas(600, 400, WEBGL)
  track = createCameraTrack()   // binds to the default camera

  track.add({ eye:[0,0,500], center:[0,0,0] })
  track.add({ eye:[300,-150,0], center:[0,0,0] })
  track.add({ eye:[-200,100,-300], center:[0,0,0] })
  track.play({ loop: true, duration: 90 })
}

function draw() {
  background(20)
  orbitControl()   // works freely when track is stopped
  axes(); grid()
}
```

`add()` accepts multiple forms:

```js
track.add({ eye, center?, up?, fov?, halfHeight?,
            eyeTanIn?, eyeTanOut?, centerTanIn?, centerTanOut? })
                               // explicit lookat; center defaults to [0,0,0], up to [0,1,0]
                               // eyeTanIn/Out — Hermite tangents for eye path
                               // centerTanIn/Out — Hermite tangents for center path
track.add({ vMatrix: mat4 })   // view matrix (world→eye); eye reconstructed via -R^T·t
track.add({ eMatrix: mat4 })   // eye matrix (eye→world); eye read from col3
track.add(cam.capturePose())   // capture live camera state (zero-alloc with pre-allocated out)
track.add()                    // shortcut — captures track's bound camera
track.add([ spec, spec, ... ]) // bulk
```

`fov` (radians) animates perspective field of view.
`halfHeight` (world units) animates the vertical extent of an ortho frustum —
width is derived from aspect ratio at apply time, preserving image proportions.
Both fields are captured automatically by `track.add()` and `track.add({ camera: cam })`.

`vMatrix` and `eMatrix` both default `up` to `[0,1,0]`. Pass `cam.capturePose()` when the real up hint needs preserving.

Interpolation modes:

```js
track.eyeInterp    = 'hermite'  // default — auto-CR tangents when none stored
track.eyeInterp    = 'linear'
track.eyeInterp    = 'step'

track.centerInterp = 'linear'   // default — suits fixed lookat targets
track.centerInterp = 'hermite'  // smoother when center is also flying
track.centerInterp = 'step'
```

## Playback options

All tracks share the same transport API:

```js
track.play({ duration, loop, pingPong, rate, onPlay, onEnd, onStop })
track.stop([rewind])   // rewind=true seeks to origin
track.reset()          // clear all keyframes and stop
track.seek(t)          // t ∈ [0, 1]
track.time()           // → number ∈ [0, 1]
track.info()           // → { keyframes, segments, playing, loop, ... }
track.add(spec)        // append keyframe(s)
track.set(i, spec)     // replace keyframe at index
track.remove(i)        // remove keyframe at index
```

| Option     | Default | Description                                    |
|------------|---------|------------------------------------------------|
| `duration` | `30`    | Frames per segment.                            |
| `loop`     | `false` | Wrap at boundaries.                            |
| `pingPong` | `false` | Bounce at boundaries.                          |
| `rate`     | `1`     | Playback speed (negative reverses direction).  |
| `onPlay`   | —       | Fires when playback starts.                    |
| `onEnd`    | —       | Fires at natural end (once mode only).         |
| `onStop`   | —       | Fires on explicit `stop()` or `reset()`.       |

Hook firing order:
```
play()  → onPlay → _onActivate
tick()  → onEnd  → _onDeactivate   (once mode, at boundary)
stop()  → onStop → _onDeactivate
reset() → onStop → _onDeactivate
```

`track.playing`, `track.loop`, `track.pingPong`, `track.rate`, `track.duration`, `track.keyframes` — readable at any time.

## Camera helpers

```js
const cam = createCamera()   // dedicated camera; pass to createCameraTrack(cam)
const out = {}

cam.capturePose(out)    // → { eye, center, up } — zero-alloc with pre-allocated out
cam.applyPose(pose)     // set camera from { eye, center, up }

getCamera()             // → current active p5.Camera (or null before setup)
```

---

# Space transformations

## Matrix operations

All matrix queries share the same contract:
- `out` is the **first** parameter — the caller owns the buffer
- returns `out` (or `null` on a singular matrix)
- no allocations — pass the same buffer every frame

Accepted types for `out` and override params: `Float32Array` | `ArrayLike` | `p5.Matrix`

**Simple queries** — read from live renderer state:

```js
eMatrix(out)   // eye matrix (inverse view) — eye→world
pMatrix(out)   // projection matrix
vMatrix(out)   // view matrix — world→eye
mMatrix(out)   // model matrix — local→world
```

**Composite queries** — `out` first, optional overrides in an opts object:

```js
pvMatrix(out,  [{ pMatrix, vMatrix }])
ipvMatrix(out, [{ pMatrix, vMatrix, pvMatrix }])
mvMatrix(out,  [{ mMatrix, vMatrix }])
pmvMatrix(out, [{ pMatrix, mMatrix, vMatrix }])
nMatrix(out,   [{ mMatrix, vMatrix, mvMatrix }])  // 9-element out
mat4Location(out, from, to)   // location transform: inv(to) · from
mat3Direction(out, from, to)  // direction transform: to₃ · inv(from₃), 9-element out
```

**Raw matrix math** — forwarded from `@nakednous/tree`, same out-first contract:

```js
mat4Mul(out, A, B)          // out = A · B  (column-major)
mat4Invert(out, src)        // out = inv(src), null if singular
mat4MulPoint(out, m, point) // out = m · [x,y,z,1] perspective-divided
                            // point: Float32Array | ArrayLike | p5.Vector
```

**Zero-allocation draw-loop pattern:**

```js
// setup — allocate once
const e   = new Float32Array(16)
const pm  = new Float32Array(16)
const pv  = new Float32Array(16)
const wlm = new Float32Array(16)   // e.g. bias · lightPV for shadow mapping
const pt  = new Float32Array(3)

// draw — zero allocations
eMatrix(e)
pMatrix(pm)
pvMatrix(pv)
mat4Mul(wlm, biasMatrix, pv)
mat4MulPoint(pt, wlm, lightPosition)
viewFrustum({ eMatrix: e, pMatrix: pm })
mouseHit({ pvMatrix: pv, eMatrix: e })
```

## Frustum queries

Scalars read directly from the projection matrix — no buffer needed:

```js
lPlane()   rPlane()   bPlane()   tPlane()   // side planes
nPlane()   fPlane()                          // near / far
fov()      hfov()                            // field of view (radians)
isOrtho()                                    // true for orthographic

pixelRatio([worldPos], [{ pMatrix, vMatrix }])
// world-units-per-pixel at worldPos (defaults to camera position)
```

## Coordinate space conversions

```js
mapLocation(out, point, [opts])   // map a point between spaces
mapLocation(out, [opts])          // input defaults to p5.Tree.ORIGIN
mapLocation(out)                  // defaults to ORIGIN, EYE → WORLD

mapDirection(out, vector, [opts]) // map a direction between spaces
mapDirection(out, [opts])         // input defaults to p5.Tree._k
mapDirection(out)                 // defaults to _k, EYE → WORLD
```

`out` is a 3-element `Float32Array`, `ArrayLike`, or `p5.Vector`.

| Option      | Default           | Description                             |
|-------------|-------------------|-----------------------------------------|
| `from`      | `p5.Tree.EYE`     | Source space (constant or matrix).      |
| `to`        | `p5.Tree.WORLD`   | Target space (constant or matrix).      |
| `eMatrix`   | current eye       | Pre-computed eye matrix.                |
| `pMatrix`   | current proj      | Override projection matrix.             |
| `vMatrix`   | current view      | Override view matrix.                   |
| `pvMatrix`  | P·V               | Pre-computed PV — skips multiply.       |
| `ipvMatrix` | inv(PV)           | Pre-computed IPV — skips inversion.     |

`from` / `to` accept: `p5.Tree.WORLD`, `EYE`, `SCREEN`, `NDC`, `MODEL`, or a mat4 for a custom local frame.

```js
const loc = new Float32Array(3)
const dir = new Float32Array(3)

mapLocation(loc)                                                    // camera world position
mapDirection(dir)                                                   // camera view direction
mapLocation(loc, [100,0,0], { from: p5.Tree.WORLD, to: p5.Tree.SCREEN })
```

Constants: `p5.Tree.ORIGIN`, `p5.Tree.i`, `p5.Tree.j`, `p5.Tree.k`, `p5.Tree._i`, `p5.Tree._j`, `p5.Tree._k`.

## Heads Up Display

Draw directly in screen space — independent of the current camera and 3D transforms.

```js
beginHUD()
text('FPS: ' + frameRate().toFixed(1), 10, 20)
endHUD()
```

Coordinates: `(x, y) ∈ [0, width] × [0, height]`, origin top-left, y increasing downward.

---

# Panels

A unified `createPanel` factory covers parameter bindings and track transport controls. The first argument determines the panel type.

## Parameter panel

Binds named schema keys to DOM sliders, checkboxes, color pickers, dropdowns, and buttons. Target receives `(name, value)` on each dirty tick.

```js
const panel = createPanel({
  speed:     { min: 0, max: 0.05, value: 0.012, step: 0.001 },
  shininess: { min: 1, max: 200,  value: 80,    step: 1,    type: 'int' },
  showGrid:  { value: true },
  tint:      { value: '#ff8844' },
  fxOrder:   { type: 'select', options: [
                 { label: 'noise → dof', value: '1' },
                 { label: 'dof → noise', value: '2' }
               ], value: '1' }
}, { x: 10, y: 10, width: 160, labels: true, title: 'Scene', color: 'white',
     target: (name, value) => shader.setUniform(name, value) })

// call every frame
panel.tick()
```

| Option     | Default         | Description                                              |
|------------|-----------------|----------------------------------------------------------|
| `target`   | —               | `fn(name, value)` or object with `.set(name, value)`.   |
| `x` / `y`  | `0`             | Position (px).                                          |
| `width`    | `120`           | Slider width (px).                                      |
| `labels`   | `false`         | Show parameter name labels.                             |
| `title`    | —               | Optional title row.                                     |
| `collapsible` | `false`      | Title row becomes a collapse toggle.                    |
| `collapsed`   | `false`      | Start collapsed (implies collapsible).                  |
| `color`    | —               | Container text color.                                   |
| `hidden`   | `false`         | Start hidden.                                           |
| `parent`   | `document.body` | Mount target (`HTMLElement`).                           |

## Track transport panel

Controls playback of any `PoseTrack` or `CameraTrack`.

```js
const ui = createPanel(track, {
  x: 10, y: 10, width: 170,
  loop: false, rate: 1,
  seek: true, props: true, info: true,
  color: 'white'
})

// call every frame
ui.tick()
```

| Option      | Default        | Description                                        |
|-------------|----------------|----------------------------------------------------|
| `seek`      | `true`         | Show seek slider.                                  |
| `props`     | `true`         | Show rate slider + mode select.                    |
| `info`      | `false`        | Show time/keyframe readout.                        |
| `rate`      | track.rate     | Initial rate.                                      |
| `loop`      | track.loop     | Initial loop mode.                                 |
| `pingPong`  | track.pingPong | Initial pingPong mode.                             |
| `depth`     | `0.5`          | Initial + button depth [0..1].                     |
| `camera`    | curCamera      | Camera for + button. `null` suppresses it.         |

Lifecycle hooks can be passed directly in opt:

```js
createPanel(track, {
  onPlay: t => console.log('playing'),
  onEnd:  t => console.log('done'),
  onStop: t => console.log('stopped'),
  x: 10, y: 10
})
```

**Returned handle** (both panel types):

```js
panel.el            // HTMLElement container
panel.visible       // get/set boolean
panel.collapsed     // get/set boolean (requires collapsible + title)
panel.parent(el)    // re-mount into a different HTMLElement
panel.tick()        // called automatically — no need to call manually
panel.dispose()     // remove from DOM
```

## Collapsible panels

Any panel with a `title` can be made collapsible. Clicking the title row toggles the content.

```js
createPanel(schema, { title: 'Noise', collapsible: true, collapsed: true })
createPanel(track,  { title: 'Camera path', collapsible: true })
```

Programmatic control:

```js
panel.collapsed = true
panel.collapsed = false
```

---

# Post-processing

A lightweight multi-pass pipeline for `p5.Framebuffer`, `p5.strands`, and standard WebGL rendering. `pipe()` chains filter shaders, reuses internal ping/pong framebuffers, and optionally displays the result. Framebuffers are lazily allocated and released on sketch removal.

## pipe

```js
pipe(source, passes, options)
```

| Parameter | Description                                           |
|-----------|-------------------------------------------------------|
| `source`  | `p5.Framebuffer`, texture, image, or graphics.       |
| `passes`  | Array of filters, or a single filter instance.       |
| `options` | See table below.                                     |

| Option           | Default         | Description                                         |
|------------------|-----------------|-----------------------------------------------------|
| `display`        | `true`          | Draw final output to the main canvas.               |
| `allocate`       | `true`          | Auto-allocate and cache internal ping/pong.         |
| `key`            | `'default'`     | Cache key for multiple independent pipelines.       |
| `ping` / `pong`  | —               | User-provided framebuffers (advanced override).     |
| `clear`          | `true`          | Clear each pass target before drawing.              |
| `clearDisplay`   | `true`          | Clear main canvas before final blit.                |
| `clearFn`        | `background(0)` | Custom clear strategy for passes.                  |
| `clearDisplayFn` | `clearFn`       | Custom clear strategy for display stage.            |
| `draw`           | full blit       | Custom draw strategy for placing texture on target. |

## releasePipe

```js
releasePipe()         // release default pipeline
releasePipe(true)     // release all pipelines
releasePipe('key')    // release a named pipeline
```

---

# Picking

Two complementary strategies — GPU color-ID for whole-scene picking, CPU proximity for per-object hit testing.

## GPU color-ID picking

Renders the scene into a cached 1×1 framebuffer with a pick-matrix projection aligned to the query pixel, reads back one RGBA pixel, and decodes a 24-bit integer id. Supports up to 16 777 215 unique ids. id `0` is reserved for background / miss.

```js
// tag(id) encodes an integer as a CSS hex string — works with fill() regardless of colorMode()
fill(tag(1)); box(60)
fill(tag(2)); sphere(40)
```

```js
// colorPick — explicit coordinates
const hit = colorPick(mouseX, mouseY, () => {
  push(); fill(tag(1)); box(60);    pop()
  push(); fill(tag(2)); sphere(40); pop()
})
if (hit === 1) console.log('box!')
if (hit === 2) console.log('sphere!')

// mousePick — shorthand for colorPick(mouseX, mouseY, fn)
const hit = mousePick(() => {
  push(); fill(tag(1)); box(60);    pop()
  push(); fill(tag(2)); sphere(40); pop()
})
```

Before `drawFn` is called, the library unconditionally sets `noLights()`, `noStroke()`, `resetShader()`.
Stroke is excluded from the pick buffer by default — call `stroke(tag(id))` inside `drawFn` to include it,
skipping the stroke render passes when precision or performance warrants it.
When stroke is included, both `fill` and `stroke` must carry the same `tag(id)`.
The FBO is lazily allocated on first use and released on sketch removal.

## CPU proximity picking

Tests whether a pointer position falls within a radius of the current model's projected screen-space origin. Zero GPU round-trip — call inside `push()`/`pop()` for each pickable object.

```js
// mouseHit — test against mouseX/mouseY
push()
translate(x, y, z)
if (mouseHit()) { fill('red') } else { fill('white') }
box(60)
pop()

// pointerHit — explicit coordinates (base form)
push()
translate(x, y, z)
if (pointerHit(touchX, touchY)) { fill('red') } else { fill('white') }
box(60)
pop()
```

Both accept the same options object:

| Option     | Default          | Description                                    |
|------------|------------------|------------------------------------------------|
| `mMatrix`  | current model    | Override model matrix.                         |
| `size`     | `50`             | Hit radius (world units, auto-scaled by depth).|
| `shape`    | `p5.Tree.CIRCLE` | `CIRCLE` or `SQUARE`.                          |
| `eMatrix`  | current eye      | Pre-computed eye matrix.                       |
| `pMatrix`  | current proj     | Override projection.                           |
| `vMatrix`  | current view     | Override view.                                 |
| `pvMatrix` | P·V              | Pre-computed PV.                               |

---

# Utilities

```js
p5.Tree.VERSION   // '0.0.27'
```

**Visibility testing** — frustum culling against the current camera:

```js
visibility({ corner1, corner2 })    // box
visibility({ center, radius })      // sphere
visibility({ center })              // point
// → p5.Tree.VISIBLE | SEMIVISIBLE | INVISIBLE
```

---

# Gizmos

Scene-space diagnostic helpers — drawn to understand the scene, not to build it.

```js
axes([{ size, bits, mMatrix, eMatrix, pMatrix, vMatrix, pvMatrix }])
grid([{ size, subdivisions }])
bullsEye([{ size, shape }])
cross([{ size }])
viewFrustum({ pg, eMatrix, pMatrix, vMatrix, bits, viewer })
```

`axes` bits: `p5.Tree.X`, `p5.Tree._X`, `p5.Tree.Y`, `p5.Tree._Y`, `p5.Tree.Z`, `p5.Tree._Z`, `p5.Tree.LABELS`.

`viewFrustum` bits: `p5.Tree.NEAR`, `p5.Tree.FAR`, `p5.Tree.BODY`, `p5.Tree.APEX`.

Matrix params accept `Float32Array(16)` | `ArrayLike` | `p5.Matrix` throughout.

---

# Releases

Latest:

* [https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.js](https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.js)
* [https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.min.js](https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.min.js)
* [https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.esm.js](https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.esm.js)
* [https://www.npmjs.com/package/p5.tree](https://www.npmjs.com/package/p5.tree)

Tagged:

* [https://cdn.jsdelivr.net/npm/p5.tree@0.0.27/dist/p5.tree.js](https://cdn.jsdelivr.net/npm/p5.tree@0.0.27/dist/p5.tree.js)
* [https://cdn.jsdelivr.net/npm/p5.tree@0.0.27/dist/p5.tree.min.js](https://cdn.jsdelivr.net/npm/p5.tree@0.0.27/dist/p5.tree.min.js)
* [https://cdn.jsdelivr.net/npm/p5.tree@0.0.27/dist/p5.tree.esm.js](https://cdn.jsdelivr.net/npm/p5.tree@0.0.27/dist/p5.tree.esm.js)

---

# Usage

## CDN

```html
<script src="https://cdn.jsdelivr.net/npm/p5/lib/p5.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.js"></script>

<script>
  function setup() {
    createCanvas(600, 400, WEBGL)
    axes()
  }

  function draw() {
    background(0.15)
    orbitControl()
  }
</script>
```

Works in global and instance mode.

## npm (ESM)

```bash
npm i p5 p5.tree
```

```js
import p5 from 'p5'
import 'p5.tree'

const sketch = p => {
  p.setup = () => {
    p.createCanvas(600, 400, p.WEBGL)
    p.axes()
  }

  p.draw = () => {
    p.background(0.15)
    p.orbitControl()
  }
}

new p5(sketch)
```
