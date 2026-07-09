/**
 * VISAGE — Virtual Try-On  |  app.js
 * Complete ES Module implementation
 *
 * CDN Dependencies:
 *  - three@0.160.0          https://unpkg.com/three@0.160.0/build/three.module.js
 *  - GLTFLoader             https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js
 *  - @mediapipe/face_mesh   https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js
 *  - @mediapipe/camera_utils https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const GLASSES_SCALE_MULTIPLIER = 2.0;   // Ortho: glasses width ≈ eye distance × 2
const GLASSES_Y_OFFSET         = -0.02; // Push glasses slightly below eye center toward nose bridge
const GLASSES_Z_OFFSET         = 0.05;  // Z push forward so glasses render in front
const LERP_FACTOR              = 0.65;  // Snappy tracking — higher = more responsive
const MEDIAPIPE_FPS            = 30;    // Max face mesh update rate
const FACE_LOST_TIMEOUT_MS     = 2000;  // ms before hiding glasses after face lost
const MP_PROCESS_W             = 480;   // Downsampled width fed to MediaPipe (faster!)
const MP_PROCESS_H             = 270;   // Downsampled height fed to MediaPipe
const DEBUG_KEY                = 'd';   // Keyboard key to toggle debug overlay

// Landmark indices
const LM = {
  LEFT_EYE:     33,
  RIGHT_EYE:    263,
  NOSE_BRIDGE:  168,
  LEFT_TEMPLE:  234,
  RIGHT_TEMPLE: 454,
  MID_BROW:     151,
};

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  cameraStream:     null,
  mpCamera:         null,
  isRunning:        false,
  faceDetected:     false,
  faceLostTimer:    null,
  glassesOpacity:   1.0,
  currentGlassesId: 'classic',
  debugMode:        false,
  lastMpTime:       0,
  fps:              0,
  frameCount:       0,
  fpsTimer:         0,
};

// Target transforms for lerping
const target = {
  position: new THREE.Vector3(),
  scale:    new THREE.Vector3(1, 1, 1),
  rotation: new THREE.Euler(),
};

// Loaded models cache
const modelCache = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// GLASSES CATALOG
// ─────────────────────────────────────────────────────────────────────────────
const GLASSES_CATALOG = [
  {
    id:        'classic',
    name:      'Classic Round',
    thumbnail: '🕶️',
    color:     0xc9a84c,
    style:     'round',
    modelUrl:  null,
  },
  {
    id:        'aviator',
    name:      'Aviator',
    thumbnail: '✈️',
    color:     0x4a4a4a,
    style:     'aviator',
    modelUrl:  null,
  },
  {
    id:        'rectangular',
    name:      'Rectangular',
    thumbnail: '▭',
    color:     0x8B4513,
    style:     'rectangular',
    modelUrl:  null,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// DOM REFERENCES
// ─────────────────────────────────────────────────────────────────────────────
const el = {
  viewport:      document.getElementById('viewport'),
  webcam:        document.getElementById('webcam'),
  debugCanvas:   document.getElementById('debugCanvas'),
  threeCanvas:   document.getElementById('threeCanvas'),
  noFaceBorder:  document.getElementById('noFaceBorder'),
  loadingScreen: document.getElementById('loadingScreen'),
  startScreen:   document.getElementById('startScreen'),
  errorScreen:   document.getElementById('errorScreen'),
  appHeader:     document.getElementById('appHeader'),
  noFaceLabel:   document.getElementById('noFaceLabel'),
  glassesPanel:  document.getElementById('glassesPanel'),
  glassesRow:    document.getElementById('glassesRow'),
  actionButtons: document.getElementById('actionButtons'),
  shutterFlash:  document.getElementById('shutterFlash'),
  debugStats:    document.getElementById('debugStats'),
  debugBadge:    document.getElementById('debugBadge'),
  fpsDisplay:    document.getElementById('fpsDisplay'),
  triCount:      document.getElementById('triCount'),
  objCount:      document.getElementById('objCount'),

  // Buttons
  startBtn:   document.getElementById('startBtn'),
  retryBtn:   document.getElementById('retryBtn'),
  captureBtn: document.getElementById('captureBtn'),
  resetBtn:   document.getElementById('resetBtn'),
  stopBtn:    document.getElementById('stopBtn'),
};

// ─────────────────────────────────────────────────────────────────────────────
// THREE.JS SETUP
// ─────────────────────────────────────────────────────────────────────────────
let renderer, scene, camera, glassesGroup;
const clock = new THREE.Clock();

// Ortho camera half-height is 1 in world units; width scales by aspect
function makeOrthoCamera() {
  const aspect = window.innerWidth / window.innerHeight;
  const halfH  = 1.0;
  const halfW  = halfH * aspect;
  const cam    = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.01, 10);
  cam.position.z = 5;
  return cam;
}

function initThree() {
  // Renderer
  renderer = new THREE.WebGLRenderer({
    canvas:    el.threeCanvas,
    alpha:     true,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);

  // Scene
  scene = new THREE.Scene();
  scene.background = null;

  // Orthographic camera — landmark XY maps directly to world XY, zero distortion
  camera = makeOrthoCamera();

  // Lighting
  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  scene.add(ambient);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
  dirLight.position.set(2, 4, 5);
  scene.add(dirLight);

  const rimLight = new THREE.PointLight(0xc9a84c, 0.5, 10);
  rimLight.position.set(0, 1, 3);
  scene.add(rimLight);

  // Glasses group (container for model/transform)
  glassesGroup = new THREE.Group();
  glassesGroup.visible = false;
  scene.add(glassesGroup);

  // Resize handler
  window.addEventListener('resize', onResize);
}

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);

  // Rebuild ortho frustum for new aspect
  const aspect = w / h;
  const halfH  = 1.0;
  camera.left   = -halfH * aspect;
  camera.right  =  halfH * aspect;
  camera.top    =  halfH;
  camera.bottom = -halfH;
  camera.updateProjectionMatrix();

  // Sync 2D canvas size
  el.debugCanvas.width  = w;
  el.debugCanvas.height = h;
}

// ─────────────────────────────────────────────────────────────────────────────
// COORDINATE MAPPING
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Maps a MediaPipe normalized landmark [0..1] to Three.js world space.
 *
 * With an OrthographicCamera (-aspect..aspect, -1..1) this is trivial:
 *   worldX = -(lm.x - 0.5) * 2 * aspect     (flip X for mirror)
 *   worldY = -(lm.y - 0.5) * 2
 * No trig, no FOV math, no drift.
 */
