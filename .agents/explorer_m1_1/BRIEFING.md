# BRIEFING — 2026-07-26T12:17:30Z

## Mission
Thoroughly examine `app.js` to locate landmark processing, face fitting, 3D model positioning, Landmark 6, and temple width scaling (1.15 scale factor), and determine test extraction strategy for Node.js unit testing.

## 🔒 My Identity
- Archetype: Explorer 1
- Roles: Explorer / Analyst
- Working directory: d:\Luceandombra\.agents\explorer_m1_1
- Original parent: 3480cfbd-98ed-414c-a75e-01e1a077bece
- Milestone: M1 / Landmark & Face Fitting Analysis

## 🔒 Key Constraints
- Read-only investigation — do NOT implement changes to app.js
- Keep analysis grounded in exact line numbers and code excerpts
- Output handoff.md following 5-component handoff structure

## Current Parent
- Conversation ID: 3480cfbd-98ed-414c-a75e-01e1a077bece
- Updated: 2026-07-26T12:17:30Z

## Investigation State
- **Explored paths**: `d:\Luceandombra\app.js`, `index.html`, `package.json`, `test.js`
- **Key findings**:
  - `app.js` is structured as a top-level browser ES module (loaded via `<script type="module" src="app.js?v=21">`).
  - MediaPipe landmark processing uses `@mediapipe/tasks-vision` FilesetResolver/FaceLandmarker with `outputFacialTransformationMatrixes` and `outputFaceBlendshapes`.
  - Landmark 6 is defined as `LM.NOSE_REST: 6` (line 64) and used as the 3D position anchor in `onFaceResults()` (lines 749-758).
  - Temple width scaling uses `LM.L_TEMPLE` (234) and `LM.R_TEMPLE` (454) with formula `templeW = landmarkToWorld(lt).distanceTo(landmarkToWorld(rt))` and scale factor `rawScale = templeW * 1.15` (line 729).
  - Module currently executes top-level DOM queries (`el` object) and auto-invokes `init()` at line 1614, preventing direct import in Node.js without side-effects.
- **Unexplored areas**: None for M1 analysis scope.

## Key Decisions Made
- Fully documented all scaling, positioning, filter, and landmark math with verbatim line numbers.
- Proposed clean extraction / export strategies (dual-export + DOM initialization guard or modular extraction into `fittingMath.js`).

## Artifact Index
- ORIGINAL_REQUEST.md — Original task prompt
- BRIEFING.md — Working memory index
- progress.md — Liveness heartbeat and step-by-step log
- handoff.md — Final analysis report
