'use strict';
  
let XY = false
let p5v1

function setup() {
  createCanvas(600, 400, WEBGL)
  console.log(p5.VERSION)
  p5v1 = p5.VERSION[0] == 1
}

function draw() {
  background(20)
  axes( { size: 300 } )
  push()
  stroke('green')
  //grid({ style: p5.Tree.SOLID })
  grid()
  pop()
  push()
  stroke('yellow')
  XY ? bullsEye( { x: 0, y: 0 } ) : bullsEye()
  pop()
  orbitControl()
}

function keyPressed () {
  if (key === 'l') {
    camera(800, 800, 800,   0, 0, 0,   0, 1, 0)
  }
  if (key === 'p') {
    console.log('eye position in world space: ', p5v1 ? parsePosition() : transformPosition())
  }
  if (key === 'd') {
    console.log('eye view direction in world space', p5v1 ? parseDirection() : transformDirection())
  }
  if (key === 'n') {
    console.log(pvMatrix())
    //console.log(nMatrix())
  }
  if (key === 'x') {
    XY = !XY
  }
}
