# Chat dock button colour — short design

**Approved:** 2026-11-25 (human partner replied "可以").
**Scope:** small change. The earlier request to change `#stream` minimum width was withdrawn ("不改了") and is explicitly out of scope.

## Intent

The chat title-bar button that toggles side-by-side mode should show, by colour alone, which mode is active: white when the chat panel is floating, green when it is docked beside the picture.

## Goals

- Floating: `#chat-dock` uses the theme's near-white `--ui-text-color` (currently the muted `--ui-text-muted`, which reads grey).
- Docked: `#chat-dock` uses the project's existing success green `#5fd39b` (the same colour as a passing installer check).
- Hover in docked mode must not wash the green back to white.

## Non-goals

- No change to `#stream` minimum width, `MIN_DOCK_STREAM`, or the splitter.
- No JS state, no new i18n keys, no markup change, no behaviour change on click.
- No change to the other chat head buttons.

## Constraints

- Docked state is already exposed as `body.chat-docked`; use that class rather than adding another one.
- Keep the existing `.chat-head button { color: var(--ui-text-muted) }` for the other buttons (close/clear), only scope the new colour to `#chat-dock`.

## Approach

CSS only, in `web/styles.css`:

1. `body.chat-docked #chat-dock` → `color: #5fd39b`.
2. `#chat-dock` default → `color: var(--ui-text-color)`.
3. `body.chat-docked #chat-dock:hover` → `color: #5fd39b`, overriding the generic `.chat-head button:hover`.

Alternatives considered: toggling a class from `setChatDockButton()` in `web/app.js` (extra state to keep in sync, no benefit because the body class already exists), and changing the generic `.chat-head button` colour (would recolour every header button). CSS scoping to the existing body class is the smallest reliable change.

## Verification

- A static style regression test asserts the three rules and their order/scoping.
- `npm test` green.
- Live browser check: read `getComputedStyle(document.getElementById('chat-dock')).color` with the panel floating, click dock, read again; expect near-white then green.
