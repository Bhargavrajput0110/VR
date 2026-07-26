/**
 * fittingMath.js - Luceandombra Virtual Try-On Math & Calibration Module
 * 
 * Provides landmark validation, coordinate mapping, 3D fitting math, and filtering.
 * Dual-compatible with ESM (browser/node) and CommonJS/global environments.
 */

const LM = {
  // Core eye anchors
  L_EYE_INNER:   133,   // left  inner canthus
  R_EYE_INNER:   362,   // right inner canthus
  L_IRIS:        468,   // left  iris center
  R_IRIS:        473,   // right iris center
  L_EYE_OUTER:    33,   // left  outer canthus
  R_EYE_OUTER:   263,   // right outer canthus
  L_EYE_TOP:     159,   // left  upper eyelid mid
  R_EYE_TOP:     386,   // right upper eyelid mid
  L_EYE_BOT:     145,   // left  lower eyelid mid
  R_EYE_BOT:     374,   // right lower eyelid mid

  // Nose
  NOSE_BRIDGE:   168,   // glabella / nose bridge top
  NOSE_REST:       6,   // lower nose bridge (where physical glasses sit)
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
  CHEEK_L:       234,   // cheekbone left
  CHEEK_R:       454,   // cheekbone right

  // Mouth
  L_MOUTH:        61,
  R_MOUTH:       291,
};

/**
 * Validates a landmark object for finite numbers within normalized [0, 1] range.
 * @param {Object} lm 
 * @returns {boolean}
 */
function lmValid(lm) {
  return !!(
    lm &&
    typeof lm.x === 'number' && Number.isFinite(lm.x) &&
    typeof lm.y === 'number' && Number.isFinite(lm.y) &&
    typeof lm.z === 'number' && Number.isFinite(lm.z) &&
    lm.x >= 0 && lm.x <= 1 &&
    lm.y >= 0 && lm.y <= 1
  );
}

/**
 * Safely extracts landmark at specified index if valid.
 * @param {Array} lmArray 
 * @param {number} idx 
 * @returns {Object|null}
 */
function safeLM(lmArray, idx) {
  if (!lmArray || idx < 0 || idx >= lmArray.length) return null;
  const lm = lmArray[idx];
  return lmValid(lm) ? lm : null;
}

/**
 * Maps normalized face landmark coordinates (0..1) to 3D world coordinates.
 * Flips x horizontally via (1.0 - lm.x) for camera mirroring.
 * @param {Object} lm - Landmark { x, y, z }
 * @param {Object} [viewportOptions] - { width, height, videoWidth, videoHeight }
 * @param {number} [zOverride] - Optional override for Z coordinate
 * @returns {Object} 3D position object { x, y, z, distanceTo }
 */
