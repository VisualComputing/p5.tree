'use strict';
  
const XY = true

function setup() {
  createCanvas(600, 400, WEBGL)
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
  //XY ? bullsEye( { x: 0.1, y: 0.1 } ) : bullsEye()
  pop()
  orbitControl()
}

function keyPressed () {
  if (key === 'l') {
    camera(800, 0, 0,   0, 0, 0,   0, 1, 0)
  }
  if (key === 'p') {
    console.log('eye position in world space: ', parsePosition())
  }
  if (key === 'd') {
    console.log('eye view direction in world space', parseDirection())
  }
}
