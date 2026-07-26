# Project: Luceandombra AR Test Suite

## Architecture
- Target AR app: `app.js` (MediaPipe face landmarks -> 3D glasses model positioning/scaling in Three.js).
- Test Suite: Automated JS test runner (e.g. Jest or Node test runner) executing unit & integration tests against face landmark transformation math.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Exploration & Architecture Analysis | Inspect app.js, identify landmark math functions (Landmark 6, temple width scaling), evaluate testability | none | DONE |
| 2 | Test Infrastructure & Math Module (R1) | Extract math module fittingMath.js, update app.js, add `npm test` script in package.json | M1 | IN_PROGRESS |
| 3 | Accuracy Verification Tests (R2) | Implement unit/integration tests in tests/accuracy.test.js asserting Landmark 6 origin and 1.15 temple width scale | M2 | IN_PROGRESS |
| 4 | E2E & Hardening Verification | Run complete test suite, verify test output, run challengers & forensic audit | M3 | PLANNED |

## Interface Contracts
### Landmark Transformation Math
- Landmark 6 (Nose bridge / nose rest): 3D origin position `(x, y, z)` matching Landmark 6 transformation.
- Temple Width / Bounding Box scale: 3D scale matching `temple_width * 1.15`.
- Core functions in `app.js` need to be accessible/exported or modularized for node/test environment testing.

## Code Layout
- `app.js`: AR tracking logic, MediaPipe integration, Three.js rendering.
- `package.json`: Project dependencies and test runner script `npm test`.
- `tests/`: Automated test suite directory containing accuracy tests for positioning and scaling.
