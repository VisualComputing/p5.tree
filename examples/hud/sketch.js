'use strict';

let font;

async function setup() {
  font = await loadFont('/fonts/noto_sans.ttf');
  createCanvas(600, 400, WEBGL);
  textFont(font);
  textSize(14);
  console.log(p5.Tree.VERSION);
  console.log('eye position in world space: ', transformPosition());
  console.log('eye view direction in world space', transformDirection());
}

function draw() {
  background(20);
  axes( { size: 300 } );
  push();
  stroke('white');
  grid({ size: 300, style: p5.Tree.SOLID });
  pop();
  orbitControl();
  ambientLight(120);
  directionalLight(255, 255, 255, 0.25, 0.3, -1);
  
  push();
  normalMaterial();
  rotateY(frameCount * 0.01);
  rotateX(frameCount * 0.008);
  box(140);
  pop();

  push();
  translate(250, 0, 0);
  normalMaterial();
  //box(140);
  //sphere(70);
  torus(70, 22);
  pop();

  // /*
  push();
  translate(-250, 0, 0);
  normalMaterial();
  box(140);
  //sphere(70);
  //torus(70, 22);
  pop();
  // */
  
  // HUD working here
  beginHUD();
  push();
  noStroke();
  fill(0, 160);
  rect(10, 10, 220, 56, 6);
  fill(255);
  text('HUD OK\norbitControl OK', 20, 30);
  pop();
  endHUD();
}

function keyPressed() {
  if (key === 'd') {
    console.log('eye view direction in world space', transformDirection());
  }
  if (key === 'p') {
    console.log('eye position in world space: ', transformPosition());
  }
}
