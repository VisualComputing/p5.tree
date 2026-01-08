'use strict';

let font;
let hud;

async function setup() {
  font = await loadFont('/fonts/noto_sans.ttf');
  createCanvas(600, 400, WEBGL);

  // 2D HUD buffer (text is reliable here)
  hud = createGraphics(width, height);
  hud.textFont(font);
  hud.textSize(14);
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
  sphere(70);
  pop();

  push();
  translate(-250, 0, 0);
  normalMaterial();
  torus(70, 22);
  pop();

  // --- HUD text into 2D buffer ---
  hud.clear();
  hud.noStroke();
  hud.fill(0, 160);
  hud.rect(10, 10, 220, 56, 6);
  hud.fill(255);
  hud.text('HUD OK\norbitControl OK', 20, 30);

  // --- HUD draw in screen space ---
  beginHUD();

  push();
  image(hud, 0, 0);
  pop();

  endHUD();
}
