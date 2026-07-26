import {
  LM,
  lmValid,
  safeLM,
  landmarkToWorld,
  calculateScaleAndPosition,
  OneEuroFilter
} from '../../fittingMath.js';

console.log('=== STARTING ADVERSARIAL STRESS TEST HARNESS ===\n');

const testResults = [];

function runTestCase(category, name, testFn) {
  try {
    const result = testFn();
    testResults.push({
      category,
      name,
      status: result.passed ? 'PASS' : 'FAIL',
      details: result.details || '',
      error: null,
      output: result.output
    });
    console.log(`[${result.passed ? 'PASS' : 'FAIL'}] [${category}] ${name}: ${result.details || ''}`);
  } catch (err) {
    testResults.push({
      category,
      name,
      status: 'CRASH',
      details: `Uncaught Exception: ${err.message}`,
      error: err.stack,
      output: null
    });
    console.log(`[CRASH] [${category}] ${name}: Uncaught Exception: ${err.message}`);
  }
}

// Helper to build 478 mock landmarks
function makeMockArray(overrides = {}) {
  const arr = new Array(478);
  for (let i = 0; i < 478; i++) {
    arr[i] = { x: 0.5, y: 0.5, z: 0.0 };
  }
  arr[LM.L_TEMPLE]    = { x: 0.3, y: 0.5, z: 0.0 };
  arr[LM.R_TEMPLE]    = { x: 0.7, y: 0.5, z: 0.0 };
  arr[LM.NOSE_REST]   = { x: 0.5, y: 0.45, z: 0.0 };
  arr[LM.L_EYE_INNER] = { x: 0.4, y: 0.45, z: 0.0 };
  arr[LM.R_EYE_INNER] = { x: 0.6, y: 0.45, z: 0.0 };
  arr[LM.L_IRIS]      = { x: 0.4, y: 0.45, z: 0.0 };
  arr[LM.R_IRIS]      = { x: 0.6, y: 0.45, z: 0.0 };

  for (const [k, v] of Object.entries(overrides)) {
    const idx = Number.isInteger(Number(k)) ? Number(k) : LM[k];
    if (idx !== undefined && idx >= 0 && idx < 478) {
      arr[idx] = v;
    }
  }
  return arr;
}

// -------------------------------------------------------------
// 1. lmValid Tests
// -------------------------------------------------------------
runTestCase('lmValid', 'Null input', () => {
  const res = lmValid(null);
  return { passed: res === false, details: `Returned ${res}` };
});

runTestCase('lmValid', 'Undefined input', () => {
  const res = lmValid(undefined);
  return { passed: res === false, details: `Returned ${res}` };
});

runTestCase('lmValid', 'Empty object input', () => {
  const res = lmValid({});
  return { passed: res === false, details: `Returned ${res}` };
});

runTestCase('lmValid', 'Primitive number input', () => {
  const res = lmValid(123);
  return { passed: res === false, details: `Returned ${res}` };
});

runTestCase('lmValid', 'Primitive string input', () => {
  const res = lmValid("landmark");
  return { passed: res === false, details: `Returned ${res}` };
});

runTestCase('lmValid', 'Exact boundary [0, 0, 0]', () => {
  const res = lmValid({ x: 0, y: 0, z: 0 });
  return { passed: res === true, details: `Returned ${res}` };
});

runTestCase('lmValid', 'Exact boundary [1, 1, 0]', () => {
  const res = lmValid({ x: 1, y: 1, z: 0 });
  return { passed: res === true, details: `Returned ${res}` };
});

runTestCase('lmValid', 'Negative x (-0.0001)', () => {
  const res = lmValid({ x: -0.0001, y: 0.5, z: 0 });
  return { passed: res === false, details: `Returned ${res}` };
});

runTestCase('lmValid', 'Negative y (-0.0001)', () => {
  const res = lmValid({ x: 0.5, y: -0.0001, z: 0 });
  return { passed: res === false, details: `Returned ${res}` };
});

runTestCase('lmValid', 'Over 1 x (1.0001)', () => {
  const res = lmValid({ x: 1.0001, y: 0.5, z: 0 });
  return { passed: res === false, details: `Returned ${res}` };
});

runTestCase('lmValid', 'Over 1 y (1.0001)', () => {
  const res = lmValid({ x: 0.5, y: 1.0001, z: 0 });
  return { passed: res === false, details: `Returned ${res}` };
});

