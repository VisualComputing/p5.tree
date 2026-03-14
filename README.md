# p5.tree

[![npm version](https://img.shields.io/npm/v/p5.tree?color=1f6feb)](https://www.npmjs.com/package/p5.tree)

Shader tools, animation tracks, camera keyframe interpolation, space transforms, and uniform UI controls for 3D rendering with [p5.js v2](https://beta.p5js.org/) ([WEBGL](https://beta.p5js.org/reference/p5/constants/webgl/) / [WEBGL2](https://beta.p5js.org/reference/p5/constants/webgl2/) / [WebGPU](https://beta.p5js.org/reference/p5/constants/webgpu/)).

![A non-Euclidean geometry cube with faces showcasing teapot, bunny, and Buddha models.](p5.tree.png)

* [Keyframes interpolation](#keyframes-interpolation)
  * [Recording keyframes](#recording-keyframes)
  * [Playback](#playback)
  * [Seek, stop, reset, time, info](#seek-stop-reset-time-info)
* [Pose tracks](#pose-tracks)
  * [Recording poses](#recording-poses)
  * [Playing poses](#playing-poses)
* [Space transformations](#space-transformations)
  * [Matrix operations](#matrix-operations)
  * [Matrix queries](#matrix-queries)
  * [Frustum queries](#frustum-queries)
  * [Coordinate space conversions](#coordinate-space-conversions)
  * [Heads Up Display](#heads-up-display)
* [UI](#ui)
  * [Creating a UI](#creating-a-ui)
  * [Accessing values](#accessing-values)
  * [Applying to shaders](#applying-to-shaders)
  * [Default UI](#default-ui)
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

# Keyframes interpolation

A minimal camera-path API built on `p5.Camera.copy()` snapshots and `p5.Camera.slerp()` interpolation.

The path lives in user space as `camera.path` (an array of `p5.Camera` snapshots). You record keyframes, then play the path with a chosen speed and duration.

## Recording keyframes

`camera.addPath(...)` appends a keyframe (camera snapshot) to `camera.path`.

**Overloads**

1. `camera.addPath(eye, center, up, [opts])`
2. `camera.addPath(view, [opts])`
3. `camera.addPath([camera0, camera1, ...], [opts])`
4. `camera.addPath([view0, view1, ...], [opts])`
5. `camera.addPath([opts])`

**Notes**

* In **(1)**, `up` is **mandatory** (no default assumed).
* In **(2)**, `view` is a `Float32Array(16)` or `p5.Matrix(4)` representing a world → camera transform.
* **(3)** appends copies of existing camera snapshots.
* **(4)** appends copies of existing view matrices.
* **(5)** records the current camera state at call time.

Where:

* `eye`, `center`, `up` → `p5.Vector`, `Float32Array(3)`, or `[x, y, z]`
* `view` → `Float32Array(16)`, `p5.Matrix(4)`, or raw `mat4[16]`
* `opts.reset` (default `false`) clears the path before appending

**Example**

```js
let cam

function setup() {
  createCanvas(600, 400, WEBGL)
  cam = createCamera()

  cam.addPath([400, 0, 0], [0, 0, 0], [0, 1, 0])
  cam.addPath(cam)
  cam.addPath(cam.cameraMatrix)
}
```

`addPath(...)` is also available as a `p5` helper forwarding to the active camera.

## Playback

```js
camera.playPath(rate)
camera.playPath({ duration, loop, pingPong, onEnd, rate })
```

Options:

| Option     | Default | Description                                    |
| ---------- | ------- | ---------------------------------------------- |
| `duration` | `30`    | Frames per segment.                            |
| `loop`     | `false` | Wrap at ends.                                  |
| `pingPong` | `false` | Bounce at ends. Takes precedence over `loop`.  |
| `rate`     | `1`     | Speed multiplier.                              |
| `onEnd`    | —       | Callback fired when non-looping playback ends. |

```js
function setup() {
  createCanvas(600, 400, WEBGL)

  addPath([400, 0, 0], [0, 0, 0], [0, 1, 0], { reset: true })
  playPath({ duration: 45, loop: true })
}
```

> Projection safety: `p5.Camera.slerp()` requires identical projection matrices across keyframes. `p5.tree` checks compatibility while recording.

## Seek, stop, reset, time, info

```js
camera.seekPath(t)     // t ∈ [0, 1]
camera.stopPath()
camera.resetPath()
camera.pathTime()      // → number ∈ [0, 1]
camera.pathInfo()      // → snapshot object
```

`pathInfo()` returns:

| Field       | Type    | Description                            |
| ----------- | ------- | -------------------------------------- |
| `keyframes` | number  | Total keyframes in the path.           |
| `segments`  | number  | Total segments (`keyframes - 1`).      |
| `playing`   | boolean | Whether playback is active.            |
| `loop`      | boolean | Whether looping is enabled.            |
| `pingPong`  | boolean | Whether ping-pong mode is enabled.     |
| `rate`      | number  | Playback rate (signed).                |
| `duration`  | number  | Frames per segment.                    |
| `time`      | number  | Normalized time `[0, 1]` across path.  |

Global helpers `seekPath`, `stopPath`, `resetPath`, `pathTime`, and `pathInfo` forward to the active camera.

---

# Pose tracks

A lightweight animation system for recording and replaying arbitrary numeric state — positions, rotations, shader parameters, or any value you want to animate over time.

A **PoseTrack** holds a sequence of poses (snapshots of named values) and interpolates between them on playback.

## Recording poses

```js
const track = createPoseTrack()

track.addPose({ x: 0,   y: 0   })
track.addPose({ x: 100, y: 50  })
track.addPose({ x: 200, y: 100 })
```

Each pose is a plain object. Keys must be consistent across all poses in the track.

## Playing poses

```js
track.playPose({ duration, loop, pingPong, onEnd, onStop })
track.stopPose()
track.resetPose()
```

Options:

| Option     | Default | Description                                             |
| ---------- | ------- | ------------------------------------------------------- |
| `duration` | `30`    | Frames per segment.                                     |
| `loop`     | `false` | Wrap at ends.                                           |
| `pingPong` | `false` | Bounce at ends.                                         |
| `onEnd`    | —       | Callback fired when non-looping playback ends.          |
| `onStop`   | —       | Callback fired when `stopPose()` is called explicitly.  |

Read interpolated values each frame via `track.pose`:

```js
const track = createPoseTrack()

function setup() {
  createCanvas(600, 400, WEBGL)

  track.addPose({ x: -150, r: 0   })
  track.addPose({ x:  150, r: 255 })
  track.playPose({ duration: 60, loop: true, pingPong: true })
}

function draw() {
  background(20)
  translate(track.pose.x, 0, 0)
  fill(track.pose.r, 100, 200)
  sphere(40)
}
```

`onStop` fires only on an explicit `stopPose()` call, making it useful for triggering transitions or cleanup that should not run at natural playback end.

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

`p5.Matrix` is unwrapped to its internal `Float32Array` at zero cost.

**Simple queries** — read directly from renderer state:

```js
const e  = new Float32Array(16)
const pm = new Float32Array(16)

p.eMatrix(e)   // eye matrix (inverse view)
p.pMatrix(pm)  // projection matrix
p.vMatrix(v)   // view matrix (world → eye)
p.mMatrix(m)   // model matrix (local → world)
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

Pass cached buffers to composite queries to avoid recomputation:

```js
const pv  = new Float32Array(16)
const ipv = new Float32Array(16)

function draw() {
  pvMatrix(pv)
  ipvMatrix(ipv, { pvMatrix: pv })  // reuses already-computed PV
  // ...
}
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

When caching `pvMatrix` for picking, fill once and reference directly:

```js
if (cached) pvMatrix(pv)
const params = {
  shape: p5.Tree.CIRCLE,
  ...(cached && { pvMatrix: pv })
}
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
| ----------- | ----------------- | ---------------------------------------------- |
| `from`      | `p5.Tree.EYE`     | Source space (constant or matrix).             |
| `to`        | `p5.Tree.WORLD`   | Target space (constant or matrix).             |
| `eMatrix`   | current eye       | Pre-computed eye matrix — skips inversion.     |
| `pMatrix`   | current proj      | Override projection matrix.                    |
| `vMatrix`   | current view      | Override view matrix.                          |
| `pvMatrix`  | computed from P·V | Pre-computed PV — skips multiplication.        |
| `ipvMatrix` | computed from PV  | Pre-computed IPV — skips inversion.            |

`from` and `to` accept any of: `p5.Tree.WORLD`, `p5.Tree.EYE`, `p5.Tree.SCREEN`, `p5.Tree.NDC`, `p5.Tree.MODEL`, or a matrix (`Float32Array` | `p5.Matrix`) for a custom local frame.

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

**Notes:**

* The default `mapLocation()` call (EYE → WORLD at origin) returns the camera world position.
* The default `mapDirection()` call returns the normalized camera viewing direction.

## Heads Up Display

Draw directly in screen space, independent of the current camera and 3D transforms.

```js
beginHUD()
text('FPS: ' + frameRate().toFixed(1), 10, 20)
endHUD()
```

In HUD mode, coordinates follow standard 2D conventions: `(x, y) ∈ [0, width] × [0, height]`, origin at the top-left, y increasing downward.

---

# UI

A schema-driven parameter panel — sliders, checkboxes, color pickers, dropdowns,
and buttons — with optional shader push via `target`. Zero p5 dependencies; mounts
into any container.

## Creating a UI

```js
const ui = createUI({
  blurIntensity: { min: 0, max: 4, value: 2, step: 0.1 },
  useLighting:   { value: true },
  tintColor:     { value: '#ff8844' }
})
```

Type inference:

| Value type          | Control  |
| ------------------- | -------- |
| number              | slider   |
| boolean             | checkbox |
| color string        | color picker |
| array length 2/3/4  | vec2/3/4 |
| `options` array     | select   |
| `onClick` function  | button   |

Override with `{ type: 'int', min: 0, max: 10 }`.

## Accessing values

```js
ui.blurIntensity.value()
ui.blurIntensity.set(3)
ui.blurIntensity.reset()

const all = ui.values()
```

```js
ui.blurIntensity.visible = false
ui.blurIntensity.visible = true
```

## Applying to shaders

```js
ui.applyTo(shader)
```

With remapping:

```js
ui.applyTo(shader, {
  blurIntensity: 'uBlur',
  tintColor: {
    uniform: 'uColor',
    value: v => v.slice(0, 3)
  }
})
```

For `p5.strands`, bind explicitly inside `.modify()`:

```js
const blurIntensity = uniformFloat(() => ui.blurIntensity.value())
```

## Default UI

```js
ui.visible = true
ui.visible = false
ui.remove()
ui.config({ x: 20, y: 20, width: 160, offset: 8 })
```

Mount into a specific container:

```js
const ui = createUI(schema, {
  parent: document.getElementById('sketch'),
  x: 10,
  y: 10
})
```

When `parent` is provided, `createUI` ensures the container has a proper positioning context so `x/y` anchoring works predictably.

Labels: omit → uniform key, `label: false` → no label, `label: 'Custom'` → custom text.

---

# Post-processing

A lightweight multi-pass post-processing pipeline for `p5.Framebuffer`, `p5.strands`, and standard WebGL rendering.

`pipe()` chains filter shaders, reuses internal ping/pong framebuffers, and optionally displays the result. Framebuffers are lazily allocated and automatically released when the sketch is removed.

## `pipe`

```js
pipe(source, passes, options)
```

| Parameter | Description |
| --------- | ----------- |
| `source`  | `p5.Framebuffer`, texture, image, or graphics. |
| `passes`  | Array of filters, or a single filter instance. |
| `options` | See table below. |

| Option           | Default               | Description                                              |
| ---------------- | --------------------- | -------------------------------------------------------- |
| `display`        | `true`                | Draw final result to the main canvas.                    |
| `allocate`       | `true`                | Allocate internal ping/pong framebuffers when missing.   |
| `key`            | `'default'`           | Cache key for internal ping/pong.                        |
| `ping`, `pong`   | —                     | User-provided framebuffers (advanced override).          |
| `clear`          | `true`                | Clear ping/pong passes before drawing.                   |
| `clearDisplay`   | `true`                | Clear canvas before final display.                       |
| `clearFn`        | `() => background(0)` | Clear strategy for passes.                               |
| `clearDisplayFn` | `clearFn`             | Clear strategy for display stage.                        |
| `draw`           | full-canvas blit      | Custom draw strategy per pass.                           |

```js
// basic
pipe(layer, [noiseFilter, pixelFilter, blurFilter])

// multiple independent pipelines
pipe(sceneFbo, scenePasses, { key: 'scene' })
pipe(minimapFbo, miniPasses, { key: 'mini', display: false })

// transparent final composite
pipe(layer, passes, {
  clearFn: () => background(0),
  clearDisplayFn: () => clear()
})

// custom draw
pipe(layer, passes, {
  draw: tex => image(tex, -200, -150, 400, 300)
})
```

When `display: false`, `pipe()` returns the final framebuffer.

## `releasePipe`

```js
releasePipe()          // release default pipeline
releasePipe('key')     // release a named pipeline
releasePipe(true)      // release all pipelines
```

---

# Utilities

1. `texOffset(image)` — `[1 / image.width, 1 / image.height]`.
2. `mousePosition([flip = true])` — pixel-density-aware mouse position. Optionally flips Y.
3. `pointerPosition(pointerX, pointerY, [flip = true])` — pixel-density-aware pointer position.
4. `resolution()` — `[pd * width, pd * height]`.
5. `pixelRatio(point)` — world-units-per-pixel at `point` (a world-space `Float32Array(3)`, `ArrayLike`, or `p5.Vector`).
6. `mousePicking([opts])` / `pointerPicking(pointerX, pointerY, [opts])` — hit-test a screen-space circle or square tied to the current model matrix.
7. `bounds([{ eMatrix }])` — frustum planes as a keyed object `{ LEFT, RIGHT, NEAR, FAR, TOP, BOTTOM }` each `{ a, b, c, d }`.
8. `visibility({ corner1, corner2 } | { center, radius } | { center })` — returns `p5.Tree.VISIBLE`, `p5.Tree.SEMIVISIBLE`, or `p5.Tree.INVISIBLE`.

`mousePicking` and `pointerPicking` accept:

| Key        | Default           | Description                                 |
| ---------- | ----------------- | ------------------------------------------- |
| `mMatrix`  | current model     | `Float32Array(16)` \| `p5.Matrix`.          |
| `size`     | `50`              | Hit area in pixels.                         |
| `shape`    | `p5.Tree.CIRCLE`  | `p5.Tree.CIRCLE` or `p5.Tree.SQUARE`.       |
| `pvMatrix` | computed          | Pre-computed PV — avoids recomputation.     |
| `eMatrix`  | computed          | Pre-computed eye matrix.                    |
| `x`, `y`   | projected origin  | Override screen position directly.          |

---

# Drawing stuff

1. `axes({ size, colors, bits })` — world-space axis lines with optional labels.
2. `grid({ size, subdivisions })` — ground grid.
3. `cross({ mMatrix, x, y, size, eMatrix, pMatrix, vMatrix, pvMatrix })` — screen-space crosshair centred on the current model's origin.
4. `bullsEye({ mMatrix, x, y, size, shape, eMatrix, pMatrix, vMatrix, pvMatrix })` — screen-space bulls-eye overlay.
5. `viewFrustum({ pg, eMatrix, pMatrix, vMatrix, bits, viewer })` — draw another camera's frustum into this renderer.

Matrix params (`mMatrix`, `eMatrix`, `pMatrix`, `vMatrix`, `pvMatrix`) accept `Float32Array(16)` | `p5.Matrix` throughout. Pass cached buffers to avoid per-frame recomputation.

`viewFrustum` bits: `p5.Tree.NEAR`, `p5.Tree.FAR`, `p5.Tree.BODY`, `p5.Tree.APEX`.
`axes` bits: `p5.Tree.X`, `p5.Tree._X`, `p5.Tree.Y`, `p5.Tree._Y`, `p5.Tree.Z`, `p5.Tree._Z`, `p5.Tree.LABELS`.

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
