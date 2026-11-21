# Phone Screen Link — Web UI Redesign (v2)

- Date: 2026-11-22 · Status: awaiting approval
- Scope: web shell only (`web/`). Engine, bridge, keys.js, orchestrator and tests' behavior are unchanged — this is a visual rework of the page only.

## Intent

The phone mirror should be the experience: a near-black canvas, everything else compact and quiet. Earlier complaints: buttons too large, too much low polish. The redesign fixes both: ~22px icon buttons and a refined near-black system.

## Why now

A defined direction: the reference study came back (the engine's own UI style plus the main peer projects). The user prefers a compact control layer over oversized buttons (Approach 1).

## Approach picked: Approach 1 — 谦逊现代流（镜像引擎自己，压缩一半）

Mirrors `engine/src/style/ws-scrcpy.css`: near-black canvas, white glyphs, one accent blue.

- Palette: page `#111318`, canvas `#000`, text `#e8eaf0`, status `#919393`, accent blue `#5b9aff` (engine-consistent).
- Control bar: a compact top navigation bar — six small text-labeled buttons (`HOME`, `BACK`, `APPS`, `VOL−`, `VOL+`, `POWER`; 11px uppercase letter-spaced, pill radius 10px, ~23px tall) centered above the picture. All go through the ADB bridge.
- The engine's own toolbox becomes a narrow 44px rail on the right of the picture: 16px icons, ~36px tall, each with a short text label below it (`SHOT`, `KEYS`, `MOUSE`, `STATS`, `DPAD`, `RELOAD`, `COPY`, `PASTE`).
- Status: slim line under the picture (small, uppercase, muted).

## Approaches considered (rejected)

- Approach 2 — 投屏主角+小圆按钮跑（意大利仪表盘）: real, small circles are tighter, but riskier and dates fast; no need to address for a 186px phone.
- Approach 3 — 玻璃卡片+信号列（让画面更出戏）: deferred — glass adds noise and cost; user asked for modest polish first.

## Key decisions

- The engine's stylesheet (`/ws-scrcpy.css`) is loaded before ours. Our page replaces the engine's page, so without it the engine-generated DOM loses its layout rules: toolbox buttons render unstyled at 63×57, the checkbox labels lose their text, and the picture canvas ends up beside the touch canvas instead of on top of it.
- The engine's duplicate key buttons (Home, Back, Power, Volume up/down, Overview) are hidden from the rail — the labeled top bar owns those actions, so each exists exactly once.
- `KEY_CODES` gained `volume_up` (24), `volume_down` (25) and `overview` (187) so the bridge can drive them.
- The toolbox's icon-only entries get visible text via a `title` → short-label map in `app.js`, rendered by CSS through `data-label`.

## Constraints (unchanged, hard)

- Same CORS origins (127.0.0.1:8000 + localhost:8000), same bridge, same poll, same WebCodecs decode.

## Files

- `web/index.html` — top `.nav-bar` with the six labeled key buttons; the engine fills `#stream` with its own `.device-view`.
- `web/styles.css` — presentation rewrite (compact near-black) plus the rules for the engine-generated DOM.
- `web/app.js` — unchanged key handling; adds the toolbox label map.
- `shared/keys.mjs` — `KEY_CODES` gains the volume and overview codes.

## Verification

- `npm test` (32 tests).
- Manual smoke: connect, status shows "Connected — 186x384".
