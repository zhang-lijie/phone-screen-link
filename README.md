# Phone Screen Link

Mirror a HUAWEI Mate 40 Pro to a browser on this machine and control it with
on-screen Home / Back / Power buttons. The app wraps ws-scrcpy-web v0.5.13
(bound only to `127.0.0.1:8000`) plus a small control bridge on
`127.0.0.1:8100`.

## Setup

```sh
npm run setup
```

This clones and builds the pinned engine into `engine/` and patches it to listen
on loopback only. It is safe to re-run: an already-built engine is left
untouched. The custom web page is copied in when you run `npm start`.

## Run

```sh
npm start
```

Then open <http://127.0.0.1:8000/> in the browser. `npm start` disconnects Wi‑Fi
ADB, copies the web assets over the engine's public directory, starts the engine
and the control bridge, and stops both cleanly on Ctrl-C / SIGTERM.

## Limitations

- **Lock screen:** A locked phone shows a black stream. Android's keyguard
  hands scrcpy a black surface, so if the canvas is dark but the device is
  connected, unlock the phone first — the status line shows a lock hint while
  the keyguard is up (polled every 3 s). A black screen is not by itself a
  broken stream.
- **Secure context:** WebCodecs decoding requires a secure context. Plain HTTP
  works only on `http://127.0.0.1` or `http://localhost`; a LAN address such as
  `http://192.168.3.x:8000/` will not decode video. Use an `https://` origin if
  you must reach it from another machine.
- **USB only:** This app deliberately enforces a wired connection. It disconnects
  Wi‑Fi ADB (`192.168.3.123:5555`) at startup and again every 5 s, and uses only
  the USB serial `2FD0221C09004177` for streaming and key events. Do not rely on
  a wireless ADB connection staying up.

## Troubleshooting

- **`velopack` EBADENGINE warning during `npm run setup`:** On Node 26, npm may
  print an `EBADENGINE` warning for the engine's `velopack` dependency. It is
  harmless — setup and the app work fine; ignore it.
- **No supervisor / auto-restart:** A process supervisor is deliberately not
  used. Run `npm start` in a terminal and stop it with Ctrl-C; the orchestrator
  tears down the engine and bridge itself rather than depending on a supervisor.
- **Engine first-run dialog:** If the engine's own "install for all users?"
  first-run dialog appears on `/`, dismiss it with **"no, me only"**. Our copied
  custom page normally replaces that home page at the root, so this dialog
  usually will not appear.
