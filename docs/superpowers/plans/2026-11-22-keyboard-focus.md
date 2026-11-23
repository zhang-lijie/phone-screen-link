# Keyboard Focus Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the mirrored phone's keyboard control yield to text fields automatically, so typing in the chat panel (or any settings input) stays in the browser instead of driving the phone.

**Architecture:** A source patch on the vendored ws-scrcpy engine's `KeyInputHandler.handler` returns early when the event target is an editable element, so no key control message is sent and `preventDefault()` is skipped. The patch is declared in `scripts/setup.mjs` alongside the existing loopback/wheel/audio patches, then applied to the already-built engine and rebuilt.

**Tech Stack:** Node ESM, `node:test`, the vendored `ws-scrcpy-web` v0.5.13 engine (TypeScript, compiled to `dist/`).

**Spec:** `docs/superpowers/specs/2026-11-22-keyboard-focus-design.md`

## Global Constraints

- Engine is an external, gitignored dependency; all engine changes must be reproducible from `scripts/setup.mjs` patches.
- Never send phone key events for keys typed into an editable element.
- Preserve existing `keydown`/`keyup`, `event.repeat`, modifier-state, and `preventDefault()` behavior for non-editable targets.
- No new frontend/backend interfaces; no explicit chat open/close state machine.

## Review Focus

- `contentEditable` element (not just `<input>`) must also yield the keyboard — test in Task 1 by including `isContentEditable` in the patch's `to`.
- `keyup` must be skipped too, otherwise a stuck key can be left on the phone — test in Task 1 via the shared handler early-return.
- `preventDefault()` must NOT run for editable targets, or the chat input cannot receive characters — verified in Task 2 browser test.
- Focus returning to the mirrored screen must restore phone control — verified in Task 2 browser test.
- Existing engine patches (loopback/wheel/audio/resize) must keep applying — Task 1 runs the full test suite.

---

### Task 1: Declare and test the keyboard-focus patch

**Files:**
- Modify: `scripts/setup.mjs` (add `KEYBOARD_FOCUS_PATCH` export; call it in `applyEnginePatches`)
- Test: `tests/setup.test.mjs`

**Interfaces:**
- Consumes: `applyPatch` (module-private in `scripts/setup.mjs`), the patch object shape `{ file, from, to }` used by `LOOPBACK_PATCH`.
- Produces: exported `KEYBOARD_FOCUS_PATCH` with `file = 'src/app/googDevice/KeyInputHandler.ts'`; `applyEnginePatches()` applies it.

- [ ] **Step 1: Write the failing test**

In `tests/setup.test.mjs`, import `KEYBOARD_FOCUS_PATCH` and add a test asserting:
- `KEYBOARD_FOCUS_PATCH.file === 'src/app/googDevice/KeyInputHandler.ts'`
- `KEYBOARD_FOCUS_PATCH.from` matches `private static handler = (event: Event): void =>` and `KeyToCodeMap.get(keyboardEvent.code)`
- `KEYBOARD_FOCUS_PATCH.to` matches `isContentEditable`, `INPUT`, `TEXTAREA`, `SELECT`, and `return;`

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `KEYBOARD_FOCUS_PATCH is not exported`.

- [ ] **Step 3: Implement the patch constant and wire it in**

In `scripts/setup.mjs`:
- Export `KEYBOARD_FOCUS_PATCH` with `from` = the first three lines of `KeyInputHandler.handler` (`private static handler = ...`, `const keyboardEvent = ...`, `const keyCode = KeyToCodeMap.get(keyboardEvent.code);`).
- `to` = same lines with an early-return inserted between `keyboardEvent` and `keyCode`: check `keyboardEvent.target instanceof HTMLElement` and `isContentEditable || tagName === 'INPUT' || 'TEXTAREA' || 'SELECT'`, then `return;`.
- Add `applyPatch(KEYBOARD_FOCUS_PATCH, 'keyboard focus handoff');` in `applyEnginePatches()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: all tests pass (including existing setup patch tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/setup.mjs tests/setup.test.mjs
git commit -m "feat: patch engine to yield keyboard to focused text fields"
```

---

### Task 2: Apply the patch to the built engine and verify end to end

**Files:**
- Modify (generated, gitignored): `engine/src/app/googDevice/KeyInputHandler.ts`, `engine/dist/` via rebuild
- No tracked source changes expected.

**Interfaces:**
- Consumes: `KEYBOARD_FOCUS_PATCH` from Task 1; existing `npm run build` in the engine checkout.

- [ ] **Step 1: Apply the patch to the existing engine source**

Run a one-off Node script from the worktree that imports `KEYBOARD_FOCUS_PATCH` and performs the same replace as `applyPatch` against `engine/src/app/googDevice/KeyInputHandler.ts`. Confirm the file now contains `isContentEditable`.

- [ ] **Step 2: Rebuild the engine**

Run: `npm run build` in the engine directory.
Expected: build succeeds and `dist/` contains the new guard text.

- [ ] **Step 3: Restart the app and verify in the browser**

Restart `npm start`, open the page, open the chat panel, type into `#chat-input`, and confirm:
- Characters appear in the input (no `preventDefault()` swallow).
- The phone does not react to those keystrokes.
Then close the chat panel, click the mirrored screen, and send a key (e.g. Back) — confirm the phone reacts.

- [ ] **Step 4: Final test run**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit (if any tracked files changed)**

Only if source files changed; otherwise record the verification in the session.
