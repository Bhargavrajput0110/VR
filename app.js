/**
 * LUCEANDOMBRA — Virtual Try-On  |  app.js  v12
 *
 * Lenskart-level features:
 *  - Real 3D GLB frames from Poly Pizza (CC-BY)
 *  - MediaPipe 468-point face landmarks (PRECISION TRACKING v12)
 *  - One Euro Filter — eliminates jitter without adding lag
 *  - Adaptive LERP — fast when moving, smooth when still
 *  - Multi-point anchor (eye midpoint + nose bridge weighted)
 *  - 3-measurement scale averaging (IPD + temple + eye-width)
 *  - Instant snap on first face detection (no slide-in drift)
 *  - Landmark validation (NaN/out-of-range guard)
 *  - Higher MediaPipe confidence thresholds
 *  - AI face shape detection with 60-frame buffer
 *  - Photo capture, color swatches, category tabs
 *  - Premium Luceandombra branding
 */

import * as THREE from 'three';
import { GLTFLoader }           from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader }          from 'three/addons/loaders/DRACOLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { RoomEnvironment }      from 'three/addons/environments/RoomEnvironment.js';
import { FaceLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const GLASSES_Z_OFFSET  = 0.05;

// Adaptive LERP — blends between min (stable/still) and max (responsive/moving)
const LERP_POS_MIN      = 0.12;   // very smooth when still
const LERP_POS_MAX      = 0.70;   // fast response when moving quickly
const LERP_ROT_MIN      = 0.10;
const LERP_ROT_MAX      = 0.60;
const LERP_SCALE_MIN    = 0.10;
const LERP_SCALE_MAX    = 0.55;
const LERP_VEL_SCALE    = 6.0;    // how fast adaptive factor ramps up

const FACE_LOST_MS      = 1500;
const DEBUG_KEY         = 'd';
const IDB_DB_NAME       = 'lo_glb_cache_v12';
const IDB_STORE_NAME    = 'glbs';
const IDB_VERSION       = 12;

// ─────────────────────────────────────────────────────────────────────────────
// EXTENDED LANDMARK MAP  (MediaPipe 468-point canonical indices)
// ─────────────────────────────────────────────────────────────────────────────
const LM = {
  // Core eye anchors
  L_EYE_INNER:   133,   // left  inner canthus
  R_EYE_INNER:   362,   // right inner canthus
  L_EYE_OUTER:    33,   // left  outer canthus
  R_EYE_OUTER:   263,   // right outer canthus
  L_EYE_TOP:     159,   // left  upper eyelid mid
  R_EYE_TOP:     386,   // right upper eyelid mid
  L_EYE_BOT:     145,   // left  lower eyelid mid
  R_EYE_BOT:     374,   // right lower eyelid mid

  // Nose
  NOSE_BRIDGE:   168,   // glabella / nose bridge top
  NOSE_TIP:        4,   // tip of nose
  NOSE_L:        129,   // left  nose wing
  NOSE_R:        358,   // right nose wing

  // Face contour
  L_TEMPLE:      234,   // left  temple
  R_TEMPLE:      454,   // right temple
  FOREHEAD:       10,   // mid forehead
  CHIN:          152,   // chin tip
  JAW_L:         172,   // lower jaw left
  JAW_R:         397,   // lower jaw right
  CHEEK_L:       234,   // cheekbone left (same as temple for width)
  CHEEK_R:       454,   // cheekbone right

  // Mouth
  L_MOUTH:        61,
  R_MOUTH:       291,
};

// ─────────────────────────────────────────────────────────────────────────────
// ONE EURO FILTER  — removes jitter without introducing lag
// Reference: Géry Casiez et al., "1€ Filter" CHI 2012
// ─────────────────────────────────────────────────────────────────────────────
class OneEuroFilter {
  /**
   * @param {number} freq      Estimated signal frequency (Hz)
   * @param {number} minCutoff Minimum cutoff frequency — higher = less jitter but more lag
   * @param {number} beta      Speed coefficient — higher = faster response when moving
   * @param {number} dCutoff   Derivative cutoff frequency
   */
  constructor(freq = 30, minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.freq      = freq;
    this.minCutoff = minCutoff;
    this.beta      = beta;
    this.dCutoff   = dCutoff;
    this._x        = null;   // filtered value
    this._dx       = 0;      // filtered derivative
    this._lastTime = null;
  }

  _alpha(cutoff) {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    const te  = 1.0 / this.freq;
    return 1.0 / (1.0 + tau / te);
  }

  filter(x, timestamp) {
    if (this._lastTime !== null && timestamp !== undefined) {
      const dt = (timestamp - this._lastTime) / 1000;
      if (dt > 0) this.freq = 1.0 / dt;
    }
    this._lastTime = timestamp;

    if (this._x === null) {
      this._x  = x;
      this._dx = 0;
      return x;
    }

    // Derivative low-pass
    const rawDx   = (x - this._x) * this.freq;
    const alphaDx = this._alpha(this.dCutoff);
    this._dx      = alphaDx * rawDx + (1 - alphaDx) * this._dx;

    // Adaptive cutoff based on speed
    const cutoff  = this.minCutoff + this.beta * Math.abs(this._dx);
    const alpha   = this._alpha(cutoff);
    this._x       = alpha * x + (1 - alpha) * this._x;
    return this._x;
  }

  reset() { this._x = null; this._dx = 0; this._lastTime = null; }
}

// One Euro filters for each DOF (X, Y, Z position + scale)
// minCutoff=1.2 → good jitter elimination; beta=0.008 → fast response
const OEF = {
  x:     new OneEuroFilter(30, 1.2, 0.008, 1.0),
  y:     new OneEuroFilter(30, 1.2, 0.008, 1.0),
  z:     new OneEuroFilter(30, 0.8, 0.004, 1.0),
  scale: new OneEuroFilter(30, 0.8, 0.004, 1.0),
  // Rotation (Euler angles separately)
  rx:    new OneEuroFilter(30, 1.5, 0.010, 1.0),
  ry:    new OneEuroFilter(30, 1.5, 0.010, 1.0),
  rz:    new OneEuroFilter(30, 1.5, 0.010, 1.0),
};

function resetAllFilters() {
  Object.values(OEF).forEach(f => f.reset());
}

// ─────────────────────────────────────────────────────────────────────────────
// GLASSES CATALOG — Real 3D GLB models from Poly Pizza (CC-BY license)
// Attribution: Poly by Google, Jeremy, iPoly3D, J-Toastie via poly.pizza
// ─────────────────────────────────────────────────────────────────────────────
const GLASSES_CATALOG = [
  {
    id:       'aviator',
    file:     'models/aviator.glb',
    brand:    'Luceandombra',
    name:     'Classic Aviator',
    price:    '₹ 1,999',
    stars:    '★★★★★',
    reviews:  '(4,112)',
    category: 'sunglasses',
    faceShapes: ['oval', 'heart', 'oblong'],
    swatches: [
      { label: 'Gold',   color: '#d4af37', tint: 0xd4af37 },
      { label: 'Silver', color: '#c0c0c0', tint: 0xc0c0c0 },
      { label: 'Rose',   color: '#b76e79', tint: 0xb76e79 },
    ],
    scale: 1.0,
    yOffset: 0,
  },
  {
    id:       'round',
    file:     'models/round.glb',
    brand:    'Luceandombra',
    name:     'Round Classic',
    price:    '₹ 1,299',
    stars:    '★★★★☆',
    reviews:  '(987)',
    category: 'eyeglasses',
    faceShapes: ['square', 'oblong', 'heart'],
    swatches: [
      { label: 'Black',  color: '#1a1a1a', tint: 0x111111 },
      { label: 'Brown',  color: '#7B3F00', tint: 0x7B3F00 },
      { label: 'Blue',   color: '#2c4a7c', tint: 0x2c4a7c },
    ],
    scale: 1.0,
    yOffset: 0,
  },
  {
    id:       'sunglasses',
    file:     'models/sunglasses.glb',
    brand:    'Luceandombra Air',
    name:     'Sport Shield',
    price:    '₹ 2,499',
    stars:    '★★★★★',
    reviews:  '(2,341)',
    category: 'sunglasses',
    faceShapes: ['oval', 'round', 'square'],
    swatches: [
      { label: 'Black',  color: '#1a1a1a', tint: 0x111111 },
      { label: 'Mirror', color: '#8fb4d6', tint: 0x8fb4d6 },
      { label: 'Orange', color: '#d4691e', tint: 0xd4691e },
    ],
    scale: 1.0,
    yOffset: 0,
  },
  {
    id:       'wayfarer',
    file:     'models/wayfarer.glb',
    brand:    'Vincent Chase',
    name:     'Wayfarer Bold',
    price:    '₹ 1,499',
    stars:    '★★★★☆',
    reviews:  '(3,560)',
    category: 'eyeglasses',
    faceShapes: ['oval', 'heart', 'oblong'],
    swatches: [
      { label: 'Black',  color: '#1a1a1a', tint: 0x111111 },
      { label: 'Tortoise',color:'#8B4513', tint: 0x8B4513 },
      { label: 'Navy',   color: '#1a2a4a', tint: 0x1a2a4a },
    ],
    scale: 1.0,
    yOffset: 0,
  },
  {
    id:       'clubmaster',
    file:     'models/clubmaster.glb',
    brand:    'John Jacobs',
    name:     'Browline Premium',
    price:    '₹ 2,999',
    stars:    '★★★★★',
    reviews:  '(1,892)',
    category: 'eyeglasses',
    faceShapes: ['oval', 'round', 'heart'],
    swatches: [
      { label: 'Black-Gold', color: '#2a1a0a', tint: 0x2a1a0a },
      { label: 'Havana',     color: '#5C3317', tint: 0x5C3317 },
      { label: 'Silver',     color: '#c0c0c0', tint: 0xc0c0c0 },
    ],
    scale: 1.0,
    yOffset: 0,
  },
  {
    id:       'wayfarer2',
    file:     'models/wayfarer2.glb',
    brand:    'Luceandombra Air',
    name:     'Wayfarer Sport',
    price:    '₹ 1,799',
    stars:    '★★★★☆',
    reviews:  '(1,230)',
    category: 'sunglasses',
    faceShapes: ['oval', 'square'],
    swatches: [
      { label: 'Matte Black', color: '#222222', tint: 0x222222 },
      { label: 'Army',        color: '#4a5a3a', tint: 0x4a5a3a },
    ],
    scale: 1.0,
    yOffset: 0,
  },
  {
    id:       'retro',
    file:     'models/retro.glb',
    brand:    'Vincent Chase',
    name:     'Retro Square',
    price:    '₹ 1,199',
    stars:    '★★★★☆',
    reviews:  '(760)',
    category: 'eyeglasses',
    faceShapes: ['oval', 'heart'],
    swatches: [
      { label: 'Crystal',  color: '#e8e0d0', tint: 0xe8e0d0 },
      { label: 'Pink',     color: '#e07080', tint: 0xe07080 },
      { label: 'Black',    color: '#1a1a1a', tint: 0x111111 },
    ],
    scale: 1.0,
    yOffset: 0,
  },
  {
    id:       'square',
    file:     'models/square.glb',
    brand:    'John Jacobs',
    name:     'Square Edge',
    price:    '₹ 1,699',
    stars:    '★★★★☆',
    reviews:  '(543)',
    category: 'eyeglasses',
    faceShapes: ['oval', 'heart', 'round'],
    swatches: [
      { label: 'Black',  color: '#1a1a1a', tint: 0x111111 },
      { label: 'Gold',   color: '#d4af37', tint: 0xd4af37 },
    ],
    scale: 1.0,
    yOffset: 0,
  },
  {
    id:       'oval',
    file:     'models/oval.glb',
    brand:    'Luceandombra',
    name:     'Oval Slim',
    price:    '₹ 1,099',
    stars:    '★★★★☆',
    reviews:  '(411)',
    category: 'eyeglasses',
    faceShapes: ['square', 'oblong'],
    swatches: [
      { label: 'Rose Gold', color: '#b76e79', tint: 0xb76e79 },
      { label: 'Silver',    color: '#c0c0c0', tint: 0xc0c0c0 },
      { label: 'Black',     color: '#1a1a1a', tint: 0x111111 },
    ],
    scale: 1.0,
    yOffset: 0,
  },
  {
    id:       'rimless',
    file:     'models/rimless.glb',
    brand:    'Luceandombra Air',
    name:     'Rimless Feather',
    price:    '₹ 2,199',
    stars:    '★★★★★',
    reviews:  '(318)',
    category: 'eyeglasses',
    faceShapes: ['oval', 'oblong', 'square'],
    swatches: [
      { label: 'Silver',  color: '#c0c0c0', tint: 0xc0c0c0 },
      { label: 'Gold',    color: '#d4af37', tint: 0xd4af37 },
    ],
    scale: 1.0,
    yOffset: 0,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  cameraStream:       null,
  faceLandmarker:     null,
  rafHandle:          null,
  isRunning:          false,
  faceDetected:       false,
  faceLostTimer:      null,
  currentGlassesId:   'aviator',
  currentSwatchIdx:   0,
  currentCategory:    'all',
  debugMode:          false,
  faceShape:          null,
  frameCount:         0,
  fpsTimer:           0,
  faceShapeTimer:     null,
};

// Smoothed transform targets
const target = {
  position: new THREE.Vector3(),
  scale:    new THREE.Vector3(0.001, 0.001, 0.001),
  quat:     new THREE.Quaternion(),
};

// GLB model cache (id → THREE.Group)
const modelCache = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// DOM
// ─────────────────────────────────────────────────────────────────────────────
const el = {
  viewport:          document.getElementById('viewport'),
  webcam:            document.getElementById('webcam'),
  debugCanvas:       document.getElementById('debugCanvas'),
  threeCanvas:       document.getElementById('threeCanvas'),
  noFaceBorder:      document.getElementById('noFaceBorder'),
  faceScanOval:      document.getElementById('faceScanOval'),
  loadingScreen:     document.getElementById('loadingScreen'),
  loadingText:       document.getElementById('loadingText'),
  startScreen:       document.getElementById('startScreen'),
  errorScreen:       document.getElementById('errorScreen'),
  appHeader:         document.getElementById('appHeader'),
  backBtn:           document.getElementById('backBtn'),
  noFaceLabel:       document.getElementById('noFaceLabel'),
  faceShapeBadge:    document.getElementById('faceShapeBadge'),
  faceShapeLabel:    document.getElementById('faceShapeLabel'),
  faceShapeIcon:     document.getElementById('faceShapeIcon'),
  productInfoCard:   document.getElementById('productInfoCard'),
  piBrand:           document.getElementById('piBrand'),
  piName:            document.getElementById('piName'),
  piPrice:           document.getElementById('piPrice'),
  piStars:           document.getElementById('piStars'),
  piReviews:         document.getElementById('piReviews'),
  piSwatches:        document.getElementById('piSwatches'),
  categoryTabs:      document.getElementById('categoryTabs'),
  glassesPanel:      document.getElementById('glassesPanel'),
  glassesRow:        document.getElementById('glassesRow'),
  gpCount:           document.getElementById('gpCount'),
  shutterFlash:      document.getElementById('shutterFlash'),
  captureToast:      document.getElementById('captureToast'),
  captureHeaderBtn:  document.getElementById('captureHeaderBtn'),
  debugStats:        document.getElementById('debugStats'),
  debugBadge:        document.getElementById('debugBadge'),
  fpsDisplay:        document.getElementById('fpsDisplay'),
  triCount:          document.getElementById('triCount'),
  objCount:          document.getElementById('objCount'),
  startBtn:          document.getElementById('startBtn'),
  retryBtn:          document.getElementById('retryBtn'),
  errorIcon:         document.getElementById('errorIcon'),
  errorTitle:        document.getElementById('errorTitle'),
  errorSub:          document.getElementById('errorSub'),
  errorSteps:        document.getElementById('errorSteps'),
  pcBuyBtn:          document.getElementById('pcBuyBtn'),
  // legacy refs
  captureBtn:        document.getElementById('captureBtn'),
  resetBtn:          document.getElementById('resetBtn'),
  stopBtn:           document.getElementById('stopBtn'),
};

// ─────────────────────────────────────────────────────────────────────────────
// THREE.JS SETUP
// ─────────────────────────────────────────────────────────────────────────────
let renderer, scene, orthoCamera, glassesGroup, faceDotsMesh, envMap;
const clock = new THREE.Clock();

function makeOrthoCamera() {
  const aspect = window.innerWidth / window.innerHeight;
  const halfH  = 1.0;
  return new THREE.OrthographicCamera(
    -halfH * aspect, halfH * aspect,
     halfH,         -halfH,
     0.01, 100
  );
}

function initThree() {
  const isMobile = window.innerWidth <= 768;

  renderer = new THREE.WebGLRenderer({
    canvas:          el.threeCanvas,
    alpha:           true,
    antialias:       true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true, // required for capture
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 2 : 2.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping         = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.outputColorSpace    = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  orthoCamera = makeOrthoCamera();
  orthoCamera.position.z = 5;

  // Environment map for PBR reflections
  const pmrem = new THREE.PMREMGenerator(renderer);
  envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = envMap;

  // Lighting rig
  const ambient  = new THREE.AmbientLight(0xffffff, 0.8);
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
  keyLight.position.set(3, 5, 6);
  const fillLight = new THREE.DirectionalLight(0xfff4e0, 0.6);
  fillLight.position.set(-3, 2, 4);
  const rimLight  = new THREE.PointLight(0xffeedd, 0.8, 30);
  rimLight.position.set(0, -2, 4);
  const topLight  = new THREE.DirectionalLight(0xffffff, 0.4);
  topLight.position.set(0, 8, 2);
  scene.add(ambient, keyLight, fillLight, rimLight, topLight);

  glassesGroup = new THREE.Group();
  glassesGroup.visible = false;
  scene.add(glassesGroup);

  // AR face dots
  const dotsGeo = new THREE.BufferGeometry();
  dotsGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(468 * 3), 3));
  const dotsMat = new THREE.PointsMaterial({
    color: 0xc9a84c,
    size: 0.004,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.0,
    depthTest: false,
  });
  faceDotsMesh = new THREE.Points(dotsGeo, dotsMat);
  faceDotsMesh.renderOrder = 999;
  scene.add(faceDotsMesh);

  window.addEventListener('resize', onResize);
}

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  const aspect = w / h;
  orthoCamera.left   = -aspect;
  orthoCamera.right  =  aspect;
  orthoCamera.top    =  1;
  orthoCamera.bottom = -1;
  orthoCamera.updateProjectionMatrix();
  el.debugCanvas.width  = w;
  el.debugCanvas.height = h;
  syncProductCardBottom();
}

// ─────────────────────────────────────────────────────────────────────────────
// COORDINATE MAPPING
// ─────────────────────────────────────────────────────────────────────────────
function landmarkToWorld(lm, zOverride) {
  const w  = window.innerWidth;
  const h  = window.innerHeight;
  const vw = el.webcam.videoWidth  || w;
  const vh = el.webcam.videoHeight || h;

  const windowAspect = w / h;
  const videoAspect  = vw / vh;
  const scale        = windowAspect > videoAspect ? w / vw : h / vh;

  const rvw  = vw * scale;
  const rvh  = vh * scale;
  const offX = (w - rvw) / 2;
  const offY = (h - rvh) / 2;

  const px = offX + (1.0 - lm.x) * rvw;
  const py = offY + lm.y * rvh;

  const halfW = windowAspect;
  const worldX =  (px / w) * (2 * halfW) - halfW;
  const worldY = -((py / h) * 2 - 1);

  return new THREE.Vector3(worldX, worldY, zOverride ?? GLASSES_Z_OFFSET);
}

// ─────────────────────────────────────────────────────────────────────────────
// HEAD POSE
// ─────────────────────────────────────────────────────────────────────────────
function extractRotation(matrixArray) {
  const mat = new THREE.Matrix4().fromArray(matrixArray);
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const sc   = new THREE.Vector3();
  mat.decompose(pos, quat, sc);
  const euler = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
  const mirrored = new THREE.Euler(euler.x, -euler.y, -euler.z, 'XYZ');
  return new THREE.Quaternion().setFromEuler(mirrored);
}

// ─────────────────────────────────────────────────────────────────────────────
// FACE SHAPE DETECTION
// ─────────────────────────────────────────────────────────────────────────────
const FACE_SHAPES = {
  oval:    { icon: '⬡', label: 'Oval Face' },
  round:   { icon: '○', label: 'Round Face' },
  square:  { icon: '□', label: 'Square Face' },
  heart:   { icon: '♡', label: 'Heart Face' },
  oblong:  { icon: '▭', label: 'Oblong Face' },
};

function detectFaceShape(lmArray) {
  try {
    const forehead = lmArray[LM.FOREHEAD];
    const chin     = lmArray[LM.CHIN];
    const cheekL   = lmArray[LM.CHEEK_L];
    const cheekR   = lmArray[LM.CHEEK_R];
    const jawL     = lmArray[LM.JAW_L];
    const jawR     = lmArray[LM.JAW_R];

    // Face height vs width ratio
    const faceH     = Math.abs(chin.y - forehead.y);
    const faceW     = Math.abs(cheekR.x - cheekL.x);
    const jawW      = Math.abs(jawR.x - jawL.x);
    const foreheadW = faceW; // approximate

    if (faceW < 0.001) return null;

    const ratio    = faceH / faceW;
    const jawRatio = jawW / faceW;

    if (ratio > 1.5)               return 'oblong';
    if (jawRatio > 0.85 && ratio < 1.2) return 'square';
    if (ratio < 1.1 && jawRatio > 0.75) return 'round';
    if (jawRatio < 0.65)           return 'heart';
    return 'oval'; // default
  } catch (e) {
    return 'oval';
  }
}

let faceShapeBuffer = [];
function updateFaceShape(lmArray) {
  const shape = detectFaceShape(lmArray);
  if (!shape) return;

  faceShapeBuffer.push(shape);
  if (faceShapeBuffer.length > 30) faceShapeBuffer.shift();

  // Mode of the buffer (most common)
  const freq = {};
  let best = shape, max = 0;
  for (const s of faceShapeBuffer) {
    freq[s] = (freq[s] || 0) + 1;
    if (freq[s] > max) { max = freq[s]; best = s; }
  }

  if (best !== state.faceShape) {
    state.faceShape = best;
    showFaceShapeBadge(best);
    updateRecommendationBadges();
  }
}

function showFaceShapeBadge(shape) {
  const info = FACE_SHAPES[shape] || { icon: '⬡', label: shape };
  el.faceShapeIcon.textContent  = info.icon;
  el.faceShapeLabel.textContent = `${info.label} — frames matched!`;
  el.faceShapeBadge.classList.remove('hidden');

  clearTimeout(state.faceShapeTimer);
  state.faceShapeTimer = setTimeout(() => {
    el.faceShapeBadge.classList.add('hidden');
  }, 5000);
}

function updateRecommendationBadges() {
  document.querySelectorAll('.glasses-card').forEach(card => {
    const id    = card.dataset.id;
    const entry = GLASSES_CATALOG.find(g => g.id === id);
    const badge = card.querySelector('.gc-rec-badge');
    if (!entry || !badge) return;

    const isRec = entry.faceShapes?.includes(state.faceShape);
    badge.style.display = isRec ? 'flex' : 'none';
    card.title = isRec ? `Recommended for ${state.faceShape} face!` : '';
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AR FACE DOTS
// ─────────────────────────────────────────────────────────────────────────────
let dotsOpacity = 0;

function updateFaceDots(lmArray, visible) {
  if (!faceDotsMesh) return;
  const geo = faceDotsMesh.geometry;
  const positions = geo.attributes.position.array;

  if (visible) {
    for (let i = 0; i < lmArray.length; i++) {
      const wp = landmarkToWorld(lmArray[i], GLASSES_Z_OFFSET + 0.001);
      positions[i * 3]     = wp.x;
      positions[i * 3 + 1] = wp.y;
      positions[i * 3 + 2] = wp.z;
    }
    geo.attributes.position.needsUpdate = true;
    dotsOpacity = Math.min(1, dotsOpacity + 0.08);
  } else {
    dotsOpacity = Math.max(0, dotsOpacity - 0.1);
  }
  faceDotsMesh.material.opacity = dotsOpacity * 0.35;
}

// ─────────────────────────────────────────────────────────────────────────────
// LANDMARK VALIDATION — guard against NaN / out-of-range values
// ─────────────────────────────────────────────────────────────────────────────
function lmValid(lm) {
  return lm &&
    Number.isFinite(lm.x) && Number.isFinite(lm.y) && Number.isFinite(lm.z) &&
    lm.x >= 0 && lm.x <= 1 && lm.y >= 0 && lm.y <= 1;
}

function safeLM(lmArray, idx) {
  const lm = lmArray[idx];
  return lmValid(lm) ? lm : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ADAPTIVE LERP — high factor when moving fast, low when still
// ─────────────────────────────────────────────────────────────────────────────
const _prevPos   = new THREE.Vector3();
const _prevScale = new THREE.Vector3(0.001, 0.001, 0.001);
let _firstDetect = true;

function adaptiveLerp(min, max, velocity) {
  // velocity: magnitude of change per frame in world units
  const t = Math.min(1, velocity * LERP_VEL_SCALE);
  return min + (max - min) * t;
}

// ─────────────────────────────────────────────────────────────────────────────
// FACE RESULTS  — precision multi-point anchor + One Euro filtered
// ─────────────────────────────────────────────────────────────────────────────
function onFaceResults(lmArray, transformMatrix, timestamp) {
  // ── 1. SCALE — average of 3 independent measurements ──
  const lt = safeLM(lmArray, LM.L_TEMPLE);
  const rt = safeLM(lmArray, LM.R_TEMPLE);
  const li = safeLM(lmArray, LM.L_EYE_INNER);
  const ri = safeLM(lmArray, LM.R_EYE_INNER);
  const lo = safeLM(lmArray, LM.L_EYE_OUTER);
  const ro = safeLM(lmArray, LM.R_EYE_OUTER);

  if (!lt || !rt || !li || !ri) return; // require key landmarks

  const templeW  = landmarkToWorld(lt).distanceTo(landmarkToWorld(rt));   // full face width
  const ipdW     = landmarkToWorld(li).distanceTo(landmarkToWorld(ri));   // inter-pupillary
  const eyeW     = landmarkToWorld(lo || li).distanceTo(landmarkToWorld(ro || ri)); // eye span

  // Weighted average: temple width is most stable
  const rawScale = (templeW * 0.60 + eyeW * 0.25 + ipdW * 0.15) * 1.05;
  const filteredScale = OEF.scale.filter(rawScale, timestamp);
  target.scale.setScalar(Math.max(filteredScale, 0.01));

  // ── 2. ROTATION — from MediaPipe facial transform matrix ──
  if (transformMatrix) {
    const rawQuat = extractRotation(transformMatrix);
    const euler   = new THREE.Euler().setFromQuaternion(rawQuat, 'XYZ');

    // Filter each Euler angle independently
    const fx = OEF.rx.filter(euler.x, timestamp);
    const fy = OEF.ry.filter(euler.y, timestamp);
    const fz = OEF.rz.filter(euler.z, timestamp);

    target.quat.setFromEuler(new THREE.Euler(fx, fy, fz, 'XYZ'));
  }

  // ── 3. POSITION — weighted anchor: 60% eye-midpoint + 40% nose bridge ──
  const nb = safeLM(lmArray, LM.NOSE_BRIDGE);
  if (!nb) return;

  // Eye midpoint (most stable anchor — moves less with head tilt than nose bridge)
  const eyeMidX = (li.x + ri.x) * 0.5;
  const eyeMidY = (li.y + ri.y) * 0.5;
  const eyeMidZ = (li.z + ri.z) * 0.5;
  const eyeMid  = { x: eyeMidX, y: eyeMidY, z: eyeMidZ };

  // Weighted blend of eye-midpoint and nose-bridge for anchor
  const anchorX = eyeMid.x * 0.60 + nb.x * 0.40;
  const anchorY = eyeMid.y * 0.60 + nb.y * 0.40;
  const anchorZ = eyeMid.z * 0.60 + nb.z * 0.40;
  const anchor  = { x: anchorX, y: anchorY, z: anchorZ };

  const anchorWorld = landmarkToWorld(anchor);

  // Depth-aware Z offset: glasses closer for smaller faces (further away), further for larger
  const depthFactor = Math.max(0.5, Math.min(1.5, 1.0 / (filteredScale * 4 + 0.001)));
  const localOffset = new THREE.Vector3(0, -filteredScale * 0.08, -filteredScale * 0.22 * depthFactor);
  localOffset.applyQuaternion(target.quat);

  // Apply One Euro Filter to world position
  const rawX = anchorWorld.x + localOffset.x;
  const rawY = anchorWorld.y + localOffset.y;
  const rawZ = anchorWorld.z + localOffset.z;

  const filteredX = OEF.x.filter(rawX, timestamp);
  const filteredY = OEF.y.filter(rawY, timestamp);
  const filteredZ = OEF.z.filter(rawZ, timestamp);

  target.position.set(filteredX, filteredY, filteredZ);

  // ── 4. Face shape every 60 frames (more stable) ──
  if (state.frameCount % 60 === 0) {
    updateFaceShape(lmArray);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEBUG LANDMARKS
// ─────────────────────────────────────────────────────────────────────────────
function drawDebugLandmarks(lmArray) {
  const ctx = el.debugCanvas.getContext('2d');
  const w   = el.debugCanvas.width;
  const h   = el.debugCanvas.height;
  ctx.clearRect(0, 0, w, h);

  const vw = el.webcam.videoWidth  || w;
  const vh = el.webcam.videoHeight || h;
  const s   = (w / h > vw / vh) ? w / vw : h / vh;
  const ox  = (w - vw * s) / 2;
  const oy  = (h - vh * s) / 2;

  ctx.fillStyle = 'rgba(201,168,76,0.7)';
  for (const lm of lmArray) {
    const x = ox + (1 - lm.x) * vw * s;
    const y = oy + lm.y * vh * s;
    ctx.beginPath();
    ctx.arc(x, y, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ANIMATION LOOP  — adaptive LERP + instant snap on first detection
// ─────────────────────────────────────────────────────────────────────────────
let _fpsTimer     = 0;
let _frameCounter = 0;

function animate(nowMs) {
  state.rafHandle = requestAnimationFrame(animate);
  const delta = clock.getDelta();

  state.frameCount++;
  _frameCounter++;
  _fpsTimer += delta;
  if (_fpsTimer >= 0.5) {
    const fps = Math.round(_frameCounter / _fpsTimer);
    el.fpsDisplay.textContent = fps + ' fps';
    _frameCounter = 0;
    _fpsTimer = 0;
  }

  if (state.isRunning && state.faceLandmarker && el.webcam.readyState >= 2 && nowMs > 0) {
    let results;
    try {
      results = state.faceLandmarker.detectForVideo(el.webcam, nowMs);
    } catch (_) {}

    if (results?.faceLandmarks?.length > 0) {
      const lmArray = results.faceLandmarks[0];

      if (state.debugMode) drawDebugLandmarks(lmArray);

      if (!state.faceDetected) {
        state.faceDetected = true;
        _firstDetect = true;        // flag for instant snap
        clearTimeout(state.faceLostTimer);
        showNoFaceUI(false);
        glassesGroup.visible = true;
        el.faceScanOval?.classList.add('hidden');
      }

      const matrix = results.facialTransformationMatrixes?.[0]?.data || null;
      onFaceResults(lmArray, matrix, nowMs);
      updateFaceDots(lmArray, true);

    } else {
      updateFaceDots(null, false);

      if (state.faceDetected) {
        state.faceDetected = false;
        state.faceLostTimer = setTimeout(() => {
          showNoFaceUI(true);
          glassesGroup.visible = false;
          el.faceScanOval?.classList.remove('hidden');
          resetAllFilters(); // reset filters so next detect starts clean
        }, FACE_LOST_MS);
      }

      if (state.debugMode) {
        el.debugCanvas.getContext('2d').clearRect(0, 0, el.debugCanvas.width, el.debugCanvas.height);
      }
    }
  }

  // ── Apply adaptive LERP / instant snap to glasses group ──
  if (glassesGroup) {
    if (_firstDetect) {
      // INSTANT SNAP on first detection — no slide-in drift
      glassesGroup.position.copy(target.position);
      glassesGroup.scale.copy(target.scale);
      glassesGroup.quaternion.copy(target.quat);
      _firstDetect = false;
    } else {
      // Compute velocity (change magnitude since last frame)
      const velPos   = glassesGroup.position.distanceTo(target.position);
      const velScale = Math.abs(glassesGroup.scale.x - target.scale.x);

      // Adaptive lerp factors
      const lerpPos   = adaptiveLerp(LERP_POS_MIN,   LERP_POS_MAX,   velPos);
      const lerpScale = adaptiveLerp(LERP_SCALE_MIN, LERP_SCALE_MAX, velScale);
      const lerpRot   = adaptiveLerp(LERP_ROT_MIN,   LERP_ROT_MAX,   velPos);

      glassesGroup.position.lerp(target.position, lerpPos);
      glassesGroup.scale.lerp(target.scale, lerpScale);
      glassesGroup.quaternion.slerp(target.quat, lerpRot);
    }
  }

  if (state.debugMode && el.triCount) {
    const info = renderer.info;
    el.triCount.textContent = info.render.triangles;
    el.objCount.textContent = info.render.calls;
  }

  renderer.render(scene, orthoCamera);
}

// ─────────────────────────────────────────────────────────────────────────────
// MEDIAPIPE
// ─────────────────────────────────────────────────────────────────────────────
async function initMediaPipe() {
  setLoadingText('Loading AI model…');
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
  );
  state.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      delegate: 'GPU',              // Use GPU for faster inference
    },
    runningMode:                        'VIDEO',
    numFaces:                           1,
    // Higher thresholds = more confident detections, fewer false positives
    minFaceDetectionConfidence:         0.70,  // was 0.50
    minFacePresenceConfidence:          0.70,  // was 0.50
    minTrackingConfidence:              0.65,  // was 0.50
    outputFaceBlendshapes:              false,
    outputFacialTransformationMatrixes: true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA
// ─────────────────────────────────────────────────────────────────────────────
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return Object.assign(new Error('Needs HTTPS or localhost'), { name: 'NotSupportedError' });
  }
  try {
    const perm = await navigator.permissions.query({ name: 'camera' });
    if (perm.state === 'denied') {
      return Object.assign(new Error('Camera permission denied'), { name: 'NotAllowedError' });
    }
  } catch (_) {}

  try {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width:  { ideal: isMobile ? 1280 : 1920 },
        height: { ideal: isMobile ? 720  : 1080 },
        frameRate: { ideal: 30, min: 24 },
      },
      audio: false,
    });
    state.cameraStream  = stream;
    el.webcam.srcObject = stream;
    await new Promise(res => { el.webcam.onloadedmetadata = res; });
    await el.webcam.play();
    el.debugCanvas.width  = el.webcam.videoWidth  || window.innerWidth;
    el.debugCanvas.height = el.webcam.videoHeight || window.innerHeight;
    return null;
  } catch (err) {
    return err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INDEXEDDB CACHE
// ─────────────────────────────────────────────────────────────────────────────
function openIDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_DB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) db.createObjectStore(IDB_STORE_NAME);
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}
async function readFromIDB(db, key) {
  return new Promise((res, rej) => {
    const req = db.transaction(IDB_STORE_NAME, 'readonly').objectStore(IDB_STORE_NAME).get(key);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}
async function writeToIDB(db, key, value) {
  return new Promise((res, rej) => {
    const req = db.transaction(IDB_STORE_NAME, 'readwrite').objectStore(IDB_STORE_NAME).put(value, key);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}

let idb = null;
async function getIDB() {
  if (!idb) idb = await openIDB().catch(() => null);
  return idb;
}

// ─────────────────────────────────────────────────────────────────────────────
// GLB LOADER
// ─────────────────────────────────────────────────────────────────────────────
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
dracoLoader.preload();

const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

async function loadGlassesModel(entry) {
  // 1. In-memory cache
  if (modelCache.has(entry.id)) return modelCache.get(entry.id).clone(true);

  setLoadingText(`Loading ${entry.name}…`);

  // 2. Try loading the local GLB file
  try {
    const gltf = await gltfLoader.loadAsync(entry.file);
    const norm  = normalizeModel(gltf.scene, entry);
    modelCache.set(entry.id, norm);
    return norm.clone(true);
  } catch (e) {
    console.warn(`[LO] GLB load failed for ${entry.id}:`, e.message);
  }

  // 3. Fallback — procedural frame
  console.log(`[LO] Falling back to procedural frame for ${entry.id}`);
  const group = buildProceduralFrame(entry);
  const norm  = normalizeModel(group, entry);
  modelCache.set(entry.id, norm);
  return norm.clone(true);
}

function normalizeModel(scene, entry) {
  const box    = new THREE.Box3().setFromObject(scene);
  const size   = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const wrapper = new THREE.Group();
  scene.position.set(-center.x, -center.y, -center.z);
  wrapper.add(scene);

  if (size.x > 0) {
    wrapper.scale.setScalar(1.0 / size.x);
  }

  // Apply entry-level scale override
  if (entry?.scale && entry.scale !== 1.0) {
    wrapper.scale.multiplyScalar(entry.scale);
  }

  return wrapper;
}

// ─────────────────────────────────────────────────────────────────────────────
// COLOR VARIANTS — apply tint to loaded model
// ─────────────────────────────────────────────────────────────────────────────
function applyColorTint(group, hexColor) {
  const col = new THREE.Color(hexColor);
  group.traverse(child => {
    if (child.isMesh) {
      if (Array.isArray(child.material)) {
        child.material.forEach(m => {
          if (m && !m._originalColor) m._originalColor = m.color?.clone();
          if (m?.color) m.color.set(col);
          if (m?.emissive) m.emissive.set(0x000000);
        });
      } else if (child.material) {
        const m = child.material;
        if (!m._originalColor) m._originalColor = m.color?.clone();
        if (m.color) m.color.set(col);
        if (m.emissive) m.emissive.set(0x000000);
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PROCEDURAL FALLBACK
// ─────────────────────────────────────────────────────────────────────────────
function buildProceduralFrame(entry) {
  const color = entry.swatches?.[0]?.tint ?? 0x1a1a1a;
  const group = new THREE.Group();

  const plasticMat = new THREE.MeshPhysicalMaterial({
    color, metalness: 0.0, roughness: 0.15,
    clearcoat: 1.0, clearcoatRoughness: 0.05,
    reflectivity: 0.8, envMapIntensity: 1.8,
  });
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0xd4af37, metalness: 1.0, roughness: 0.25, envMapIntensity: 2.0,
  });
  const lensMat = new THREE.MeshPhysicalMaterial({
    color: 0xddeeff, transmission: 0.92, opacity: 1.0, transparent: true,
    roughness: 0.02, ior: 1.52, thickness: 0.012,
    clearcoat: 1.0, side: THREE.DoubleSide, envMapIntensity: 2.0,
  });

  // Simple generic frame
  const rimGeo = new THREE.TorusGeometry(0.082, 0.008, 18, 56);
  const lRim   = new THREE.Mesh(rimGeo.clone(), plasticMat);
  const rRim   = new THREE.Mesh(rimGeo.clone(), plasticMat);
  lRim.position.set(-0.175, 0, 0);
  rRim.position.set( 0.175, 0, 0);
  group.add(lRim, rRim);

  const bridgeCurve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(-0.085, 0.012, 0),
    new THREE.Vector3(0, 0.04, 0.016),
    new THREE.Vector3(0.085, 0.012, 0)
  );
  const bridge = new THREE.Mesh(
    new THREE.TubeGeometry(bridgeCurve, 14, 0.006, 10, false),
    metalMat
  );
  group.add(bridge);

  const fillGeo = new THREE.CircleGeometry(0.079, 48);
  const lFill   = new THREE.Mesh(fillGeo.clone(), lensMat);
  const rFill   = new THREE.Mesh(fillGeo.clone(), lensMat);
  lFill.position.set(-0.175, 0, 0.001);
  rFill.position.set( 0.175, 0, 0.001);
  group.add(lFill, rFill);

  return group;
}

// ─────────────────────────────────────────────────────────────────────────────
// GLASSES MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
async function setActiveGlasses(id, swatchIdx = 0) {
  const entry = GLASSES_CATALOG.find(g => g.id === id);
  if (!entry) return;

  state.currentGlassesId = id;
  state.currentSwatchIdx = swatchIdx;

  // Update carousel selection
  document.querySelectorAll('.glasses-card').forEach(c =>
    c.classList.toggle('active', c.dataset.id === id)
  );

  // Update product info card
  if (el.piBrand)   el.piBrand.textContent   = entry.brand   || '';
  if (el.piName)    el.piName.textContent     = entry.name    || '';
  if (el.piPrice)   el.piPrice.textContent    = entry.price   || '';
  if (el.piStars)   el.piStars.textContent    = entry.stars   || '';
  if (el.piReviews) el.piReviews.textContent  = entry.reviews || '';

  // Build color swatches
  buildSwatches(entry, swatchIdx);

  // Load 3D model
  clearGlassesGroup();
  showLoading(true);
  const model = await loadGlassesModel(entry);

  // Apply color tint from selected swatch
  const swatch = entry.swatches?.[swatchIdx];
  if (swatch) applyColorTint(model, swatch.tint);

  glassesGroup.add(model);
  showLoading(false);
}

function buildSwatches(entry, activeIdx) {
  if (!el.piSwatches) return;
  el.piSwatches.innerHTML = '';
  (entry.swatches || []).forEach((sw, i) => {
    const btn = document.createElement('button');
    btn.className  = 'swatch' + (i === activeIdx ? ' active' : '');
    btn.style.background = sw.color;
    btn.title = sw.label;
    btn.setAttribute('aria-label', sw.label);
    btn.addEventListener('click', () => {
      setActiveGlasses(state.currentGlassesId, i);
    });
    el.piSwatches.appendChild(btn);
  });
}

function clearGlassesGroup() {
  while (glassesGroup.children.length) {
    glassesGroup.remove(glassesGroup.children[0]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHOTO CAPTURE
// ─────────────────────────────────────────────────────────────────────────────
async function capturePhoto() {
  // Flash effect
  el.shutterFlash.classList.remove('hidden');
  void el.shutterFlash.offsetWidth;
  el.shutterFlash.classList.add('active');
  setTimeout(() => {
    el.shutterFlash.classList.remove('active');
    el.shutterFlash.classList.add('hidden');
  }, 600);

  // Composite: webcam + three.js canvas
  const w = window.innerWidth;
  const h = window.innerHeight;

  const canvas = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  // Draw webcam (mirrored, matching CSS)
  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(el.webcam, 0, 0, w, h);
  ctx.restore();

  // Draw three.js overlay (already rendered, preserveDrawingBuffer: true)
  renderer.render(scene, orthoCamera); // force fresh render
  ctx.drawImage(el.threeCanvas, 0, 0, w, h);

  // Download
  const link    = document.createElement('a');
  link.download = `luceandombra-${state.currentGlassesId}-${Date.now()}.jpg`;
  link.href     = canvas.toDataURL('image/jpeg', 0.92);
  link.click();

  // Show toast
  showCaptureToast();
}

function showCaptureToast() {
  el.captureToast.classList.remove('hidden');
  setTimeout(() => {
    el.captureToast.classList.add('hidden');
  }, 2800);
}

// ─────────────────────────────────────────────────────────────────────────────
// UI — Glasses Selector + Category Tabs
// ─────────────────────────────────────────────────────────────────────────────

// Thumbnail SVGs — elegant line icons matching the frame style
const FRAME_THUMB_SVG = {
  aviator: `<svg viewBox="0 0 70 45" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="17" cy="26" rx="14" ry="17" stroke="#c9a84c" stroke-width="2" fill="rgba(200,220,255,0.15)"/>
    <ellipse cx="17" cy="26" rx="11" ry="14" stroke="#c9a84c" stroke-width="1" fill="none" stroke-dasharray="2 1"/>
    <ellipse cx="53" cy="26" rx="14" ry="17" stroke="#c9a84c" stroke-width="2" fill="rgba(200,220,255,0.15)"/>
    <ellipse cx="53" cy="26" rx="11" ry="14" stroke="#c9a84c" stroke-width="1" fill="none" stroke-dasharray="2 1"/>
    <path d="M31 16 Q35 12 39 16" stroke="#c9a84c" stroke-width="1.5" fill="none"/>
    <line x1="1" y1="13" x2="3" y2="13" stroke="#c9a84c" stroke-width="2" stroke-linecap="round"/>
    <line x1="67" y1="13" x2="69" y2="13" stroke="#c9a84c" stroke-width="2" stroke-linecap="round"/>
  </svg>`,
  round: `<svg viewBox="0 0 70 45" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="17" cy="24" r="14" stroke="#aaaacc" stroke-width="2" fill="rgba(200,220,255,0.15)"/>
    <circle cx="53" cy="24" r="14" stroke="#aaaacc" stroke-width="2" fill="rgba(200,220,255,0.15)"/>
    <path d="M31 22 Q35 18 39 22" stroke="#aaaacc" stroke-width="1.5" fill="none"/>
    <line x1="1" y1="15" x2="3" y2="15" stroke="#aaaacc" stroke-width="2" stroke-linecap="round"/>
    <line x1="67" y1="15" x2="69" y2="15" stroke="#aaaacc" stroke-width="2" stroke-linecap="round"/>
  </svg>`,
  sunglasses: `<svg viewBox="0 0 70 45" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="3" y="14" width="28" height="18" rx="9" stroke="#333366" stroke-width="2.5" fill="rgba(20,20,60,0.6)"/>
    <rect x="39" y="14" width="28" height="18" rx="9" stroke="#333366" stroke-width="2.5" fill="rgba(20,20,60,0.6)"/>
    <path d="M31 22 Q35 18 39 22" stroke="#333366" stroke-width="2" fill="none"/>
    <line x1="1" y1="18" x2="3" y2="18" stroke="#333366" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="67" y1="18" x2="69" y2="18" stroke="#333366" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`,
  wayfarer: `<svg viewBox="0 0 70 45" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="3" y="11" width="28" height="22" rx="5" stroke="#cc8833" stroke-width="2.5" fill="rgba(200,140,50,0.1)"/>
    <rect x="39" y="11" width="28" height="22" rx="5" stroke="#cc8833" stroke-width="2.5" fill="rgba(200,140,50,0.1)"/>
    <path d="M31 21 Q35 17 39 21" stroke="#cc8833" stroke-width="2" fill="none"/>
    <line x1="1" y1="15" x2="3" y2="15" stroke="#cc8833" stroke-width="2" stroke-linecap="round"/>
    <line x1="67" y1="15" x2="69" y2="15" stroke="#cc8833" stroke-width="2" stroke-linecap="round"/>
  </svg>`,
  clubmaster: `<svg viewBox="0 0 70 45" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 16 Q3 11 9 11 H25 Q31 11 31 16 L31 20 Q31 26 17 26 Q3 26 3 20Z" stroke="#5a3010" stroke-width="2.5" fill="rgba(90,50,20,0.15)"/>
    <path d="M39 16 Q39 11 45 11 H61 Q67 11 67 16 L67 20 Q67 26 53 26 Q39 26 39 20Z" stroke="#5a3010" stroke-width="2.5" fill="rgba(90,50,20,0.15)"/>
    <path d="M31 20 Q35 16 39 20" stroke="#c9a84c" stroke-width="1.5" fill="none"/>
    <line x1="1" y1="15" x2="3" y2="15" stroke="#5a3010" stroke-width="2" stroke-linecap="round"/>
    <line x1="67" y1="15" x2="69" y2="15" stroke="#5a3010" stroke-width="2" stroke-linecap="round"/>
  </svg>`,
  wayfarer2: `<svg viewBox="0 0 70 45" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="3" y="12" width="28" height="20" rx="4" stroke="#222222" stroke-width="2.5" fill="rgba(0,0,0,0.4)"/>
    <rect x="39" y="12" width="28" height="20" rx="4" stroke="#222222" stroke-width="2.5" fill="rgba(0,0,0,0.4)"/>
    <path d="M31 21 Q35 17 39 21" stroke="#444" stroke-width="2" fill="none"/>
    <line x1="1" y1="16" x2="3" y2="16" stroke="#222" stroke-width="2" stroke-linecap="round"/>
    <line x1="67" y1="16" x2="69" y2="16" stroke="#222" stroke-width="2" stroke-linecap="round"/>
  </svg>`,
  retro: `<svg viewBox="0 0 70 45" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="3" y="12" width="28" height="20" rx="10" stroke="#e070a0" stroke-width="2.5" fill="rgba(224,112,160,0.1)"/>
    <rect x="39" y="12" width="28" height="20" rx="10" stroke="#e070a0" stroke-width="2.5" fill="rgba(224,112,160,0.1)"/>
    <path d="M31 21 Q35 17 39 21" stroke="#e070a0" stroke-width="2" fill="none"/>
    <line x1="1" y1="16" x2="3" y2="16" stroke="#e070a0" stroke-width="2" stroke-linecap="round"/>
    <line x1="67" y1="16" x2="69" y2="16" stroke="#e070a0" stroke-width="2" stroke-linecap="round"/>
  </svg>`,
  square: `<svg viewBox="0 0 70 45" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="3" y="11" width="28" height="22" rx="2" stroke="#888888" stroke-width="2.5" fill="rgba(150,150,150,0.1)"/>
    <rect x="39" y="11" width="28" height="22" rx="2" stroke="#888888" stroke-width="2.5" fill="rgba(150,150,150,0.1)"/>
    <path d="M31 21 Q35 17 39 21" stroke="#888" stroke-width="2" fill="none"/>
    <line x1="1" y1="16" x2="3" y2="16" stroke="#888" stroke-width="2" stroke-linecap="round"/>
    <line x1="67" y1="16" x2="69" y2="16" stroke="#888" stroke-width="2" stroke-linecap="round"/>
  </svg>`,
  oval: `<svg viewBox="0 0 70 45" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="17" cy="24" rx="14" ry="11" stroke="#b76e79" stroke-width="2" fill="rgba(183,110,121,0.1)"/>
    <ellipse cx="53" cy="24" rx="14" ry="11" stroke="#b76e79" stroke-width="2" fill="rgba(183,110,121,0.1)"/>
    <path d="M31 22 Q35 18 39 22" stroke="#b76e79" stroke-width="1.5" fill="none"/>
    <line x1="1" y1="17" x2="3" y2="17" stroke="#b76e79" stroke-width="2" stroke-linecap="round"/>
    <line x1="67" y1="17" x2="69" y2="17" stroke="#b76e79" stroke-width="2" stroke-linecap="round"/>
  </svg>`,
  rimless: `<svg viewBox="0 0 70 45" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="17" cy="24" rx="14" ry="11" stroke="#c9a84c" stroke-width="1" stroke-dasharray="3 2" fill="rgba(201,168,76,0.06)"/>
    <ellipse cx="53" cy="24" rx="14" ry="11" stroke="#c9a84c" stroke-width="1" stroke-dasharray="3 2" fill="rgba(201,168,76,0.06)"/>
    <path d="M31 22 Q35 18 39 22" stroke="#c9a84c" stroke-width="1.5" fill="none"/>
    <line x1="1" y1="17" x2="3" y2="17" stroke="#c9a84c" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="67" y1="17" x2="69" y2="17" stroke="#c9a84c" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="3" cy="15" r="2" stroke="#c9a84c" stroke-width="1" fill="none"/>
    <circle cx="67" cy="15" r="2" stroke="#c9a84c" stroke-width="1" fill="none"/>
  </svg>`,
};

function buildGlassesSelector() {
  el.glassesRow.innerHTML = '';

  GLASSES_CATALOG.forEach(entry => {
    const card      = document.createElement('button');
    card.className  = 'glasses-card' + (entry.id === state.currentGlassesId ? ' active' : '');
    card.dataset.id  = entry.id;
    card.dataset.cat = entry.category;
    card.innerHTML   = `
      <div class="gc-thumb-wrap">
        ${FRAME_THUMB_SVG[entry.id] || `<span style="font-size:24px">🕶️</span>`}
      </div>
      <span class="gc-name">${entry.name}</span>
      <div class="gc-rec-badge" style="display:none">✓</div>
    `;
    card.addEventListener('click', () => setActiveGlasses(entry.id, 0));
    el.glassesRow.appendChild(card);
  });

  if (el.gpCount) el.gpCount.textContent = `${GLASSES_CATALOG.length} styles`;
  syncProductCardBottom();
  applyCategoryFilter(state.currentCategory);
}

function syncProductCardBottom() {
  if (!el.glassesPanel || !el.productInfoCard) return;
  const panelH = el.glassesPanel.getBoundingClientRect().height;
  const tabsH  = el.categoryTabs?.getBoundingClientRect().height || 0;
  document.documentElement.style.setProperty('--panel-height', `${panelH + tabsH}px`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY FILTERING
// ─────────────────────────────────────────────────────────────────────────────
function applyCategoryFilter(cat) {
  state.currentCategory = cat;
  const cards = document.querySelectorAll('.glasses-card');
  let visible = 0;
  cards.forEach(card => {
    const cardCat = card.dataset.cat;
    const show = cat === 'all' || cardCat === cat || (cat === 'kids' && cardCat === 'kids');
    card.classList.toggle('filtered-out', !show);
    if (show) visible++;
  });
  if (el.gpCount) el.gpCount.textContent = `${visible} style${visible !== 1 ? 's' : ''}`;
}

function buildCategoryTabs() {
  const tabs = el.categoryTabs?.querySelectorAll('.cat-tab') || [];
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      applyCategoryFilter(tab.dataset.cat);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function setLoadingText(txt) {
  if (el.loadingText) el.loadingText.textContent = txt;
}

function showOverlay(id, visible) {
  const elem = document.getElementById(id);
  if (!elem) return;
  if (visible) {
    elem.classList.remove('hidden');
    void elem.offsetWidth;
    elem.classList.add('active');
  } else {
    elem.classList.remove('active');
    setTimeout(() => elem.classList.add('hidden'), 450);
  }
}

function showLoading(visible) {
  if (visible) {
    el.loadingScreen.classList.remove('hidden');
    void el.loadingScreen.offsetWidth;
    el.loadingScreen.classList.add('active');
  } else {
    el.loadingScreen.classList.remove('active');
    setTimeout(() => el.loadingScreen.classList.add('hidden'), 450);
  }
}

function showAppUI(visible) {
  [el.appHeader, el.productInfoCard, el.glassesPanel, el.categoryTabs].forEach(e => {
    e?.classList.toggle('hidden', !visible);
  });
  if (visible) {
    setTimeout(syncProductCardBottom, 100);
    setTimeout(syncProductCardBottom, 400);
  }
}

function showNoFaceUI(visible) {
  el.noFaceLabel?.classList.toggle('hidden', !visible);
  el.noFaceBorder?.classList.toggle('hidden', !visible);
}

function showCameraError(err) {
  const name   = err?.name || 'UnknownError';
  const isHTTP = window.location.href.startsWith('http');
  const configs = {
    NotAllowedError: {
      icon: '🚫', title: 'Camera Permission Denied',
      sub: 'Grant camera access to use Virtual Try-On.',
      steps: [
        'Chrome/Edge: Click 🔒 in address bar → Camera → Allow',
        'Firefox: Camera icon in address bar → Allow',
        'Safari: Settings → Safari → Camera → Allow',
      ],
    },
    NotFoundError: {
      icon: '📷', title: 'No Camera Found',
      sub: 'Connect a camera and try again.',
      steps: ['Check camera connection', 'Try a different browser'],
    },
    NotReadableError: {
      icon: '🔄', title: 'Camera Already In Use',
      sub: 'Close other apps using your camera.',
      steps: ['Close Zoom, Meet, Teams, or other tabs', 'Reload and try again'],
    },
    NotSupportedError: {
      icon: '🔒',
      title: isHTTP ? 'Browser Not Supported' : 'Needs HTTPS',
      sub: isHTTP ? 'Use Chrome, Edge, or Firefox.' : 'Open via http://localhost or an HTTPS URL.',
      steps: isHTTP ? ['Try Chrome or Edge'] : ['Run: npx serve (in project folder)'],
    },
  };

  const cfg = configs[name] || {
    icon: '⚠️', title: 'Camera Error',
    sub: `${name}: ${err?.message || 'Unknown error'}`,
    steps: ['Reload and try again'],
  };

  el.errorIcon.textContent  = cfg.icon;
  el.errorTitle.textContent = cfg.title;
  el.errorSub.textContent   = cfg.sub;
  el.errorSteps.innerHTML   = cfg.steps.map(s => `<p class="error-step">‣ ${s}</p>`).join('');
  showOverlay('errorScreen', true);
}

// ─────────────────────────────────────────────────────────────────────────────
// STOP / RESET
// ─────────────────────────────────────────────────────────────────────────────
function stopCamera() {
  state.isRunning    = false;
  state.faceDetected = false;
  _firstDetect       = true;
  clearTimeout(state.faceLostTimer);
  resetAllFilters(); // clear all One Euro Filter state

  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach(t => t.stop());
    state.cameraStream = null;
  }
  el.webcam.srcObject = null;
  glassesGroup.visible = false;
  dotsOpacity = 0;
  if (faceDotsMesh) faceDotsMesh.material.opacity = 0;
  target.scale.set(0.001, 0.001, 0.001);
  faceShapeBuffer = [];
  state.faceShape = null;

  showNoFaceUI(false);
  showAppUI(false);
  el.faceShapeBadge?.classList.add('hidden');
  el.faceScanOval?.classList.add('hidden');
  showOverlay('startScreen', true);
}

function toggleDebug() {
  state.debugMode = !state.debugMode;
  el.debugCanvas.style.display = state.debugMode ? 'block' : 'none';
  el.debugStats?.classList.toggle('hidden', !state.debugMode);
  el.debugBadge?.classList.toggle('hidden', !state.debugMode);
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT HANDLERS
// ─────────────────────────────────────────────────────────────────────────────
function bindUIHandlers() {
  el.startBtn?.addEventListener('click', onStartClick);
  el.retryBtn?.addEventListener('click', onStartClick);
  el.backBtn?.addEventListener('click', stopCamera);
  el.captureHeaderBtn?.addEventListener('click', capturePhoto);
  el.pcBuyBtn?.addEventListener('click', () => {
    const entry = GLASSES_CATALOG.find(g => g.id === state.currentGlassesId);
    alert(`Added "${entry?.name}" to cart!\n\nThis is a demo — connect to your store backend.`);
  });

  document.addEventListener('keydown', e => {
    if (e.key.toLowerCase() === DEBUG_KEY) toggleDebug();
    if (e.key === ' ' && state.isRunning) capturePhoto();
  });
}

async function onStartClick() {
  showOverlay('startScreen', false);
  showOverlay('errorScreen', false);
  showLoading(true);
  setLoadingText('Starting camera…');

  const cameraErr = await startCamera();
  if (cameraErr) {
    showLoading(false);
    showCameraError(cameraErr);
    return;
  }

  if (!state.faceLandmarker) {
    try {
      await initMediaPipe();
    } catch (err) {
      console.error('[LO] MediaPipe init failed:', err);
      showLoading(false);
      el.errorIcon.textContent  = '🛑';
      el.errorTitle.textContent = 'AI Model Failed';
      el.errorSub.textContent   = err.message;
      el.errorSteps.innerHTML   = `
        <p class="error-step">‣ Check your internet connection</p>
        <p class="error-step">‣ Try Chrome or Edge browser</p>
      `;
      showOverlay('errorScreen', true);
      return;
    }
  }

  buildGlassesSelector();
  buildCategoryTabs();
  await setActiveGlasses(state.currentGlassesId, 0);

  // Show scan oval initially
  el.faceScanOval?.classList.remove('hidden');

  state.isRunning = true;
  showLoading(false);
  showAppUI(true);
  showNoFaceUI(true);
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
function init() {
  initThree();
  bindUIHandlers();
  el.debugCanvas.style.display = 'none';

  console.group('[LUCEANDOMBRA] v12 — Startup');
  console.log('Secure context:', window.isSecureContext);
  console.log('mediaDevices:', !!navigator.mediaDevices?.getUserMedia);
  console.log('10 real GLB frames loaded from: models/');
  console.log('Credits: Poly by Google, Jeremy, iPoly3D via poly.pizza (CC-BY)');
  navigator.permissions?.query({ name: 'camera' })
    .then(p => console.log('Camera permission:', p.state))
    .catch(() => {});
  console.groupEnd();

  requestAnimationFrame(animate);

  window.LO = { state, scene, renderer, glassesGroup, toggleDebug, setActiveGlasses, capturePhoto, OEF };
  console.log('[LO] v12 Ready — Precision tracking active.');
  console.log('[LO] One Euro Filter params: minCutoff=1.2 beta=0.008');
  console.log('[LO] Press "D" for debug mode, Space to capture photo.');
  console.log('[LO] Tune filters at runtime: LO.OEF.x.minCutoff = 0.8 etc.');
}

init();