function landmarkToWorld(lm, viewportOptions = {}, zOverride = undefined) {
  if (typeof viewportOptions === 'number') {
    zOverride = viewportOptions;
    viewportOptions = {};
  }

  if (!lmValid(lm)) {
    return {
      x: 0, y: 0, z: zOverride ?? 0.05,
      distanceTo(other) {
        if (!other) return 0;
        const dx = this.x - (other.x ?? 0);
        const dy = this.y - (other.y ?? 0);
        const dz = this.z - (other.z ?? 0);
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
    };
  }

  let w = viewportOptions.width;
  let h = viewportOptions.height;
  let vw = viewportOptions.videoWidth;
  let vh = viewportOptions.videoHeight;

  if (!w || !h) {
    if (typeof window !== 'undefined') {
      w = w || window.innerWidth;
      h = h || window.innerHeight;
    } else {
      w = w || 1280;
      h = h || 720;
    }
  }

  if (!vw || !vh) {
    if (typeof document !== 'undefined') {
      const webcam = document.getElementById('webcam');
      if (webcam) {
        vw = vw || webcam.videoWidth || w;
        vh = vh || webcam.videoHeight || h;
      }
    }
    vw = vw || w;
    vh = vh || h;
  }

  const windowAspect = w / h;
  const videoAspect  = vw / vh;
  const scale        = windowAspect > videoAspect ? w / vw : h / vh;

  const rvw  = vw * scale;
  const rvh  = vh * scale;
  const offX = (w - rvw) / 2;
  const offY = (h - rvh) / 2;

  // Horizontal mirroring transformation: (1.0 - lm.x)
  const px = offX + (1.0 - lm.x) * rvw;
  const py = offY + lm.y * rvh;

  const halfW = windowAspect;
  const worldX =  (px / w) * (2 * halfW) - halfW;
  const worldY = -((py / h) * 2 - 1);
  const worldZ = zOverride !== undefined ? zOverride : (lm.z !== undefined ? lm.z : 0.05);

  return {
    x: worldX,
    y: worldY,
    z: worldZ,
    distanceTo(other) {
      if (!other) return 0;
      const dx = this.x - (other.x ?? 0);
      const dy = this.y - (other.y ?? 0);
      const dz = this.z - (other.z ?? 0);
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
  };
}

/**
 * Calculates 3D model scale and position based on facial landmarks.
 * Scale matches templeW * 1.15 (temple-based width anchoring).
 * Position origin matches Landmark 6 (NOSE_REST).
 * @param {Array} lmArray - Landmark array
 * @param {Object} [viewportOptions] - { width, height, videoWidth, videoHeight }
 * @param {Object} [filterState] - { scaleFilter, posFilters: {x, y, z}, timestamp }
 * @returns {Object|null} { scale, position: {x, y, z}, templeW, anchorWorld }
 */
function calculateScaleAndPosition(lmArray, viewportOptions = {}, filterState = {}) {
  const lt = safeLM(lmArray, LM.L_TEMPLE);
  const rt = safeLM(lmArray, LM.R_TEMPLE);
  const hasIris = lmArray && lmArray.length >= 478;
  const li = safeLM(lmArray, hasIris ? LM.L_IRIS : LM.L_EYE_INNER);
  const ri = safeLM(lmArray, hasIris ? LM.R_IRIS : LM.R_EYE_INNER);

  if (!lt || !rt || !li || !ri) return null;

  const ltWorld = landmarkToWorld(lt, viewportOptions);
  const rtWorld = landmarkToWorld(rt, viewportOptions);

  const templeW = ltWorld.distanceTo(rtWorld);
  const rawScale = templeW * 1.15;

  let filteredScale = rawScale;
  if (filterState && filterState.scaleFilter && typeof filterState.scaleFilter.filter === 'function') {
    filteredScale = filterState.scaleFilter.filter(rawScale, filterState.timestamp);
  }
  const scale = Math.max(filteredScale, 0.01);

  const nr = safeLM(lmArray, LM.NOSE_REST);
  if (!nr) return null;

  const anchorWorld = landmarkToWorld(nr, viewportOptions);

  const depthFactor = Math.max(0.5, Math.min(1.5, 1.0 / (scale * 4 + 0.001)));
  const localOffsetZ = -scale * 0.02 * depthFactor;

  const rawX = anchorWorld.x;
  const rawY = anchorWorld.y;
  const rawZ = anchorWorld.z + localOffsetZ;

  let filteredX = rawX;
  let filteredY = rawY;
  let filteredZ = rawZ;

  if (filterState && filterState.posFilters) {
    if (filterState.posFilters.x && typeof filterState.posFilters.x.filter === 'function') {
      filteredX = filterState.posFilters.x.filter(rawX, filterState.timestamp);
    }
    if (filterState.posFilters.y && typeof filterState.posFilters.y.filter === 'function') {
      filteredY = filterState.posFilters.y.filter(rawY, filterState.timestamp);
    }
    if (filterState.posFilters.z && typeof filterState.posFilters.z.filter === 'function') {
      filteredZ = filterState.posFilters.z.filter(rawZ, filterState.timestamp);
    }
  }

  return {
    scale,
    position: { x: filteredX, y: filteredY, z: filteredZ },
    templeW,
    anchorWorld
  };
}

/**
 * ONE EURO FILTER - removes jitter without introducing lag.
 * Reference: Géry Casiez et al., "1€ Filter" CHI 2012
 */
class OneEuroFilter {
  constructor(freq = 30, minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.freq      = freq;
    this.minCutoff = minCutoff;
    this.beta      = beta;
    this.dCutoff   = dCutoff;
    this._x        = null;
    this._dx       = 0;
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

    const rawDx   = (x - this._x) * this.freq;
    const alphaDx = this._alpha(this.dCutoff);
    this._dx      = alphaDx * rawDx + (1 - alphaDx) * this._dx;

    const cutoff  = this.minCutoff + this.beta * Math.abs(this._dx);
    const alpha   = this._alpha(cutoff);
    this._x       = alpha * x + (1 - alpha) * this._x;
    return this._x;
  }

  reset() { this._x = null; this._dx = 0; this._lastTime = null; }
}

export {
  LM,
  lmValid,
  safeLM,
  landmarkToWorld,
  calculateScaleAndPosition,
  OneEuroFilter
};
