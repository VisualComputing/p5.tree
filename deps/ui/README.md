# `@nakednous/ui`

Schema-driven parameter panels and animation transport controls — **zero dependencies**, pure vanilla DOM.

---

## Installation

```bash
npm install @nakednous/ui
```

```js
import { createUI, createTrackUI } from '@nakednous/ui'
```

---

## Architecture

`@nakednous/ui` is the DOM layer of a three-package stack. It knows nothing about renderers or p5 — it mounts into any `HTMLElement`.

```
  application
      │
      ▼
  p5.tree.js        ← bridge: wires tree + ui into p5.js v2
      │
      ├── @nakednous/ui    ← this package: param panels, transport controls
      │
      └── @nakednous/tree  ← math, spaces, animation, visibility
```

The `target` contract is minimal: a plain function `(name, value) => ...` or an object with `.set(name, value)`. Nothing renderer-specific. Shader wiring (`setUniform`) is handled by the p5.tree bridge, not here.

---

## `createUI`

A schema-driven parameter panel. Controls are inferred from the value type or set explicitly. When `target` is provided the panel pushes values every tick — no boilerplate in the draw loop.

### Type inference

| Value                | Control      |
| -------------------- | ------------ |
| `number`             | slider       |
| `boolean`            | checkbox     |
| CSS color string     | color picker |
| array length 2–4     | vec2/3/4 sliders |
| `options` array      | dropdown     |
| `onClick` function   | button       |

Override with `{ type: 'int', ... }`.

### Schema

```js
import { createUI } from '@nakednous/ui'

const ui = createUI({
  speed:     { min: 0,   max: 0.05, value: 0.012, step: 0.001 },
  shininess: { min: 1,   max: 200,  value: 80,    step: 1,    type: 'int' },
  showGrid:  { value: true },
  tint:      { value: '#ff8844' },
  fxOrder:   { type: 'select', options: [
                 { label: 'noise → dof', value: '1' },
                 { label: 'dof → noise', value: '2' }
               ], value: '1' }
}, { x: 10, y: 10, width: 160, labels: true, title: 'Scene', color: 'white' })
```

### Reading values manually

```js
// in draw() — read the panel state directly
shininess(ui.shininess.value())
if (ui.showGrid.value()) grid({ size: 500 })
```

### Pushing values to a target

`target` accepts a plain function or an object with `.set`:

```js
// plain function
const ui = createUI({
  strength: { min: 0, max: 1, value: 0.4, step: 0.01 },
  vignette: { min: 0, max: 3, value: 1.4, step: 0.05 }
}, { target: (name, value) => myNode[name] = value })

// object with .set
const ui = createUI({
  threshold: { min: 0, max: 1, value: 0.5 }
}, { target: physicsWorld })   // physicsWorld.set(name, value) is called each tick
```

When used through **p5.tree**, passing a p5 shader as `target` works directly — the bridge intercepts it and wraps `setUniform` before passing down:

```js
// in p5.tree — shader target resolved by the bridge
const ui = createUI({
  strength: { min: 0, max: 1, value: 0.4, step: 0.01 },
  vignette: { min: 0, max: 3, value: 1.4, step: 0.05 }
}, { target: filter })

// in draw() — no setUniform() calls needed
pipe(layer, [filter])
```

