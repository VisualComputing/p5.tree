# `@nakednous/ui`

Parameter binding panels and animation transport controls — **zero dependencies**, pure vanilla DOM.

---

## Installation

```bash
npm install @nakednous/ui
```

```js
import { createPanel } from '@nakednous/ui'
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

## `createPanel`

The single public export. Dispatches on the first argument:

```js
// track (has .play) → transport panel
createPanel(track, opt)

// plain schema object → parameter binding panel
createPanel(schema, opt)
```

The duck-type check is `typeof first?.play === 'function'`. Schema objects are plain config bags — none will ever have `.play`.

---

## Parameter binding panel

Binds named schema keys to DOM controls. Each binding maps a parameter name to a control, and the control to a target sink.

```js
import { createPanel } from '@nakednous/ui'

const panel = createPanel({
  speed:     { min: 0, max: 0.05, value: 0.012, step: 0.001 },
  shininess: { min: 1, max: 200,  value: 80,    step: 1,    type: 'int' },
  showGrid:  { value: true },
  tint:      { value: '#ff8844' },
  fxOrder:   { type: 'select', options: [
                 { label: 'noise → dof', value: '1' },
                 { label: 'dof → noise', value: '2' }
               ], value: '1' }
}, { x: 10, y: 10, width: 160, labels: true, title: 'Scene', color: 'white' })

// call every frame
panel.tick()
```

### Type inference

| Schema value       | Control          |
|--------------------|------------------|
| `number`           | slider           |
| `boolean`          | checkbox         |
| CSS color string   | color picker     |
| array length 2–4   | vec2/3/4 sliders |
| `options` array    | dropdown         |
| `onClick` function | button           |

Override with `{ type: 'int', ... }`.

### Target

```js
// plain function — called (name, value) each tick for dirty bindings
createPanel(schema, { target: (name, value) => myObj[name] = value })

// object with .set
createPanel(schema, { target: myObject })   // myObject.set(name, value)

// omitted — read manually
panel.speed.value()
panel.speed.set(0.02)
panel.speed.reset()
panel.speed.visible = false
```

**Avoid direct DOM access.** Attaching listeners to internal elements (`ui.on.el.firstChild.addEventListener(...)`) couples your code to the panel's internal structure. Use `target` instead:

```js
// fragile — do not use
ui.on.el.firstChild.addEventListener('change', () => { showGrid = ui.on.value() })

// correct
createPanel({ on: { value: true } }, {
  target: (name, value) => { showGrid = value }
})

// target can also call any function and ignore its arguments
createPanel({ on: { value: false } }, {
  target: () => syncFxPanels()
})
```

### Tick model

`tick()` pushes dirty bindings to target at most once per binding per frame. The first tick always pushes all bindings to initialise target state. Multiple interactions within a single frame collapse to one push at `tick()` time — correct for rendering sinks (shaders, scene params).

### Per-binding API

```js
panel.speed.value()       // current value
panel.speed.set(0.02)     // set programmatically — marks dirty, pushed on next tick
panel.speed.reset()       // restore initial value — marks dirty
panel.speed.visible = false
panel.speed.el            // raw HTMLElement(s)
```

### Panel API

```js
panel.el             // HTMLElement container
panel.visible        // get/set boolean — whole panel
panel.collapsed      // get/set boolean — body visibility (requires collapsible + title)
panel.each(fn)       // iterate bindings: fn(name, binding)
panel.elts()         // flat array of all bound DOM elements
panel.reset()        // reset all bindings
panel.parent(el)     // re-mount into a new HTMLElement
panel.tick()         // push dirty bindings — call once per frame
panel.dispose()      // remove from DOM
```

### Layout options

| Option        | Default         | Description                              |
|---------------|-----------------|------------------------------------------|
| `target`      | —               | Value sink: `(name,val)=>...` or `{set}`. |
| `x`           | `0`             | Container left (px).                     |
| `y`           | `0`             | Container top (px).                      |
| `width`       | `120`           | Default slider/select width (px).        |
| `offset`      | `6`             | Vertical gap between rows (px).          |
| `labels`      | `false`         | Show per-binding labels.                 |
| `title`       | —               | Bold title row.                          |
| `collapsible` | `false`         | Title row becomes a collapse toggle.     |
| `collapsed`   | `false`         | Start collapsed (implies collapsible).   |
| `color`       | —               | Container text color.                    |
| `hidden`      | `false`         | Start hidden.                            |
| `parent`      | `document.body` | Mount target (`HTMLElement`).            |

---

## Transport panel

Controls playback of any track-compatible target. Duck-typed: the target needs `play`, `stop`, `seek`, `time`, and `playing`.

```js
import { createPanel } from '@nakednous/ui'

const ui = createPanel(track, {
  x: 10, y: 10, width: 170,
  loop: false, rate: 1,
  seek: true, props: true, info: true,
  color: 'white'
})

