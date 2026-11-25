# Chat Dock Button Colour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat title-bar dock button white when floating and green when docked, so its colour tells the user the current mode.

**Architecture:** CSS only. The existing `body.chat-docked` class is the single source of truth for mode; scope colour rules to `#chat-dock` so the other header buttons keep their muted look. No JS state, markup or i18n changes.

**Tech Stack:** CSS in `web/styles.css`; static regression test in `tests/web-styles.test.mjs` (Node test runner).

**Spec:** `docs/superpowers/specs/2026-11-25-chat-dock-button-color-design.md`

## Global Constraints

- `#stream` minimum width is **not** changed; `MIN_DOCK_STREAM` stays 450.
- Docked state is `body.chat-docked` (already set in `web/app.js`); do not add another class or JS state.
- Scoped colour rules must target `#chat-dock` only; `.chat-head button` styling for close/clear stays as-is.

## Review Focus

- Disabled button (`canDock(window.innerWidth) === false`) still shows the mode colour, dimmed by the existing `:disabled` opacity — a reasonable user expects the colour to describe mode even when the button cannot be clicked. Pin with a static check that the mode rules are not gated on `:enabled`.
- Hover in docked mode must stay green, otherwise a passing mouse turns the active indicator white. Pin with an explicit `body.chat-docked #chat-dock:hover` rule in the static test.
- Language switch / dock persistence across reload must not lose the colour: the body class is re-applied on startup from localStorage, so no JS change is needed. Pin with a static check that the rules key off `body.chat-docked` and not a one-time inline style.

---

### Task 1: Dock button state colours

**Files:**
- Modify: `web/styles.css` (chat head button section, around lines 650-663)
- Create: `tests/web-styles.test.mjs`

**Interfaces:**
- Consumes: `body.chat-docked` class set by `web/app.js`; `#chat-dock` element from `web/index.html`.
- Produces: computed colours for the dock button in floating and docked states.

- [ ] **Step 1: Write the failing static test**

`tests/web-styles.test.mjs` reads `web/styles.css` and asserts:
- the floating rule `#chat-dock { ... color: var(--ui-text-color) ... }` exists;
- the docked rule `body.chat-docked #chat-dock { ... color: #5fd39b ... }` exists;
- `body.chat-docked #chat-dock:hover { ... color: #5fd39b ... }` exists;
- none of these rules are scoped to `:enabled`.

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test tests/web-styles.test.mjs`
Expected: FAIL because the rules do not exist yet.

- [ ] **Step 3: Implement the CSS rules**

Add the three rules in `web/styles.css` near `.chat-head button`. Keep every other `.chat-head button` rule untouched.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 5: Verify in the live browser**

Sync `web/styles.css` to `~/.local/share/phone-screen-link/web/styles.css` and `engine/dist/public/styles.css`; load the page and read `getComputedStyle(document.getElementById('chat-dock')).color` floating, then after clicking dock. Expected: near-white (`rgb(...)` from `--ui-text-color`) then green `#5fd39b` = `rgb(95, 211, 155)`.

- [ ] **Step 6: Commit**

```bash
git add web/styles.css tests/web-styles.test.mjs
git commit -m "feat(ui): show dock mode in the chat dock button colour"
```
