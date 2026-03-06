# `@nakednous/ui`

Controls for **animations and shader parameters**.

`@nakednous/ui` provides lightweight DOM interfaces for interacting with animation tracks and shader uniforms.
It is **framework-agnostic**, has **no dependencies**, and can be used with any rendering engine or application.

---

## Installation

```bash
npm install @nakednous/ui
```

```javascript
import * as ui from '@nakednous/ui'
```

---

## Role

`@nakednous/ui` provides interactive control surfaces for runtime systems.

```text
application / renderer
        │
        ▼
 integration layer
   (e.g. p5.tree)
      │      │
      ▼      ▼
@nakednous/tree   @nakednous/ui
```

A host library exposes animation tracks or shader parameters.
`@nakednous/tree` performs the backend computations, while
`@nakednous/ui` provides the user-facing controls used to manipulate them.

---

## Capabilities

### Animation controls

Interfaces for interacting with animation tracks.

Typical controls include:

* play and stop
* seeking along the timeline
* rate adjustment
* playback modes (once, loop, ping-pong)

These controls commonly operate on animation tracks such as those provided by `@nakednous/tree`.

---

### Shader parameter controls

Interfaces for adjusting shader parameters interactively.

Typical controls include:

* numeric sliders
* toggles
* color selectors
* vector parameters

These allow real-time exploration and tuning of shader effects during development.

---

## Philosophy

The package focuses on **small control panels rather than full UI frameworks**.

Key principles:

* framework independence
* lightweight DOM usage
* schema-driven controls
* easy embedding into existing applications

The goal is to provide simple control surfaces that can connect to runtime systems without imposing a UI architecture.

---

## Use cases

Typical uses include:

* animation playback controls for transform tracks
* real-time shader parameter tuning
* debugging rendering pipelines
* interactive controls in graphics demos or tools

---

## How it works with `@nakednous/tree`

`@nakednous/tree` provides backend systems such as animation tracks and spatial queries.
`@nakednous/ui` provides interactive controls that can manipulate those systems during runtime.

Host libraries such as **p5.tree** combine the two:

* `@nakednous/tree` — backend logic
* `@nakednous/ui` — runtime controls
* integration layer — renderer-specific glue

This separation keeps animation logic, UI controls, and renderer integration independent.

---

## License

GPL-3.0-only
© JP Charalambos