function landmarkToWorld(landmark) {
  const aspect = window.innerWidth / window.innerHeight;
  const worldX = -(landmark.x - 0.5) * 2.0 * aspect;  // mirrored
  const worldY = -(landmark.y - 0.5) * 2.0;
  const worldZ =  GLASSES_Z_OFFSET;                    // flat in front
  return new THREE.Vector3(worldX, worldY, worldZ);
}

// ─────────────────────────────────────────────────────────────────────────────
// PROCEDURAL GLASSES GEOMETRY
// ─────────────────────────────────────────────────────────────────────────────
function createProceduralGlasses(catalogEntry) {
  const group  = new THREE.Group();
  const color  = catalogEntry.color;
  const style  = catalogEntry.style;

  const metalMat = new THREE.MeshStandardMaterial({
    color:     color,
    metalness: 0.82,
    roughness: 0.18,
  });

  // Lens geometry based on style
  let leftLens, rightLens;

  if (style === 'round') {
    const lensGeo = new THREE.TorusGeometry(0.085, 0.013, 12, 32);
    leftLens  = new THREE.Mesh(lensGeo,       metalMat);
    rightLens = new THREE.Mesh(lensGeo.clone(), metalMat);
  } else if (style === 'aviator') {
    // Aviator: hexagonal / teardrop shape using TorusGeometry scaled elliptically
    const lensGeo = new THREE.TorusGeometry(0.092, 0.013, 12, 6);
    leftLens  = new THREE.Mesh(lensGeo,       metalMat);
    rightLens = new THREE.Mesh(lensGeo.clone(), metalMat);
    leftLens.scale.set(0.85, 1.15, 1);
    rightLens.scale.set(0.85, 1.15, 1);
  } else {
    // Rectangular: use 4-sided ring geometry
    const rGeo = new THREE.RingGeometry(0.058, 0.076, 4);
    rGeo.rotateZ(Math.PI / 4);  // align diamond→rect
    // Scale to make it more rectangular than square
    const scaleGeo = new THREE.RingGeometry(0.058, 0.076, 4);
    scaleGeo.rotateZ(Math.PI / 4);
    leftLens  = new THREE.Mesh(scaleGeo,        metalMat);
    rightLens = new THREE.Mesh(scaleGeo.clone(), metalMat);
    leftLens.scale.set(2.0, 1.1, 1);
    rightLens.scale.set(2.0, 1.1, 1);
  }

  // Position both lenses
  leftLens.position.set(-0.175, 0, 0);
  rightLens.position.set(0.175, 0, 0);
  group.add(leftLens, rightLens);

  // Nose bridge
  const bridgeGeo = new THREE.CylinderGeometry(0.007, 0.007, 0.10, 8);
  bridgeGeo.rotateZ(Math.PI / 2);
  const bridge = new THREE.Mesh(bridgeGeo, metalMat);
  bridge.position.set(0, -0.008, 0);
  group.add(bridge);

  // Temple arms (left & right)
  const armGeo   = new THREE.BoxGeometry(0.24, 0.011, 0.011);
  const leftArm  = new THREE.Mesh(armGeo,        metalMat);
  const rightArm = new THREE.Mesh(armGeo.clone(), metalMat);
  leftArm.position.set(-0.295, 0, -0.06);
  leftArm.rotation.y = -0.18;
  rightArm.position.set(0.295, 0, -0.06);
  rightArm.rotation.y = 0.18;
  group.add(leftArm, rightArm);

  // Lens fill (subtle tinted glass)
  const lensFillMat = new THREE.MeshStandardMaterial({
    color:       0x1a2a3a,    // dark blue-grey tint instead of pure black
    transparent: true,
    opacity:     0.45,
    side:        THREE.DoubleSide,
    metalness:   0.1,
    roughness:   0.05,
  });

  if (style === 'round') {
    const fillGeo = new THREE.CircleGeometry(0.082, 32);
    const lFill   = new THREE.Mesh(fillGeo,        lensFillMat);
    const rFill   = new THREE.Mesh(fillGeo.clone(), lensFillMat);
    lFill.position.set(-0.175, 0, -0.002);
    rFill.position.set(0.175,  0, -0.002);
    group.add(lFill, rFill);
  } else if (style === 'aviator') {
    const fillGeo = new THREE.CircleGeometry(0.090, 6);
    const lFill   = new THREE.Mesh(fillGeo,        lensFillMat);
    const rFill   = new THREE.Mesh(fillGeo.clone(), lensFillMat);
    lFill.scale.set(0.85, 1.15, 1);
    rFill.scale.set(0.85, 1.15, 1);
    lFill.position.set(-0.175, 0, -0.002);
    rFill.position.set(0.175,  0, -0.002);
    group.add(lFill, rFill);
  } else {
    // Rectangular fill
    const fillGeo = new THREE.PlaneGeometry(0.19, 0.108);
    const lFill   = new THREE.Mesh(fillGeo,        lensFillMat);
    const rFill   = new THREE.Mesh(fillGeo.clone(), lensFillMat);
    lFill.position.set(-0.175, 0, -0.002);
    rFill.position.set(0.175,  0, -0.002);
    group.add(lFill, rFill);
  }

  return group;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODEL LOADING
// ─────────────────────────────────────────────────────────────────────────────
const gltfLoader = new GLTFLoader();

async function loadGlasses(catalogEntry) {
  if (modelCache.has(catalogEntry.id)) {
    return modelCache.get(catalogEntry.id);
  }

  if (catalogEntry.modelUrl) {
    return new Promise((resolve) => {
      gltfLoader.load(
        catalogEntry.modelUrl,
        (gltf) => {
          const model = gltf.scene;
          modelCache.set(catalogEntry.id, model);
          resolve(model);
        },
        undefined,
        (err) => {
          console.warn(`[VISAGE] GLB load failed for "${catalogEntry.id}", falling back to procedural.`, err);
          const proc = createProceduralGlasses(catalogEntry);
          modelCache.set(catalogEntry.id, proc);
          resolve(proc);
        }
      );
    });
  }

  // No URL provided — build procedural
  const proc = createProceduralGlasses(catalogEntry);
  modelCache.set(catalogEntry.id, proc);
  return proc;
}

async function setActiveGlasses(id) {
  const entry = GLASSES_CATALOG.find(g => g.id === id);
  if (!entry) return;

  state.currentGlassesId = id;

  // Clear existing children
  disposeGlassesGroup();

  // Update card UI
  document.querySelectorAll('.glasses-card').forEach(c => {
    c.classList.toggle('active', c.dataset.id === id);
  });

  showLoading(true);
  const model = await loadGlasses(entry);

  // Clone so we don't mutate shared cache
  const clone = model.clone(true);
  glassesGroup.add(clone);

  showLoading(false);
}

function disposeGlassesGroup() {
  const toRemove = [...glassesGroup.children];
  toRemove.forEach(child => {
    child.traverse(obj => {
      if (obj.isMesh) {
        obj.geometry?.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose());
        } else {
          obj.material?.dispose();
        }
      }
    });
    glassesGroup.remove(child);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MEDIAPIPE SETUP
// ─────────────────────────────────────────────────────────────────────────────
let faceMesh = null;

function initMediaPipe() {
  return new Promise((resolve, reject) => {
    faceMesh = new window.FaceMesh({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
    });

    faceMesh.setOptions({
      maxNumFaces:            1,
      refineLandmarks:        false,  // OFF — saves ~50% CPU per frame
      minDetectionConfidence: 0.5,
      minTrackingConfidence:  0.5,
    });

    faceMesh.onResults(onFaceMeshResults);

    faceMesh.initialize()
      .then(resolve)
      .catch(reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FACE TRACKING
// ─────────────────────────────────────────────────────────────────────────────
function onFaceMeshResults(results) {
  // Draw debug landmarks if enabled
  if (state.debugMode) drawDebugLandmarks(results);

  if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
    const landmarks = results.multiFaceLandmarks[0];

    // Face detected
    if (!state.faceDetected) {
      state.faceDetected = true;
      clearTimeout(state.faceLostTimer);
      showNoFaceUI(false);
      glassesGroup.visible = true;
    }

    updateGlassesTransform(landmarks);
  } else {
    // No face detected
    if (state.faceDetected) {
      state.faceDetected = false;
      state.faceLostTimer = setTimeout(() => {
        showNoFaceUI(true);
        // Fade out glasses over time
        glassesGroup.visible = false;
      }, FACE_LOST_TIMEOUT_MS);
    }
  }
}

function drawDebugLandmarks(results) {
  const ctx  = el.debugCanvas.getContext('2d');
  const w    = el.debugCanvas.width;
  const h    = el.debugCanvas.height;
  ctx.clearRect(0, 0, w, h);

  if (!results.multiFaceLandmarks) return;

  ctx.fillStyle = 'rgba(201, 168, 76, 0.7)';

  for (const landmarks of results.multiFaceLandmarks) {
    for (const lm of landmarks) {
      // Mirror x because video is mirrored
      const x = (1 - lm.x) * w;
      const y = lm.y * h;
      ctx.beginPath();
      ctx.arc(x, y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSFORM UPDATE
// ─────────────────────────────────────────────────────────────────────────────
function updateGlassesTransform(landmarks) {
  const leftEye    = landmarkToWorld(landmarks[LM.LEFT_EYE]);
  const rightEye   = landmarkToWorld(landmarks[LM.RIGHT_EYE]);
  const noseBridge = landmarkToWorld(landmarks[LM.NOSE_BRIDGE]);
  const leftTemple = landmarkToWorld(landmarks[LM.LEFT_TEMPLE]);
  const rightTemple= landmarkToWorld(landmarks[LM.RIGHT_TEMPLE]);

  // Position: midpoint between the two eyes, nudged slightly down to nose-bridge level
  const center = new THREE.Vector3()
    .addVectors(leftEye, rightEye)
    .multiplyScalar(0.5);

  center.y += GLASSES_Y_OFFSET;
  // Z is already set by landmarkToWorld to GLASSES_Z_OFFSET

  target.position.copy(center);

  // Scale: inter-eye distance × multiplier => glasses span the face width
  const eyeDist     = leftEye.distanceTo(rightEye);
  const scaleFactor = eyeDist * GLASSES_SCALE_MULTIPLIER;
  target.scale.setScalar(Math.max(scaleFactor, 0.01));

  // Roll: in-plane tilt between L and R eye
  const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);

  // Yaw: estimate head turn from ratio of visible eye-span vs temple-span
  const templeWidth = rightTemple.x - leftTemple.x;
  const eyeWidth    = rightEye.x    - leftEye.x;
  const yaw = (Math.abs(templeWidth) > 0.001)
    ? Math.atan2(eyeWidth - templeWidth, Math.abs(templeWidth)) * 0.3
    : 0;

  // Pitch: how much higher is the nose bridge than the eye center (Y only — ortho z is flat)
  const pitch = Math.atan2(noseBridge.y - center.y, 0.4) * 0.3;

  target.rotation.set(pitch, yaw, -roll);

  // Apply lerp / slerp
  glassesGroup.position.lerp(target.position, LERP_FACTOR);
  glassesGroup.scale.lerp(target.scale, LERP_FACTOR);

  const tQuat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(target.rotation.x, target.rotation.y, target.rotation.z, 'XYZ')
  );
  glassesGroup.quaternion.slerp(tQuat, LERP_FACTOR);
}

// ─────────────────────────────────────────────────────────────────────────────
// ANIMATION LOOP
// ─────────────────────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();

  // FPS counter
  state.frameCount++;
  state.fpsTimer += delta;
  if (state.fpsTimer >= 0.5) {
    state.fps = Math.round(state.frameCount / state.fpsTimer);
    el.fpsDisplay.textContent = state.fps;
    state.frameCount = 0;
    state.fpsTimer   = 0;
  }

  // Debug stats
  if (state.debugMode) {
    const info = renderer.info;
    el.triCount.textContent = info.render.triangles;
    el.objCount.textContent = info.render.calls;
  }

  renderer.render(scene, camera);
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA INITIALIZATION
// ─────────────────────────────────────────────────────────────────────────────
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width:      { ideal: 1280 },
        height:     { ideal: 720 },
      },
      audio: false,
    });

    state.cameraStream = stream;
    el.webcam.srcObject = stream;

    await new Promise((res) => { el.webcam.onloadedmetadata = res; });
    await el.webcam.play();

    // Sync canvas sizes with video
    const w = el.webcam.videoWidth  || window.innerWidth;
    const h = el.webcam.videoHeight || window.innerHeight;
    el.debugCanvas.width  = w;
    el.debugCanvas.height = h;

    return true;
  } catch (err) {
    console.error('[VISAGE] Camera error:', err);
    return false;
  }
}

// Offscreen canvas used to downsample video before sending to MediaPipe
const mpCanvas  = document.createElement('canvas');
const mpCtx     = mpCanvas.getContext('2d', { willReadFrequently: false });
mpCanvas.width  = MP_PROCESS_W;
mpCanvas.height = MP_PROCESS_H;

async function startMpCamera() {
  const mpInterval = Math.round(1000 / MEDIAPIPE_FPS);
  let lastSend  = 0;
  let isSending = false;   // guard: never queue more than one send
  let rafHandle = null;
  let running   = true;

  function sendFrame() {
    if (!running) return;
    const now = performance.now();

    if (!isSending && now - lastSend >= mpInterval && el.webcam.readyState >= 2) {
      lastSend  = now;
      isSending = true;
      // Draw 480×270 copy — 7× fewer pixels than 1280×720
      mpCtx.drawImage(el.webcam, 0, 0, MP_PROCESS_W, MP_PROCESS_H);
      // Fire and forget — results arrive async via onFaceMeshResults
      faceMesh.send({ image: mpCanvas }).finally(() => { isSending = false; });
    }

    rafHandle = requestAnimationFrame(sendFrame);
  }

  state.mpCamera = {
    stop: () => {
      running = false;
      if (rafHandle) cancelAnimationFrame(rafHandle);
    },
  };

  sendFrame();
}

// ─────────────────────────────────────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function showOverlay(id, visible) {
  const elem = document.getElementById(id);
  if (!elem) return;
  elem.classList.toggle('active', visible);
  elem.classList.toggle('hidden', !visible && !elem.classList.contains('active'));
  if (visible) {
    elem.classList.remove('hidden');
    // Force reflow to trigger transition
    void elem.offsetWidth;
    elem.classList.add('active');
  } else {
    elem.classList.remove('active');
    setTimeout(() => elem.classList.add('hidden'), 550);
  }
}

function showLoading(visible) {
  if (visible) {
    el.loadingScreen.classList.remove('hidden');
    void el.loadingScreen.offsetWidth;
    el.loadingScreen.classList.add('active');
  } else {
    el.loadingScreen.classList.remove('active');
    setTimeout(() => el.loadingScreen.classList.add('hidden'), 550);
  }
}

function showAppUI(visible) {
  const uiEls = [el.appHeader, el.glassesPanel, el.actionButtons];
  uiEls.forEach(e => {
    if (visible) {
      e.classList.remove('hidden');
    } else {
      e.classList.add('hidden');
    }
  });
}

function showNoFaceUI(visible) {
  el.noFaceLabel.classList.toggle('hidden', !visible);
  el.noFaceBorder.classList.toggle('hidden', !visible);
}

function buildGlassesSelector() {
  el.glassesRow.innerHTML = '';

  GLASSES_CATALOG.forEach(entry => {
    const card = document.createElement('button');
    card.className  = 'glasses-card' + (entry.id === state.currentGlassesId ? ' active' : '');
    card.dataset.id = entry.id;
    card.innerHTML  = `
      <span class="card-thumb">${entry.thumbnail}</span>
      <span class="card-name">${entry.name}</span>
    `;
    card.addEventListener('click', () => setActiveGlasses(entry.id));
    el.glassesRow.appendChild(card);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHOTO CAPTURE
// ─────────────────────────────────────────────────────────────────────────────
function capturePhoto() {
  const w = el.webcam.videoWidth  || window.innerWidth;
  const h = el.webcam.videoHeight || window.innerHeight;

  const offscreen = document.createElement('canvas');
  offscreen.width  = w;
  offscreen.height = h;
  const ctx = offscreen.getContext('2d');

  // Mirror flip for video
  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(el.webcam, 0, 0, w, h);
  ctx.restore();

  // Draw Three.js overlay
  ctx.drawImage(el.threeCanvas, 0, 0, w, h);

  // Trigger download
  offscreen.toBlob(blob => {
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href     = url;
    link.download = 'visage-try-on.png';
    link.click();
    URL.revokeObjectURL(url);
  }, 'image/png');

  // Shutter flash effect
  el.shutterFlash.classList.remove('hidden');
  el.shutterFlash.classList.add('flashing');
  setTimeout(() => {
    el.shutterFlash.classList.remove('flashing');
    el.shutterFlash.classList.add('hidden');
  }, 500);
}

// ─────────────────────────────────────────────────────────────────────────────
// STOP & RESET
// ─────────────────────────────────────────────────────────────────────────────
function stopCamera() {
  if (state.mpCamera) {
    state.mpCamera.stop();
    state.mpCamera = null;
  }
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach(t => t.stop());
    state.cameraStream = null;
  }
  el.webcam.srcObject = null;
  state.isRunning = false;

  glassesGroup.visible = false;
  showNoFaceUI(false);
  showAppUI(false);
  showOverlay('startScreen', true);
}

function resetGlasses() {
  glassesGroup.position.set(0, 0, 0);
  glassesGroup.scale.setScalar(1);
  glassesGroup.quaternion.identity();
  // Reload current glasses
  setActiveGlasses(state.currentGlassesId);
}

// ─────────────────────────────────────────────────────────────────────────────
// DEBUG TOGGLE
// ─────────────────────────────────────────────────────────────────────────────
function toggleDebug() {
  state.debugMode = !state.debugMode;
  el.debugCanvas.style.display  = state.debugMode ? 'block' : 'none';
  el.debugStats.classList.toggle('hidden', !state.debugMode);
  el.debugBadge.classList.toggle('hidden', !state.debugMode);
}

// ─────────────────────────────────────────────────────────────────────────────
// UI HANDLERS
// ─────────────────────────────────────────────────────────────────────────────
function bindUIHandlers() {
  el.startBtn.addEventListener('click', onStartClick);
  el.retryBtn.addEventListener('click', onStartClick);
  el.captureBtn.addEventListener('click', capturePhoto);
  el.resetBtn.addEventListener('click', resetGlasses);
  el.stopBtn.addEventListener('click', stopCamera);

  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === DEBUG_KEY) toggleDebug();
  });
}