runTestCase('lmValid', 'Negative z (-100.5)', () => {
  const res = lmValid({ x: 0.5, y: 0.5, z: -100.5 });
  return { passed: res === true, details: `Returned ${res} (z is not restricted to 0..1)` };
});

runTestCase('lmValid', 'x = NaN', () => {
  const res = lmValid({ x: NaN, y: 0.5, z: 0 });
  return { passed: res === false, details: `Returned ${res}` };
});

runTestCase('lmValid', 'y = Infinity', () => {
  const res = lmValid({ x: 0.5, y: Infinity, z: 0 });
  return { passed: res === false, details: `Returned ${res}` };
});

runTestCase('lmValid', 'z = NaN', () => {
  const res = lmValid({ x: 0.5, y: 0.5, z: NaN });
  return { passed: res === false, details: `Returned ${res}` };
});

runTestCase('lmValid', 'z = Infinity', () => {
  const res = lmValid({ x: 0.5, y: 0.5, z: Infinity });
  return { passed: res === false, details: `Returned ${res}` };
});

runTestCase('lmValid', 'String coordinate values', () => {
  const res = lmValid({ x: "0.5", y: 0.5, z: 0 });
  return { passed: res === false, details: `Returned ${res}` };
});

// -------------------------------------------------------------
// 2. safeLM Tests
// -------------------------------------------------------------
runTestCase('safeLM', 'Null array', () => {
  const res = safeLM(null, 6);
  return { passed: res === null, details: `Returned ${res}` };
});

runTestCase('safeLM', 'Undefined array', () => {
  const res = safeLM(undefined, 6);
  return { passed: res === null, details: `Returned ${res}` };
});

runTestCase('safeLM', 'Empty array', () => {
  const res = safeLM([], 0);
  return { passed: res === null, details: `Returned ${res}` };
});

runTestCase('safeLM', 'Negative index (-1)', () => {
  const arr = makeMockArray();
  const res = safeLM(arr, -1);
  return { passed: res === null, details: `Returned ${res}` };
});

runTestCase('safeLM', 'Out of bounds index (9999)', () => {
  const arr = makeMockArray();
  const res = safeLM(arr, 9999);
  return { passed: res === null, details: `Returned ${res}` };
});

runTestCase('safeLM', 'Float index (2.5)', () => {
  const arr = makeMockArray();
  const res = safeLM(arr, 2.5);
  return { passed: res === null, details: `Returned ${res}` };
});

runTestCase('safeLM', 'NaN index', () => {
  const arr = makeMockArray();
  const res = safeLM(arr, NaN);
  return { passed: res === null, details: `Returned ${res}` };
});

runTestCase('safeLM', 'Infinity index', () => {
  const arr = makeMockArray();
  const res = safeLM(arr, Infinity);
  return { passed: res === null, details: `Returned ${res}` };
});

runTestCase('safeLM', 'Array with null element at index', () => {
  const arr = makeMockArray({ 6: null });
  const res = safeLM(arr, 6);
  return { passed: res === null, details: `Returned ${res}` };
});

runTestCase('safeLM', 'Array with NaN element at index', () => {
  const arr = makeMockArray({ 6: { x: NaN, y: 0.5, z: 0 } });
  const res = safeLM(arr, 6);
  return { passed: res === null, details: `Returned ${res}` };
});

// -------------------------------------------------------------
// 3. landmarkToWorld Tests
// -------------------------------------------------------------
runTestCase('landmarkToWorld', 'Invalid landmark input (null)', () => {
  const res = landmarkToWorld(null);
  const ok = res && res.x === 0 && res.y === 0 && res.z === 0.05 && typeof res.distanceTo === 'function';
  return { passed: ok, details: `Returned fallback object x=${res?.x}, y=${res?.y}, z=${res?.z}`, output: res };
});

runTestCase('landmarkToWorld', 'Invalid landmark with zOverride', () => {
  const res = landmarkToWorld({ x: -1, y: 0, z: 0 }, {}, 0.999);
  const ok = res && res.z === 0.999;
  return { passed: ok, details: `zOverride applied correctly on fallback: z=${res?.z}` };
});

