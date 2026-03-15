# p5.tree

[![npm version](https://img.shields.io/npm/v/p5.tree?color=1f6feb)](https://www.npmjs.com/package/p5.tree)

Shader tools, animation tracks, camera keyframe interpolation, space transforms, and parameter panels for 3D rendering with [p5.js v2](https://beta.p5js.org/) ([WEBGL](https://beta.p5js.org/reference/p5/constants/webgl/) / [WEBGL2](https://beta.p5js.org/reference/p5/constants/webgl2/) / [WebGPU](https://beta.p5js.org/reference/p5/constants/webgpu/)).

![A non-Euclidean geometry cube with faces showcasing teapot, bunny, and Buddha models.](p5.tree.png)

* [Tracks](#tracks)
  * [PoseTrack — object animation](#posetrack--object-animation)
  * [CameraTrack — camera keyframe paths](#cameratrack--camera-keyframe-paths)
  * [Playback options](#playback-options)
  * [Camera helpers](#camera-helpers)
* [Space transformations](#space-transformations)
  * [Matrix operations](#matrix-operations)
  * [Matrix queries](#matrix-queries)
  * [Frustum queries](#frustum-queries)
  * [Coordinate space conversions](#coordinate-space-conversions)
  * [Heads Up Display](#heads-up-display)
* [Panels](#panels)
  * [Parameter panel](#parameter-panel)
  * [Track transport panel](#track-transport-panel)
  * [Collapsible panels](#collapsible-panels)
* [Post-processing](#post-processing)
  * [pipe](#pipe)
  * [releasePipe](#releasepipe)
* [Utilities](#utilities)
* [Drawing stuff](#drawing-stuff)
* [Releases](#releases)
* [Usage](#usage)
  * [CDN](#cdn)
  * [npm (ESM)](#npm-esm)

---

# Tracks

A unified factory creates either a **PoseTrack** (object animation) or a **CameraTrack** (camera keyframe path), depending on whether a camera is passed.

```js
const track = createTrack()        // PoseTrack — animates any object
const track = createTrack(cam)     // CameraTrack — drives a p5.Camera
const track = createTrack(getCamera())  // CameraTrack on the default camera
```

## PoseTrack — object animation

Stores `{ pos, rot, scl }` keyframes. Interpolates position with centripetal Catmull-Rom, rotation with slerp or nlerp, scale with linear.

```js
const track = createTrack()
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

`add()` accepts flexible `rot` specs — no normalisation needed:

```js
track.add({ pos:[0,0,0], rot: [x,y,z,w] })               // raw quaternion
track.add({ pos:[0,0,0], rot: { axis:[0,1,0], angle: PI/4 } })  // axis-angle
track.add({ pos:[0,0,0], rot: { dir:[1,0,0] } })           // look direction
```

Interpolation modes:

```js
track.posInterp = 'catmullrom'  // default — smooth curves
track.posInterp = 'linear'

track.rotInterp = 'slerp'       // default — constant angular velocity
track.rotInterp = 'nlerp'       // faster, slightly non-constant speed
```

`eval(out)` writes into a pre-allocated buffer — zero heap allocation per frame. Use `toMatrix(outMat4)` to evaluate directly into a column-major mat4.

## CameraTrack — camera keyframe paths

Stores `{ eye, center, up }` lookat keyframes. Playback applies automatically each frame via `cam.camera()` — no draw-loop guard needed.

```js
let cam, track

function setup() {
  createCanvas(600, 400, WEBGL)
  cam   = createCamera()
  track = createTrack(cam)

  track.add({ eye:[0,0,500], center:[0,0,0] })
  track.add({ eye:[300,-150,0], center:[0,0,0] })
  track.add({ eye:[-200,100,-300], center:[0,0,0] })
  track.play({ loop: true, duration: 90 })
}

function draw() {
  background(20)
  setCamera(cam)
  orbitControl()   // works freely when track is stopped
  axes(); grid()
}
```

Capture the current camera state as a keyframe:

```js
track.add(cam.capturePose())   // records live eye/center/up
```

Interpolation modes:

```js
track.eyeInterp    = 'catmullrom'  // default
track.eyeInterp    = 'linear'

track.centerInterp = 'linear'      // default — suits fixed lookat targets
track.centerInterp = 'catmullrom'  // smoother when center is also flying
```

## Playback options

All tracks share the same transport API:

```js
track.play({ duration, loop, pingPong, rate, onPlay, onEnd, onStop })
track.stop()
track.seek(t)    // t ∈ [0, 1]
track.time()     // → number ∈ [0, 1]
track.info()     // → { keyframes, segments, playing, loop, ... }
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

`track.keyframes` — direct array access. `track.playing`, `track.loop`, `track.pingPong`, `track.rate`, `track.duration` — readable at any time.

## Camera helpers

```js
getCamera()              // returns curCamera (use with createTrack)

cam.capturePose()        // → { eye, center, up } from live camera state
cam.capturePose(out)     // writes into pre-allocated out — zero allocation

cam.applyPose(pose)      // apply { eye, center, up } to cam.camera()
                         // also accepts { pos, rot, scl } TRS form

rotateQuat(q)            // rotate by [x,y,z,w] quaternion
applyPose(pose)          // apply { pos, rot, scl } to the transform stack
```

---

# Space transformations

Matrix operations, matrix/frustum queries, and coordinate conversions.

## Matrix operations

`createMatrix(...args)` — convenience wrapper around `new p5.Matrix(...args)`.

## Matrix queries

All matrix queries follow the same contract:

* `out` is the **first** parameter — the caller owns and provides the buffer.
* The function writes the result into `out` and **returns `out`**.
* Returns `null` if the matrix is singular (where applicable).
* No allocations — pass the same buffer every frame.

**Accepted types for `out` and matrix override params:**
`Float32Array` | `ArrayLike` | `p5.Matrix`

**Simple queries** — read directly from renderer state:

```js
const e  = new Float32Array(16)
const pm = new Float32Array(16)

eMatrix(e)    // eye matrix (inverse view)
pMatrix(pm)   // projection matrix
vMatrix(v)    // view matrix (world → eye)
mMatrix(m)    // model matrix (local → world)
```

**Composite queries** — `out` first, optional matrix overrides in an opts object:

```js
pvMatrix(out, [{ pMatrix, vMatrix }])
ipvMatrix(out, [{ pMatrix, vMatrix, pvMatrix }])
mvMatrix(out, [{ mMatrix, vMatrix }])
pmvMatrix(out, [{ pMatrix, mMatrix, vMatrix }])
nMatrix(out, [{ mMatrix, vMatrix, mvMatrix }])   // 9-element out
lMatrix(out, from, to)   // location transform: inv(to) · from
dMatrix(out, from, to)   // direction transform: to₃ · inv(from₃), 9-element out
```

**Recommended draw-loop pattern — zero allocations:**

```js
// setup
const e   = new Float32Array(16)
const pm  = new Float32Array(16)
const pv  = new Float32Array(16)

// draw
eMatrix(e)
pMatrix(pm)
pvMatrix(pv)
viewFrustum({ eMatrix: e, pMatrix: pm })
mousePicking({ pvMatrix: pv, eMatrix: e })
```

## Frustum queries

Scalar values read directly from the current projection matrix — no buffer needed.

1. `lPlane()`, `rPlane()`, `bPlane()`, `tPlane()` — frustum side planes.
2. `nPlane()`, `fPlane()` — near and far distances.
3. `fov()` — vertical field-of-view (radians).
4. `hfov()` — horizontal field-of-view (radians).
5. `isOrtho()` — `true` for orthographic projection.

## Coordinate space conversions

```js
mapLocation(out, point, [opts])   // explicit input point
mapLocation(out, [opts])          // defaults to p5.Tree.ORIGIN
mapLocation(out)                  // defaults to ORIGIN, EYE → WORLD

mapDirection(out, vector, [opts]) // explicit input direction
mapDirection(out, [opts])         // defaults to p5.Tree._k
mapDirection(out)                 // defaults to _k, EYE → WORLD
```

`out` is a 3-element `Float32Array`, `ArrayLike`, or `p5.Vector`. The same object is returned.

**Options:**

| Key         | Default           | Description                                    |
|-------------|-------------------|------------------------------------------------|
| `from`      | `p5.Tree.EYE`     | Source space (constant or matrix).             |
| `to`        | `p5.Tree.WORLD`   | Target space (constant or matrix).             |
| `eMatrix`   | current eye       | Pre-computed eye matrix — skips inversion.     |
| `pMatrix`   | current proj      | Override projection matrix.                    |
| `vMatrix`   | current view      | Override view matrix.                          |
| `pvMatrix`  | computed from P·V | Pre-computed PV — skips multiplication.        |
| `ipvMatrix` | computed from PV  | Pre-computed IPV — skips inversion.            |

`from` and `to` accept: `p5.Tree.WORLD`, `p5.Tree.EYE`, `p5.Tree.SCREEN`, `p5.Tree.NDC`, `p5.Tree.MODEL`, or a matrix for a custom local frame.

```js
const loc = new Float32Array(3)
const dir = new Float32Array(3)

// camera world position
mapLocation(loc)

// camera viewing direction
mapDirection(dir)

// screen-space projection of a world point
mapLocation(loc, [100, 0, 0], { from: p5.Tree.WORLD, to: p5.Tree.SCREEN })

// project the current model's origin to screen
const m = new Float32Array(16)
mMatrix(m)
mapLocation(loc, p5.Tree.ORIGIN, { from: m, to: p5.Tree.SCREEN })
```

**Useful constants:** `p5.Tree.ORIGIN`, `p5.Tree.i`, `p5.Tree.j`, `p5.Tree.k`, `p5.Tree._i`, `p5.Tree._j`, `p5.Tree._k`.

Notes:
- Default `mapLocation()` (EYE → WORLD at origin) returns the camera world position.
- Default `mapDirection()` returns the normalized camera viewing direction.

## Heads Up Display

Draw directly in screen space, independent of the current camera and 3D transforms.

```js
beginHUD()
text('FPS: ' + frameRate().toFixed(1), 10, 20)
endHUD()
```

Coordinates: `(x, y) ∈ [0, width] × [0, height]`, origin top-left, y increasing downward.

---

# Panels

A unified `createPanel` factory covers both parameter bindings and track transport controls. The first argument determines the panel type — a track (has `.play`) gets transport controls, a schema object gets parameter controls.

```js
createPanel(track,  opt)   // transport panel
createPanel(schema, opt)   // parameter panel
```

## Parameter panel

Binds named parameters to DOM controls. When `target` is provided, values are pushed automatically every frame — no boilerplate in draw.

```js
// Push to a p5 shader via setUniform
const panel = createPanel({
  blurRadius:   { min: 0, max: 10, value: 2,    step: 0.1 },
  useLighting:  { value: true },
  tintColor:    { value: '#ff8844' },
  quality:      { type: 'select', options: [
                    { label: 'low',  value: '1' },
                    { label: 'high', value: '2' }
                  ], value: '2' }
}, { target: myShader, x: 10, y: 10, labels: true, title: 'Scene', color: 'white' })
```

Type inference from schema value:

| Value type         | Control       |
|--------------------|---------------|
| number             | slider        |
| boolean            | checkbox      |
| CSS color string   | color picker  |
| array [2..4]       | vec2/3/4 sliders |
| `options` array    | dropdown      |
| `onClick` function | button        |

Override with `{ type: 'int', ... }`.

**Target options:**

```js
// p5 shader — setUniform called automatically
{ target: myShader }

// plain function
{ target: (name, value) => myObj[name] = value }

// object with .set
{ target: myObject }   // myObject.set(name, value) is called each tick

// omitted — read values manually
panel.blurRadius.value()
panel.blurRadius.set(3)
panel.blurRadius.reset()
panel.blurRadius.visible = false
```

**Layout options** shared by both panel types:

| Option        | Default          | Description                          |
|---------------|------------------|--------------------------------------|
| `x`           | `0`              | Container left (px).                 |
| `y`           | `0`              | Container top (px).                  |
| `width`       | `120`            | Default slider/select width (px).    |
| `color`       | —                | Text color.                          |
| `title`       | —                | Bold title row.                      |
| `collapsible` | `false`          | Title row becomes a collapse toggle. |
| `collapsed`   | `false`          | Start collapsed (implies collapsible).|
| `hidden`      | `false`          | Start hidden.                        |
| `parent`      | canvas container | Mount target (`HTMLElement` or `p5.Element`). |

Additional parameter panel options: `labels`, `offset`.

## Track transport panel

```js
// CameraTrack — camera auto-resolved from track.camera
const cam   = createCamera()
const track = createTrack(cam)
const panel = createPanel(track, { x: 10, y: 10, color: 'white', title: 'Camera' })

// PoseTrack — curCamera used for + button by default
const track = createTrack()
const panel = createPanel(track, { x: 10, y: 10, color: 'white' })

// PoseTrack — suppress + button
createPanel(track, { camera: null, x: 10, y: 10 })
```

Transport panel layout (top → bottom):

```
  [ + ]  [ ▶/⏸ ]  [ ↺ ]       — add keyframe / play-pause / reset
  depth: ──────────────         — placement depth for new keyframes (0=near, 1=far)
  seek:  ──────────────         — scrub position [0, 1]
  rate:  ──────────────         — signed speed (negative reverses)
  mode:  [ once | loop | pingPong ]
  t: 0.412  seg 1/3  kf 4       — info readout
```

Transport panel options:

| Option      | Default | Description                                    |
|-------------|---------|------------------------------------------------|
| `seek`      | `true`  | Show seek slider.                              |
| `props`     | `true`  | Show rate slider + mode select.                |
| `info`      | `false` | Show time/keyframe readout.                    |
| `rate`      | `1`     | Initial rate.                                  |
| `loop`      | `false` | Initial loop mode.                             |
| `pingPong`  | `false` | Initial pingPong mode.                         |
| `depth`     | `0.5`   | Initial + button depth [0..1].                 |
| `camera`    | curCamera | Camera for + button. `null` suppresses it.  |

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
createPanel(schema, { title: 'Noise', collapsible: true, collapsed: true, ... })
createPanel(track,  { title: 'Camera path', collapsible: true, ... })
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

| Option           | Default     | Description                                             |
|------------------|-------------|---------------------------------------------------------|
| `display`        | `true`      | Draw final output to the main canvas.                   |
| `allocate`       | `true`      | Auto-allocate and cache internal ping/pong.             |
| `key`            | `'default'` | Cache key for multiple independent pipelines.           |
| `ping` / `pong`  | —           | User-provided framebuffers (advanced override).         |
| `clear`          | `true`      | Clear each pass target before drawing.                  |
| `clearDisplay`   | `true`      | Clear main canvas before final blit.                    |
| `clearFn`        | `background(0)` | Custom clear strategy for passes.                  |
| `clearDisplayFn` | `clearFn`   | Custom clear strategy for display stage.                |
| `draw`           | full blit   | Custom draw strategy for placing texture on target.     |

## releasePipe

```js
releasePipe()         // release default pipeline
releasePipe(true)     // release all pipelines
releasePipe('key')    // release a named pipeline
```

---

# Utilities

```js
p5.Tree.VERSION   // '0.0.19'
```

**Visibility testing** — frustum culling against the current camera:

```js
visibility({ corner1, corner2 })    // box visibility
visibility({ center, radius })      // sphere visibility
visibility({ point })               // point visibility
// → p5.Tree.VISIBLE | SEMIVISIBLE | INVISIBLE
```

**Picking**:

```js
mousePicking({ pvMatrix, eMatrix, [shape] })
// shape: p5.Tree.CIRCLE (default) | p5.Tree.SQUARE
```

---

# Drawing stuff

```js
axes([{ size, bits, mMatrix, eMatrix, pMatrix, vMatrix, pvMatrix }])
grid([{ size, subdivisions, mMatrix }])
bullsEye([{ size, shape }])
cross([{ size }])
viewFrustum({ pg, eMatrix, pMatrix, vMatrix, bits, viewer })
```

`viewFrustum` bits: `p5.Tree.NEAR`, `p5.Tree.FAR`, `p5.Tree.BODY`, `p5.Tree.APEX`.
`axes` bits: `p5.Tree.X`, `p5.Tree._X`, `p5.Tree.Y`, `p5.Tree._Y`, `p5.Tree.Z`, `p5.Tree._Z`, `p5.Tree.LABELS`.

Matrix params accept `Float32Array(16)` | `p5.Matrix` throughout.

---

# Releases

Latest:

* [https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.js](https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.js)
* [https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.min.js](https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.min.js)
* [https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.esm.js](https://cdn.jsdelivr.net/npm/p5.tree/dist/p5.tree.esm.js)
* [https://www.npmjs.com/package/p5.tree](https://www.npmjs.com/package/p5.tree)

Tagged:

* [https://cdn.jsdelivr.net/npm/p5.tree@0.0.19/dist/p5.tree.js](https://cdn.jsdelivr.net/npm/p5.tree@0.0.19/dist/p5.tree.js)
* [https://cdn.jsdelivr.net/npm/p5.tree@0.0.19/dist/p5.tree.min.js](https://cdn.jsdelivr.net/npm/p5.tree@0.0.19/dist/p5.tree.min.js)
* [https://cdn.jsdelivr.net/npm/p5.tree@0.0.19/dist/p5.tree.esm.js](https://cdn.jsdelivr.net/npm/p5.tree@0.0.19/dist/p5.tree.esm.js)

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
