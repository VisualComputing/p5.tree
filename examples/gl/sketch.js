'use strict';

// decide p5.treegl vs p5.tree
const p5_tree = true;

function setup() {
  createCanvas(400, 300, WEBGL);
  console.log('p5 version:', p5.prototype.VERSION || p5.VERSION);
  console.log('Press L to log matrix queries (stress test).');
  const m = createMatrix(3);
  console.log(m);
}

function draw() {
  background(20);

  // Keep interaction if you want, but it will change view matrix.
  orbitControl();

  // Stress: apply model transform OUTSIDE push/pop so renderer state matrices are non-identity.
  translate(40, -20, 60);
  rotateX(0.3);
  rotateY(0.6);
  scale(1.2, 0.8, 1.1); // non-uniform scale => normal matrix should be nontrivial.

  box(80);
}

function keyPressed() {
  if (key === 'L') logMatrices();
}

function logMatrices() {
  console.log('--- MATRIX QUERY LOG START ---');

  // Core queries (wrappers)
  logQuery('mMatrix()', () => safeFn('mMatrix')());
  logQuery('vMatrix()', () => safeFn('vMatrix')());
  logQuery('pMatrix()', () => safeFn('pMatrix')());
  logQuery('pvMatrix()', () => safeFn('pvMatrix')());
  logQuery('eMatrix()', () => safeFn('eMatrix')());
  logQuery('nMatrix()', () => safeFn('nMatrix')());

  // More derived queries (exercise untested code paths)
  logQuery('mvMatrix()', () => safeFn('mvMatrix')());
  logQuery('pmvMatrix()', () => safeFn('pmvMatrix')());
  p5_tree
  ? logQuery('pviMatrix()', () => safeFn('pviMatrix')())
  : logQuery('pvInvMatrix()', () => safeFn('pvInvMatrix')());

  // Invariant checks via point transforms
  const mv = safeTry(() => safeFn('mvMatrix')());
  const pmv = safeTry(() => safeFn('pmvMatrix')());
  const pvi = p5_tree ? safeTry(() => safeFn('pviMatrix')()) : safeTry(() => safeFn('pvInvMatrix')());

  const v = safeTry(() => safeFn('vMatrix')());
  const p = safeTry(() => safeFn('pMatrix')());

  // multiplyPoint sanity if present (v, mv, pmv)
  if (v && typeof v.multiplyPoint === 'function') {
    const pt = safeTry(() => v.multiplyPoint({ x: 1, y: 2, z: 3 }));
    console.log('vMatrix().multiplyPoint({1,2,3}) →', pt ? roundVec(pt) : pt);
  }

  if (mv && typeof mv.multiplyPoint === 'function') {
    const pt = safeTry(() => mv.multiplyPoint({ x: 1, y: 2, z: 3 }));
    console.log('mvMatrix().multiplyPoint({1,2,3}) →', pt ? roundVec(pt) : pt);
  }

  if (pmv && typeof pmv.multiplyPoint === 'function') {
    const pt = safeTry(() => pmv.multiplyPoint({ x: 1, y: 2, z: 3 }));
    console.log('pmvMatrix().multiplyPoint({1,2,3}) →', pt ? roundVec(pt) : pt);
  }

  // PV inverse sanity: pvInv * pv should be identity (approximately)
  if (pvi && v && p && pvi.mat4 && v.mat4 && p.mat4) {
    const pv = safeTry(() => safeFn('pvMatrix')());
    if (pv) {
      const prod = safeTry(() => safeFn('axbMatrix')(pvi, pv));
      prod && prod.mat4 && console.log(p5_tree ? 'pviMatrix()*pvMatrix() →' : 'pvInvMatrix()*pvMatrix() →', roundArray(prod.mat4));
    }
  }

  // Also log tMatrix / iMatrix on non-identity MV / PV to ensure they behave.
  const vm = safeTry(() => safeFn('vMatrix')());
  if (vm) {
    logQuery('tMatrix(vMatrix())', () => safeFn('tMatrix')(vm));
    p5_tree ? 
    logQuery('iMatrix(vMatrix())', () => safeFn('iMatrix')(vm)) : 
    logQuery('invMatrix(vMatrix())', () => safeFn('invMatrix')(vm));
  }

  console.log('--- MATRIX QUERY LOG END ---');
}

/* -------------------------------------------------- */
/* helpers                                             */
/* -------------------------------------------------- */

function safeFn(name) {
  // Never reference an undeclared identifier: always go through globalThis.
  const fn = globalThis[name];
  return typeof fn === 'function' ? fn : () => undefined;
}

function safeTry(thunk) {
  try {
    return thunk();
  } catch (e) {
    console.log('ERROR:', e && e.message ? e.message : e);
    return null;
  }
}

function logQuery(label, thunk) {
  const out = safeTry(thunk);

  if (out && out.mat4) {
    console.log(label, '→', roundArray(out.mat4));
    return;
  }

  if (out && out.matrix && out.matrix.length === 9) {
    console.log(label, '→', roundArray(out.matrix));
    return;
  }

  console.log(label, '→', out);
}

function roundArray(a) {
  return Array.from(a).map(v => +(+v).toFixed(4));
}

function roundVec(v) {
  return { x: +v.x.toFixed(4), y: +v.y.toFixed(4), z: +v.z.toFixed(4) };
}
