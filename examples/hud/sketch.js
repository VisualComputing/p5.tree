'use strict';

let font;

async function setup() {
  font = await loadFont('/fonts/noto_sans.ttf');
  createCanvas(600, 400, WEBGL);
  textFont(font);
  textSize(14);
}

function draw() {
  background(20);

  orbitControl();

  ambientLight(120);
  directionalLight(255, 255, 255, 0.25, 0.3, -1);

  normalMaterial();
  box(140);

  // --- BROKEN HUD (direct text in WEBGL) ---
  beginHUD();

  push();
  //resetMatrix(); // works even commented!
  translate(-width / 2, -height / 2);

  noStroke();
  fill(0, 160);
  rect(10, 10, 220, 56, 6);

  fill(255);
  text('HUD OK\norbitControl OK', 20, 30); // <- text often invisible

  pop();

  endHUD();
}