// call every frame
ui.tick()
```

### Target contract

| Member        | Required | Description                               |
|---------------|----------|-------------------------------------------|
| `play(opts?)` | ✓        | Start or update playback.                 |
| `stop()`      | ✓        | Stop playback.                            |
| `seek(t)`     | ✓        | Set normalised position `[0, 1]`.         |
| `time()`      | ✓        | Returns normalised position `[0, 1]`.     |
| `playing`     | ✓        | Boolean — true while playing.             |
| `loop`        | ✓        | Boolean — read at panel creation time.    |
| `bounce`      | ✓        | Boolean — read at panel creation time.    |
| `rate`        | ✓        | Number — read at panel creation time.     |
| `_onPlay`     | ✓        | Lib-space hook — assigned by this panel.  |
| `_onEnd`      | ✓        | Lib-space hook — assigned by this panel.  |
| `_onStop`     | ✓        | Lib-space hook — assigned by this panel.  |
| `add(depth?)` | optional | Add a keyframe. Enables the `+` button.   |
| `reset()`     | optional | Clear all keyframes. Enables `↺`.         |
| `info()`      | optional | Returns `{ keyframes, segments, ... }`.   |

### Transport model

The Play/Pause button is the **sole** control that starts or stops playback. The rate slider adjusts speed without starting or stopping. The seek slider scrubs position without affecting `playing`. The loop and bounce checkboxes change looping behaviour without starting playback.

**Loop modes** — `loop` and `bounce` are fully independent:

| loop | bounce | behaviour |
|------|--------|-----------|
| ☐    | ☐      | play once — stop at end |
| ☑    | ☐      | repeat — wrap back to start |
| ☑    | ☑      | bounce forever at boundaries |
| ☐    | ☑      | bounce once — flip at far boundary, stop at origin |

Both checkboxes are always visible and independent of each other.

### State initialisation

`rate` is seeded once at creation from the live track state (falling back to `opt.rate`) and is fully UI-owned thereafter — the panel never reads rate back from the track. `loop` and `bounce` are seeded the same way and additionally polled from the track every `tick()` while playing, so external `play()` calls are always reflected:

```js
// play before createPanel — panel opens with correct state
track.play({ loop: true })
createPanel(track, ...)      // loop checkbox checked ✓

// createPanel before play — polled on next tick while playing
createPanel(track, ...)
track.play({ bounce: true }) // bounce checkbox checked ✓
```

### Layout (top → bottom)

```
  Title row  — optional, becomes collapse toggle when collapsible=true
  [ + ]  [ ▶/⏸ ]  [ ↺ ]        — add / play-pause / reset
  depth: ──────────────        — placement depth (0 = near, 1 = far)
  seek:  ──────────────        — scrub position [0, 1]
  rate:  ──────────────        — signed speed (negative reverses)
  loop: [ ☐ ]  bounce: [ ☐ ]   — independent checkboxes, always visible
  t: 0.412  seg 1/3  kf 4      — info readout
```

### Transport options

| Option        | Default         | Description                                                          |
|---------------|-----------------|----------------------------------------------------------------------|
| `seek`        | `true`          | Show seek slider.                                                    |
| `props`       | `true`          | Show rate slider + loop controls.                                    |
| `info`        | `false`         | Show time/keyframe readout.                                          |
| `play`        | `true`          | Show play/stop button. `false` suppresses it.                        |
| `rate`        | `target.rate`   | Initial rate (seeded once; UI-owned after creation).                 |
| `loop`        | `target.loop`   | Initial loop state (seeded from live track; polled while playing).   |
| `bounce`      | `target.bounce` | Initial bounce state (seeded from live track; polled while playing). |
| `depth`       | `0.5`           | Initial add-pose depth [0..1].                                       |
| `title`       | —               | Optional title row.                                                  |
| `collapsible` | `false`         | Title row becomes a collapse toggle.                                 |
| `collapsed`   | `false`         | Start collapsed (implies collapsible).                               |
| `x`           | `0`             | Container left (px).                                                 |
| `y`           | `0`             | Container top (px).                                                  |
| `width`       | `120`           | Slider width (px).                                                   |
| `rateWidth`   | `width`         | Rate slider width override (px).                                     |
| `depthWidth`  | `width`         | Depth slider width override (px).                                    |
| `color`       | —               | Container text color.                                                |
| `hidden`      | `false`         | Start hidden.                                                        |
| `parent`      | `document.body` | Mount target (`HTMLElement`).                                        |

### Panel API

```js
ui.el              // HTMLElement container
ui.visible         // get/set boolean
ui.collapsed       // get/set boolean (requires collapsible + title)
ui.parent(el)      // re-mount into a new HTMLElement
ui.tick()          // sync seek slider, play button, enabled state — call every frame
ui.dispose()       // remove DOM and clear lib-space hooks
```

---

## Collapsible panels

Any panel with `title` set can be made collapsible. Clicking anywhere on the title row toggles the content area.

```js
// explicit
createPanel(schema, { title: 'Noise', collapsible: true })

// start collapsed — implies collapsible
createPanel(track, { title: 'Camera path', collapsed: true })
```

Programmatic control:

```js
panel.collapsed = true
panel.collapsed = false
```

---

## License

AGPL-3.0-only  
© JP Charalambos
