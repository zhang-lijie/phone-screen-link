# Fill Stream Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scale the mirrored picture to the floating-mode container while preserving aspect ratio and touch coordinate mapping.

**Architecture:** A pure sizing helper in `shared/device-ui.mjs` computes the fitted CSS size; `web/app.js` applies it to both stacked canvases on connect, resize, and visibility changes.

**Tech Stack:** Node ESM pure function + browser DOM wiring; `node --test` and static UI source checks.

**Spec:** `docs/superpowers/specs/2026-11-27-fill-stream-canvas-design.md`

## Global Constraints

- `#stream` container CSS is unchanged; only canvas CSS sizes are adjusted.
- Keep the touch layer and video layer boxes identical at all times.
- Do not enable upstream `fitToScreen` (would require re-encode and reconnect on resize).
- No backend changes.

## Review Focus

- Touch mapping: if the video and touch canvases get different CSS boxes, taps land in the wrong place.
- Very small or very large containers: the picture must shrink/grow without overflowing or distorting.
- Frames arriving before metadata (intrinsic 300x150) must not cause a weird permanent size.

---

### Task 1: Fit the canvas to the available area

**Files:** `shared/device-ui.mjs`, `web/app.js`, `tests/device-ui.test.mjs`, `tests/ui-layout.test.mjs`

**Interfaces:**
- `fitCanvasSize({ width, height, availableWidth, availableHeight })` → `{ width, height } | null`
- `fitStreamCanvas()` in `web/app.js` uses it and writes both canvas styles.

- [ ] **Step 1: Write failing tests** for upscale, downscale, aspect preservation, zero-size guard, and UI wiring (`onConnect`, `onResize`, `window.resize`).
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement** the pure helper and the DOM wiring.
- [ ] **Step 4: Run `npm test`** — all suites green.
- [ ] **Step 5: Sync to the live install and verify** in a headless browser at 800×600 and 3840×2160 that both canvases have equal rects close to the `.video` cell.
- [ ] **Step 6: Commit** `feat(ui): scale the mirrored picture to the container`.
