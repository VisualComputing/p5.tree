'use strict'

let font

// reference cameras for quick import
let cam0, cam1, cam2

// toggles
let showAxes = true
let showGrid = true

// camera path UI state (we keep it ourselves; no _renderer access)
let pathLoop = true
let pathPlaying = false
let pathDuration = 45 // frames per segment
let pathRate = 1
let pathKeyframes = 0 // we update on add/reset; no introspection

// seek slider (DOM)
let sSeek

async function setup () {
  createCanvas(700, 450, WEBGL)
  font = await loadFont('/fonts/noto_sans.ttf')
  textFont(font)

  // three reference cameras (same projection)
  cam0 = createCamera()
  cam0.camera(0, 0, 600, 0, 0, 0, 0, 1, 0)

  cam1 = createCamera()
  cam1.camera(420, -200, 720, 0, 0, 0, 0, 1, 0)

  cam2 = createCamera()
  cam2.camera(-480, 250, 660, 0, 0, 0, 0, 1, 0)

  pathPlaying = false
  pathKeyframes = 0

  sSeek = createSlider(0, 1, 0, 0.001)
  sSeek.input(() => {
    stopPath()
    pathPlaying = false
    seekPath(sSeek.value())
  })
  sSeek.position(10, height - 25)
  sSeek.style('width', '280px')

  syncSeekUI()
}

function draw () {
  background(75)
  orbitControl()

  // keep slider synced to playback cursor (no drag tracking needed because scrubbing stops playback)
  if (pathKeyframes >= 2 && pathPlaying) {
    sSeek.value(pathTime())
  }

  // hints
  stroke(180, 90)
  showGrid && grid({ size: 500, subdivisions: 20 })
  showAxes && axes({ size: 220 })

  // --- Scene -------------------------------------------------

  noStroke()
  ambientLight(120)
  directionalLight(255, 255, 255, 0.25, 0.3, -1)

  push()
  normalMaterial()
  rotateY(frameCount * 0.01)
  rotateX(frameCount * 0.008)
  box(140)
  pop()

  push()
  translate(250, 0, 0)
  normalMaterial()
  sphere(70)
  pop()

  push()
  translate(-250, 0, 0)
  normalMaterial()
  torus(50, 30)
  pop()

  // --- HUD ---------------------------------------------------

  drawHud()
}

function drawHud () {
  const pad = 10
  const panelW = 300
  const x0 = pad
  const y0 = pad
  const lh = 16

  const lines = [
    'p5.tree keyframes stress test',
    '',
    'Hints',
    `  [G] grid: ${showGrid ? 'on' : 'off'}`,
    `  [X] axes: ${showAxes ? 'on' : 'off'}`,
    '',
    'Keyframes / Path',
    '  [A] add keyframe (addPath snapshot)',
    '  [I] import [cam0, cam1, cam2] (reset)',
    `  [P] play/stop   loop=${pathLoop ? 'on' : 'off'}   rate=${pathRate}`,
    '  [R] resetPath()',
    '  [L] toggle loop',
    '  [<] reverse rate',
    '  [>] forward rate',
    `  duration: ${pathDuration} f/seg`,
    `  keyframes: ${pathKeyframes}`,
    `  state: ${pathPlaying ? 'playing' : pathKeyframes === 1 ? 'single keyframe' : 'stopped'}`
  ]

  beginHUD()
  push()
  noStroke()
  fill(0, 180)
  rect(x0, y0, panelW, pad + lines.length * lh + pad, 8)
  fill(255)
  textSize(12)
  textAlign(LEFT, TOP)
  let y = y0 + pad
  for (let i = 0; i < lines.length; i++) {
    text(lines[i], x0 + pad, y)
    y += lh
  }
  pop()
  endHUD()
}

function syncSeekUI () {
  if (pathKeyframes < 2) {
    sSeek && sSeek.hide()
    return
  }
  sSeek && sSeek.show()
  sSeek.value(constrain(sSeek.value(), 0, 1))
}

function onPathChanged (opt = {}) {
  const { keepPose = true } = opt

  stopPath()
  pathPlaying = false

  if (!keepPose) {
    sSeek && sSeek.value(0)
    pathKeyframes >= 1 && seekPath(0)
  }

  syncSeekUI()
}

function keyPressed () {
  const k = key

  // hints
  if (k === 'g' || k === 'G') showGrid = !showGrid
  if (k === 'x' || k === 'X') showAxes = !showAxes

  // add keyframe snapshot (DO NOT seek to 0)
  if (k === 'a' || k === 'A') {
    addPath()
    pathKeyframes++
    if (pathKeyframes === 2) sSeek && sSeek.value(1)
    onPathChanged({ keepPose: true })
  }

  // import 3 reference cameras (reset) -> deterministic: seek to 0 and slider to 0
  if (k === 'i' || k === 'I') {
    addPath([cam0, cam1, cam2], { reset: true })
    pathKeyframes = 3
    sSeek && sSeek.value(0)
    onPathChanged({ keepPose: false })
  }

  // loop toggle
  if (k === 'l' || k === 'L') {
    pathLoop = !pathLoop
    if (pathPlaying) {
      playPath({
        duration: pathDuration,
        loop: pathLoop,
        rate: pathRate,
        onEnd: () => { pathPlaying = false; sSeek.value(pathTime()); }
      })
    }
  }
  
  // info
  if (k === 'n' || k === 'N') {
    console.log(pathInfo())
  }

  // forward/back rate quick toggle
  if (k === '>') {
    pathRate = 1
    if (pathPlaying) {
      playPath({
        duration: pathDuration,
        loop: pathLoop,
        rate: pathRate,
        onEnd: () => { pathPlaying = false; sSeek.value(pathTime()); }
      })
    }
  }

  if (k === '<') {
    pathRate = -1
    if (pathPlaying) {
      playPath({
        duration: pathDuration,
        loop: pathLoop,
        rate: pathRate,
        onEnd: () => { pathPlaying = false; sSeek.value(pathTime()); }
      })
    }
  }

  // play/stop
  if (k === 'p' || k === 'P') {
    if (pathKeyframes === 0) return false

    // 1 keyframe: snap to it; don't enter playing state
    if (pathKeyframes === 1) {
      stopPath()
      pathPlaying = false
      playPath({ duration: pathDuration, loop: false, rate: 1 })
      syncSeekUI()
      return false
    }

    if (!pathPlaying) {
      playPath({
        duration: pathDuration,
        loop: pathLoop,
        rate: pathRate,
        onEnd: () => { pathPlaying = false; sSeek.value(pathTime()); }
      })
      pathPlaying = true
    } else {
      stopPath()
      pathPlaying = false
    }
  }

  // reset path
  if (k === 'r' || k === 'R') {
    resetPath()
    pathKeyframes = 0
    sSeek && sSeek.value(0)
    onPathChanged({ keepPose: false })
  }

  return false
}

function mouseWheel () {
  return false
}
