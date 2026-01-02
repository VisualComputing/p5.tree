'use strict';

let font;

async function setup() {
  font = await loadFont('/fonts/noto_sans.ttf');
  createCanvas(600, 400, WEBGL);
  textFont(font);
  textSize(14);
  console.log(p5.Tree.VERSION);
}

function draw() {
  background(20);
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
  translate(-width / 2, -height / 2);
  noStroke();
  fill(0, 160);
  rect(10, 10, 220, 56, 6);
  fill(255);
  text('HUD OK\norbitControl OK', 20, 30);
  pop();
  endHUD();
}