async function onStartClick() {
  // Hide start / error screens
  showOverlay('startScreen', false);
  showOverlay('errorScreen', false);

  // Show loading
  showLoading(true);

  // Start camera
  const cameraOk = await startCamera();
  if (!cameraOk) {
    showLoading(false);
    showOverlay('errorScreen', true);
    return;
  }

  // Initialize MediaPipe (re-use if already initialized)
  if (!faceMesh) {
    try {
      await initMediaPipe();
    } catch (err) {
      console.error('[VISAGE] MediaPipe init failed:', err);
      showLoading(false);
      showOverlay('errorScreen', true);
      return;
    }
  }

  // Load default glasses
  buildGlassesSelector();
  await setActiveGlasses(state.currentGlassesId);

  // Start MediaPipe camera feed
  await startMpCamera();

  state.isRunning = true;
  showLoading(false);
  showAppUI(true);

  // Initially show no-face UI until detected
  showNoFaceUI(true);
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
function init() {
  initThree();
  bindUIHandlers();
  animate();

  // Hide debug canvas initially
  el.debugCanvas.style.display = 'none';

  // Expose debug object
  window.VirtualTryOn = {
    state,
    target,
    modelCache,
    scene,
    renderer,
    camera,
    glassesGroup,
    toggleDebug,
    setActiveGlasses,
    GLASSES_CATALOG,
  };

  console.log('[VISAGE] Ready. Press "D" to toggle debug mode.');
}

init();
