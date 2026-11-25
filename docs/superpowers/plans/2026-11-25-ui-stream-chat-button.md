# Stream Minimum Width and Chat Dock Button State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the stream area at least 400px in both normal and docked layouts, and color the chat dock button white when floating/available and green when docked.

**Architecture:** Keep layout constraints in CSS, keep the splitter's numeric floor in `shared/keys.mjs`, and expose the docked state through the existing `body.chat-docked` class plus `aria-pressed`. A small tracked source-contract test provides RED→GREEN coverage; real-browser checks verify computed styles and dragging.

**Tech Stack:** Plain HTML/CSS/JavaScript, Node ESM, `node:test`, browse-driven Chrome verification.

**Spec:** `docs/superpowers/specs/2026-11-25-ui-stream-chat-button-design.md`

## Global Constraints

- Normal and docked `#stream` minimum width is exactly `400px`.
- `MIN_DOCK_STREAM` is `400`; `MIN_DOCK_CHAT` remains `240`.
- Floating/enabled dock button is `#fff`; docked is `#10b981`; disabled remains muted with `opacity: 0.4`.
- Dock-button SVG uses `fill: currentColor`.
- Do not change stream resolution, chat positioning, split-ratio persistence, or engine layout.

## Review Focus

- Viewport narrower than 400px: the stream must still request 400px rather than silently collapsing — Task 2 source-contract test and browser computed-style check.
- Docked splitter dragged hard left: stream width stops at 400px and chat keeps 240px — Task 1 boundary tests and Task 2 browser drag check.
- Dock button disabled below 720px: white/green rules must not override the muted disabled appearance — Task 2 selector test and browser resize check.
- Dock icon must actually inherit the button color instead of rendering default black — Task 2 `fill: currentColor` assertion and browser color check.
- `aria-pressed` must follow docking and undocking, not just the initial HTML — Task 2 source-contract test and browser state checks.

---

### Task 1: Lower the docked stream floor to 400px

**Files:**
- Modify: `shared/keys.mjs`
- Modify: `web/app.js` (correct the dock-width comment)
- Test: `tests/shared-keys.test.mjs`

**Interfaces:**
- Consumes: existing `clampDockStreamWidth(requested, available)` and constants `MIN_DOCK_STREAM`, `MIN_DOCK_CHAT`.
- Produces: `MIN_DOCK_STREAM === 400`; `clampDockStreamWidth()` returns 400 for requests below the floor and preserves the 240px chat reserve.

- [ ] **Step 1: Write the failing test**

Rename the splitter test and update its assertions:

```js
test('chat dock splitter: clamp stream width to 400 min and chat 240 min', () => {
  assert.equal(clampDockStreamWidth(399, 1200), 400, 'below min lifts to 400');
  assert.equal(clampDockStreamWidth(400, 1200), 400, 'exact min is preserved');
  assert.equal(clampDockStreamWidth(900, 1200), 900, 'within range untouched');
  assert.equal(clampDockStreamWidth(2000, 1200), 960, 'above max leaves 240 for chat');
  assert.equal(clampDockStreamWidth(100, 600), 400, 'too-narrow stage still keeps 400');
  assert.ok(clampDockStreamWidth(700, 1200) >= 400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/shared-keys.test.mjs`
Expected: FAIL — requests below 450 still return 450.

- [ ] **Step 3: Implement the 400px floor**

In `shared/keys.mjs`, change `MIN_DOCK_STREAM` to `400` and update the adjacent comment. In `web/app.js`, change the `enterChatDock()` comment from “stream >= 500px” to “stream >= 400px”.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add shared/keys.mjs web/app.js tests/shared-keys.test.mjs
git commit -m "fix: lower docked stream minimum width to 400px"
```

---

### Task 2: Apply the CSS and dock-button state changes

**Files:**
- Create: `tests/ui-layout.test.mjs`
- Modify: `web/styles.css`
- Modify: `web/index.html`
- Modify: `web/app.js`

**Interfaces:**
- Consumes: `body.chat-docked` and `setChatDockButton()` from the existing chat docking code.
- Produces: computed `#stream` minimum width 400px in both layouts; dock-button colors and `aria-pressed` reflect state.

- [ ] **Step 1: Write the failing source-contract test**

Create `tests/ui-layout.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

test('stream keeps a 400px minimum in normal and docked layouts', () => {
  assert.match(css, /#stream\s*\{[^}]*min-width:\s*400px;/);
  assert.match(css, /body\.chat-docked #stream\s*\{[^}]*min-width:\s*400px;/);
});

test('chat dock button exposes floating, docked and disabled states', () => {
  assert.match(css, /\.chat-head-actions button svg\s*\{[^}]*fill:\s*currentColor;/);
  assert.match(css, /#chat-dock:not\(:disabled\)\s*\{[^}]*color:\s*#fff;/);
  assert.match(css, /body\.chat-docked #chat-dock\s*\{[^}]*color:\s*#10b981;/);
  assert.match(css, /\.chat-head-actions button:disabled\s*\{[^}]*opacity:\s*0\.4;/);
  assert.match(html, /id="chat-dock"[^>]*aria-pressed="false"/);
  assert.match(app, /chatDockButton\.setAttribute\('aria-pressed', String\(chatDocked\)\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ui-layout.test.mjs`
Expected: FAIL — the 400px rules, button colors, `fill`, and `aria-pressed` synchronization are missing.

- [ ] **Step 3: Implement the layout and button states**

In `web/styles.css`:

- Add `min-width: 400px` to the base `#stream` rule.
- Change the later `#stream { min-width: 0; }` rule to `400px`.
- Change `body.chat-docked #stream` `min-width` to `400px`.
- Add `fill: currentColor` to `.chat-head-actions button svg`.
- Add `#chat-dock:not(:disabled) { color: #fff; }` and, after it, `body.chat-docked #chat-dock { color: #10b981; }`.

In `web/index.html`, add `aria-pressed="false"` to `#chat-dock`.

In `web/app.js`, set `chatDockButton.setAttribute('aria-pressed', String(chatDocked));` inside `setChatDockButton()`.

- [ ] **Step 4: Run the tracked tests**

Run: `npm test`
Expected: all tests pass, including the new UI source-contract checks.

- [ ] **Step 5: Verify computed styles and interaction in Chrome**

Open `http://127.0.0.1:8000/` at a viewport wider than 720px. Verify:

- Floating layout: computed `#stream.minWidth === '400px'`.
- Open chat: `#chat-dock` computed color is `rgb(255, 255, 255)`, `aria-pressed === 'false'`.
- Click dock: `body.chat-docked` is present, button color is `rgb(16, 185, 129)`, `aria-pressed === 'true'`, stream minimum remains 400px.
- Drag the splitter to its left limit: stream width is 400px and chat width is at least 240px.
- Resize below 720px: docking exits, the button is disabled, and its opacity is 0.4.

- [ ] **Step 6: Commit**

```bash
git add tests/ui-layout.test.mjs web/styles.css web/index.html web/app.js
git commit -m "feat: clarify stream width and chat dock button states"
```