runTestCase('landmarkToWorld', 'zOverride as second numeric argument (legacy signature)', () => {
  const lm = { x: 0.5, y: 0.5, z: 0.0 };
  const res = landmarkToWorld(lm, 0.42);
  const ok = res && res.z === 0.42;
  return { passed: ok, details: `Second numeric parameter handled as zOverride: z=${res?.z}` };
});

runTestCase('landmarkToWorld', 'Null viewportOptions parameter', () => {
  const lm = { x: 0.5, y: 0.5, z: 0.0 };
  const res = landmarkToWorld(lm, null);
  const ok = res && typeof res.x === 'number';
  return { passed: ok, details: `Handled null viewportOptions: x=${res?.x}` };
});

runTestCase('landmarkToWorld', 'Undefined viewportOptions parameter', () => {
  const lm = { x: 0.5, y: 0.5, z: 0.0 };
  const res = landmarkToWorld(lm, undefined);
  const ok = res && typeof res.x === 'number';
  return { passed: ok, details: `Handled undefined viewportOptions` };
});

runTestCase('landmarkToWorld', 'Zero width and height viewportOptions', () => {
  const lm = { x: 0.5, y: 0.5, z: 0.0 };
  const res = landmarkToWorld(lm, { width: 0, height: 0 });
  const ok = res && Number.isFinite(res.x) && Number.isFinite(res.y);
  return { passed: ok, details: `Result: x=${res?.x}, y=${res?.y}` };
});

runTestCase('landmarkToWorld', 'NaN viewport width', () => {
  const lm = { x: 0.5, y: 0.5, z: 0.0 };
  const res = landmarkToWorld(lm, { width: NaN, height: 720 });
  const ok = res && Number.isFinite(res.x) && Number.isFinite(res.y);
  return { passed: ok, details: `Result: x=${res?.x}, y=${res?.y}` };
});

runTestCase('landmarkToWorld', 'distanceTo method with null target', () => {
  const lm = { x: 0.5, y: 0.5, z: 0.0 };
  const w = landmarkToWorld(lm);
  const dist = w.distanceTo(null);
  return { passed: dist === 0, details: `distanceTo(null) returned ${dist}` };
});

runTestCase('landmarkToWorld', 'distanceTo method with undefined target', () => {
  const lm = { x: 0.5, y: 0.5, z: 0.0 };
  const w = landmarkToWorld(lm);
  const dist = w.distanceTo(undefined);
  return { passed: dist === 0, details: `distanceTo(undefined) returned ${dist}` };
});

runTestCase('landmarkToWorld', 'distanceTo method with empty object', () => {
  const lm = { x: 0.5, y: 0.5, z: 0.0 };
  const w = landmarkToWorld(lm);
  const dist = w.distanceTo({});
  return { passed: Number.isFinite(dist), details: `distanceTo({}) returned ${dist}` };
});

// -------------------------------------------------------------
// 4. calculateScaleAndPosition Tests
// -------------------------------------------------------------
runTestCase('calculateScaleAndPosition', 'Null lmArray input', () => {
  const res = calculateScaleAndPosition(null);
  return { passed: res === null, details: `Returned ${res}` };
});

runTestCase('calculateScaleAndPosition', 'Empty lmArray []', () => {
  const res = calculateScaleAndPosition([]);
  return { passed: res === null, details: `Returned ${res}` };
});

runTestCase('calculateScaleAndPosition', 'Truncated lmArray (length 100)', () => {
  const arr = new Array(100).fill({ x: 0.5, y: 0.5, z: 0 });
  const res = calculateScaleAndPosition(arr);
  return { passed: res === null, details: `Returned ${res} (missing temples at 234/454)` };
});

runTestCase('calculateScaleAndPosition', 'Missing NOSE_REST (landmark 6 invalid)', () => {
  const arr = makeMockArray({ 6: { x: -1, y: 0, z: 0 } });
  const res = calculateScaleAndPosition(arr);
  return { passed: res === null, details: `Returned ${res}` };
});

runTestCase('calculateScaleAndPosition', 'Missing left temple (landmark 234 invalid)', () => {
  const arr = makeMockArray({ 234: null });
  const res = calculateScaleAndPosition(arr);
  return { passed: res === null, details: `Returned ${res}` };
});

