# Original User Request

## Initial Request — 2026-07-26T12:16:04Z

> Status: Ready for launch — awaiting user approval
> Goal: Craft prompt → get user approval → delegate to teamwork_preview

Build an automated testing suite for the AR application that verifies accurate face lining, face detection precision, and 3D glasses positioning.

Working directory: d:\Luceandombra
Integrity mode: demo

## Requirements

### R1. Automated Test Runner
The testing suite must be capable of executing automated tests against the core AR tracking algorithms, specifically evaluating the accuracy of the nose-centric anchoring and the temple-width scaling logic.

### R2. Face Detection & Lining Precision Tests
The tests must verify that the 3D model's origin perfectly aligns with the provided facial landmarks (e.g., Landmark 6 for the nose rest) and that the scale accurately maps to the facial bounding box/temple width.

## Acceptance Criteria

### Testing Infrastructure
- [ ] A test runner (e.g., Jest, Playwright, or similar) is successfully installed and configured.
- [ ] The test suite can be executed via a standard `npm run test` (or equivalent) command and outputs clear pass/fail results.

### Accuracy Verification
- [ ] At least one automated test script exists that feeds mocked MediaPipe landmark data to the core scaling/positioning functions in `app.js`.
- [ ] The tests assert that the resulting 3D coordinates mathematically match the expected transformations (e.g., 3D origin matches the nose rest landmark, and scale matches temple width * 1.15).