For [p5.strands](https://beta.p5js.org/tutorials/intro-to-p5-strands/), declare the uniform binding explicitly inside the callback — the key name matches the schema key:

```js
const strength = uniformFloat('strength')   // matched by target: filter
```

### Per-control API

```js
ui.strength.value()       // current value
ui.strength.set(0.8)      // set programmatically — marks dirty, pushed on next tick
ui.strength.reset()       // restore initial value — marks dirty
ui.strength.visible = false

ui.visible = false        // hide whole panel
ui.reset()                // reset all controls
ui.tick()                 // push dirty values to target — call once per frame
ui.dispose()              // remove from DOM
ui.parent(el)             // re-mount into a different HTMLElement
```

### Tick model and invariant

`tick()` is designed to be called once per frame — the same clock that drives `PoseTrack` playback in the host. It only pushes a value when the control has changed since the last push (dirty flag). The first tick always pushes all values to initialise the target.

**Invariant:** the target is called at most once per control per frame, and only if the value changed since the last push.

This is the correct behaviour for rendering sinks — shaders, scene parameters, physics config. Multiple interactions within a single frame (rapid slider drag, several programmatic `set()` calls) collapse to one push at tick time. This library is not designed for sinks that require every intermediate delta.

### Layout options

| Option    | Default          | Description                        |
| --------- | ---------------- | ---------------------------------- |
| `target`  | —                | `(name, value) => ...` or `{ set(name, value) }`. |
| `x`       | `0`              | Container left (px).               |
| `y`       | `0`              | Container top (px).                |
| `width`   | `120`            | Default control width (px).        |
| `offset`  | `6`              | Vertical gap between rows (px).    |
| `labels`  | `false`          | Show per-control labels.           |
| `title`   | —                | Bold title row.                    |
| `color`   | —                | Container text color.              |
| `hidden`  | `false`          | Start hidden.                      |
| `parent`  | `document.body`  | Mount target (`HTMLElement`).      |

---

## `createTrackUI`

A transport panel for any `PoseTrack`-compatible target. Duck-typed: the target just needs `play`, `stop`, `seek`, `time`, and `playing`.

### Layout (top → bottom)

```
  [ + ]  [ ▶/⏸ ]  [ ↺ ]       — record / play-pause / reset
  depth: ──────────────         — placement depth for new keyframes (0 = near, 1 = far)
  seek:  ──────────────         — scrub position [0, 1]
  rate:  ──────────────         — signed speed (negative reverses)
  mode:  [ once | loop | pingPong ]
  t: 0.412  kf: 3 / 3           — info readout
```

### Usage

```js
import { createTrackUI } from '@nakednous/ui'

// target is any PoseTrack-compatible object
const ui = createTrackUI(track, {
  x: 10, y: 10, width: 170,
  loop: false, rate: 1,
  seek: true, props: true, info: true,
  color: 'white'
})

// call every frame
ui.tick()
```

### Target contract (duck-typed)

| Member          | Required | Description                              |
| --------------- | -------- | ---------------------------------------- |
| `play(opts?)`   | ✓        | Start or update playback.                |
| `stop()`        | ✓        | Stop playback.                           |
| `seek(t)`       | ✓        | Set normalised position `[0, 1]`.        |
| `time()`        | ✓        | Returns normalised position `[0, 1]`.    |
| `playing`       | ✓        | Boolean — true while playing.            |
| `add(depth?)`   | optional | Add a keyframe. Enables the `+` button.  |
| `reset()`       | optional | Clear all keyframes. Enables `↺`.        |
| `info()`        | optional | Returns `{ keyframes, segments, time, … }`. |
| `onPlay`        | optional | Chained by the panel to sync button state. |
| `onEnd`         | optional | Chained by the panel to sync button state. |
| `onStop`        | optional | Chained by the panel to sync button state. |

### Transport semantics

- **▶/⏸** is the sole control that starts or stops playback.
- The **rate slider** adjusts speed while playing but never starts or stops. `rate = 0` freezes without stopping.
- The **seek slider** scrubs position without affecting the playing flag.
- The **mode select** changes loop/pingPong/once without starting playback.
- Hooks (`onPlay`, `onEnd`, `onStop`) are **chained**, not replaced — existing user callbacks are preserved.

### Options

| Option       | Default   | Description                                           |
| ------------ | --------- | ----------------------------------------------------- |
| `seek`       | `true`    | Show seek slider.                                     |
| `props`      | `true`    | Show rate slider + mode select.                       |
| `info`       | `false`   | Show time / keyframe readout.                         |
| `depth`      | `0.5`     | Initial add-pose depth `[0..1]` (near → far plane).   |
| `rate`       | `1`       | Initial rate.                                         |
| `loop`       | `false`   | Initial loop mode.                                    |
| `pingPong`   | `false`   | Initial pingPong mode (overrides loop).               |
| `x`, `y`     | `0`       | Container position (px).                              |
| `width`      | `120`     | Slider width (px).                                    |
| `color`      | —         | Text color.                                           |
| `hidden`     | `false`   | Start hidden.                                         |
| `parent`     | `document.body` | Mount target (`HTMLElement`).                   |

### Panel API

```js
ui.visible = false    // hide
ui.tick()             // sync seek, play button, and enabled state from target
ui.dispose()          // remove DOM, restore original hook chain
ui.parent(el)         // re-mount into a different HTMLElement
```

---

## CSS class names

All elements use `p5t-` prefixed class names for easy user overrides. No default visual styles are applied — structural CSS only (position, flex-direction, gap).

---

## Relationship to `p5.tree`

[p5.tree](https://github.com/VisualComputing/p5.tree) wraps both factories as `fn.createUI` and `fn.createTrackUI`, resolves the mount parent to the canvas container, and registers a persistent `tick()` player in the draw loop so panels stay in sync without any per-frame calls in user code. It also intercepts p5 shader targets in `createUI` — wrapping `setUniform` as a plain function — so `@nakednous/ui` stays renderer-agnostic.

---

## License

GPL-3.0-only  
© JP Charalambos