runTestCase('calculateScaleAndPosition', 'Zero temple width (L_TEMPLE == R_TEMPLE)', () => {
  const arr = makeMockArray({
    234: { x: 0.5, y: 0.5, z: 0.0 },
    454: { x: 0.5, y: 0.5, z: 0.0 }
  });
  const res = calculateScaleAndPosition(arr);
  const ok = res && res.scale === 0.01 && res.templeW === 0 && Number.isFinite(res.position.z);
  return { passed: ok, details: `scale=${res?.scale}, templeW=${res?.templeW}, posZ=${res?.position?.z}`, output: res };
});

runTestCase('calculateScaleAndPosition', 'lmArray without iris landmarks (< 478 landmarks)', () => {
  const arr = makeMockArray().slice(0, 460); // has temples (234, 454) and eye inner (133, 362) and nose (6)
  const res = calculateScaleAndPosition(arr);
  const ok = res !== null && typeof res.scale === 'number';
  return { passed: ok, details: `Fallback to inner eye succeeded: scale=${res?.scale}` };
});

runTestCase('calculateScaleAndPosition', 'Null viewportOptions parameter', () => {
  const arr = makeMockArray();
  const res = calculateScaleAndPosition(arr, null);
  const ok = res !== null && Number.isFinite(res.scale);
  return { passed: ok, details: `Handled null viewportOptions: scale=${res?.scale}` };
});

runTestCase('calculateScaleAndPosition', 'Null filterState parameter', () => {
  const arr = makeMockArray();
  const res = calculateScaleAndPosition(arr, {}, null);
  const ok = res !== null && Number.isFinite(res.scale);
  return { passed: ok, details: `Handled null filterState: scale=${res?.scale}` };
});

runTestCase('calculateScaleAndPosition', 'Filter returning NaN for scale', () => {
  const arr = makeMockArray();
  const filterState = {
    scaleFilter: { filter: () => NaN }
  };
  const res = calculateScaleAndPosition(arr, {}, filterState);
  const ok = res !== null && Number.isFinite(res.scale);
  return { passed: ok, details: `scale=${res?.scale}` };
});

runTestCase('calculateScaleAndPosition', 'Filter returning Infinity for position', () => {
  const arr = makeMockArray();
  const filterState = {
    posFilters: { x: { filter: () => Infinity } }
  };
  const res = calculateScaleAndPosition(arr, {}, filterState);
  const ok = res !== null && Number.isFinite(res.position.x);
  return { passed: ok, details: `position.x=${res?.position?.x}` };
});

// -------------------------------------------------------------
// 5. OneEuroFilter Tests
// -------------------------------------------------------------
runTestCase('OneEuroFilter', 'Filtering NaN value', () => {
  const filter = new OneEuroFilter();
  const val = filter.filter(NaN, 100);
  return { passed: Number.isFinite(val) || Number.isNaN(val), details: `Returned ${val}` };
});

runTestCase('OneEuroFilter', 'Filtering Infinity value', () => {
  const filter = new OneEuroFilter();
  const val = filter.filter(Infinity, 100);
  return { passed: Number.isFinite(val) || val === Infinity, details: `Returned ${val}` };
});

runTestCase('OneEuroFilter', 'Duplicate timestamp (dt = 0)', () => {
  const filter = new OneEuroFilter();
  filter.filter(10, 100);
  const val = filter.filter(20, 100);
  return { passed: Number.isFinite(val), details: `Returned ${val}` };
});

runTestCase('OneEuroFilter', 'Backward timestamp (dt < 0)', () => {
  const filter = new OneEuroFilter();
  filter.filter(10, 100);
  const val = filter.filter(20, 50);
  return { passed: Number.isFinite(val), details: `Returned ${val}` };
});

runTestCase('OneEuroFilter', 'Undefined timestamp', () => {
  const filter = new OneEuroFilter();
  filter.filter(10, undefined);
  const val = filter.filter(20, undefined);
  return { passed: Number.isFinite(val), details: `Returned ${val}` };
});

console.log('\n=== ADVERSARIAL STRESS TEST COMPLETED ===\n');

// Summary table
const total = testResults.length;
const passed = testResults.filter(r => r.status === 'PASS').length;
const failed = testResults.filter(r => r.status === 'FAIL').length;
const crashed = testResults.filter(r => r.status === 'CRASH').length;

console.log(`SUMMARY: Total=${total}, Passed=${passed}, Failed=${failed}, Crashed=${crashed}`);
