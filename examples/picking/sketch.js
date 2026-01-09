'use strict'

let models = []
let squared, cached = true
let pv

function setup() {
  createCanvas(400, 400, WEBGL)
  // suppress right-click context menu
  document.oncontextmenu = () => false
  colorMode(RGB, 1)
  for (let i = 0; i < 20; i++) {
    models.push(
      {
        position: p5.Vector.random3D().mult(100),
        size: random() * 25 + 8,
        color: color(random(), random(), random())
      }
    )
  }
  frameRate(1000)
}

function keyPressed() {
  key === 's' && (squared = !squared)
  key === 'c' && (cached = !cached)
}

// /*
function draw() {
  background(0.5)
  orbitControl()
  // cache pv matrix to speedup computations
  const params = {
    shape: squared ? p5.Tree.SQUARE : p5.Tree.CIRCLE, ...(cached && { pvMatrix: pvMatrix() })
  }
  axes()
  grid()
  models.forEach(element => {
    push()
    translate(element.position)
    params.size = element.size * 2.5
    const picked = mousePicking(params)
    fill(picked ? 'white' : element.color)
    noStroke()
    squared ? box(element.size * 2) : sphere(element.size)
    pop()
  })
}
// */

/*
function draw() {
  background(0.5)
  orbitControl()
  // cache pv matrix to speedup computations
  const params = {
    shape: squared ? p5.Tree.SQUARE : p5.Tree.CIRCLE, ...(cached && { pvMatrix: pvMatrix() })
  }
  axes()
  grid()
  models.forEach(element => {
    push()
    translate(element.position)
    params.size = element.size * 2.5
    fill(element.color)
    noStroke()
    squared ? box(element.size * 2) : sphere(element.size)
    strokeWeight(3)
    stroke('magenta')
    squared ? cross(params) : bullsEye(params)
    pop()
  })
}
// */

/*
function draw() {
  background(0.5)
  orbitControl()
  // cache pv matrix to speedup computations
  const params = {
    shape: squared ? p5.Tree.SQUARE : p5.Tree.CIRCLE, ...(cached && { pvMatrix: pvMatrix() })
  }
  axes()
  grid()
  models.forEach(element => {
    push()
    translate(element.position)
    params.size = element.size * 2.5
    const picked = mousePicking(params)
    fill(picked ? 'white' : element.color)
    noStroke()
    squared ? box(element.size * 2) : sphere(element.size)
    strokeWeight(3)
    stroke(picked ? 'yellow' : cached ? 'blue' : 'red')
    squared ? cross(params) : bullsEye(params)
    pop()
  })
}
// */
