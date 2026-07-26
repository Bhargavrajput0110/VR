# BRIEFING — 2026-07-26T17:50:00Z

## Mission
Analyze MediaPipe landmark handling, 3D position/scale transformation formulas, temple indices, landmark structure, and test mocking/assertions in `app.js`.

## 🔒 My Identity
- Archetype: explorer
- Roles: Explorer 3
- Working directory: `d:\Luceandombra\.agents\explorer_m1_3`
- Original parent: 3480cfbd-98ed-414c-a75e-01e1a077bece
- Milestone: milestone_1

## 🔒 Key Constraints
- Read-only investigation — do NOT modify source code files outside `.agents/explorer_m1_3`
- Must document observations with exact file paths and line numbers
- Must include verification method in handoff report

## Current Parent
- Conversation ID: 3480cfbd-98ed-414c-a75e-01e1a077bece
- Updated: 2026-07-26T17:50:00Z

## Investigation State
- **Explored paths**: `d:\Luceandombra\app.js` (lines 1-1615)
- **Key findings**:
  - MediaPipe landmark object structure: Array of 468 (or 478) objects with `{ x: number [0..1], y: number [0..1], z: number }`.
  - Landmark 6 (`LM.NOSE_REST = 6`): Lower nose bridge anchor point for 3D glasses position.
  - Left Temple index: `234` (`LM.L_TEMPLE = 234`).
  - Right Temple index: `454` (`LM.R_TEMPLE = 454`).
  - Scale formula: `rawScale = templeW * 1.15` where `templeW` is the 3D world distance between Left Temple (`LM.L_TEMPLE`) and Right Temple (`LM.R_TEMPLE`).
  - Position formula: `landmarkToWorld(NOSE_REST)` + local depth offset (`Vector3(0, 0, -filteredScale * 0.02 * depthFactor)`), smoothed via One Euro Filter `OEF.x`, `OEF.y`, `OEF.z`.
  - Coordinate conversion: `landmarkToWorld` mirrors X (`px = offX + (1.0 - lm.x) * rvw`) and transforms to Orthographic camera clip space `worldX = (px / w) * (2 * halfW) - halfW`, `worldY = -((py / h) * 2 - 1)`.
- **Unexplored areas**: None, all 6 items of assignment completed.

## Key Decisions Made
- Fully documented landmark reception, exact data structures, math formulas, mock data creation pattern, and assertions for R2 test suite.

## Artifact Index
- `d:\Luceandombra\.agents\explorer_m1_3\ORIGINAL_REQUEST.md` — User request copy
- `d:\Luceandombra\.agents\explorer_m1_3\BRIEFING.md` — Briefing file
- `d:\Luceandombra\.agents\explorer_m1_3\progress.md` — Progress log
- `d:\Luceandombra\.agents\explorer_m1_3\handoff.md` — Detailed handoff report
