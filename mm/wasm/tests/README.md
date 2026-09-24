# 2Ship wasm tests

Browser tests for the Emscripten build, run with [bun](https://bun.sh) and Playwright's
Chromium. They drive the real build through `page/harness.html`, which stands in for an
embedder: it fetches the game files, writes them into the module's filesystem before
`main()`, and loads `2ship.js`.

```
bun install
bun run install-browser        # Playwright's Chromium, once
bun test unit/                 # pure functions, no browser, instant
bun run test                   # everything, with a wall-clock budget
bun run smoke                  # just the smoke tests
```

## What it needs

A release build and a game archive:

```
SHIP_WASM_BUILD=/path/to/build-wasm-rel/mm    # 2ship.js, 2ship.wasm, 2ship.data, host.html
SHIP_WASM_FILES=$SHIP_WASM_BUILD/hostfiles    # mm.o2r, 2ship2harkinian.json
```

Both default to `build-wasm-rel/mm` and `build-wasm-rel/mm/hostfiles` in the repo. `mm.o2r` must come
from a 2Ship with the same major version as the binary — the archive records the port version
and the game refuses one from another major version, which the boot tests rely on.

## Environment

| Variable | Effect |
|---|---|
| `SHIP_WASM_SLOW=1` | run the timing tests, which sample the game for tens of seconds |
| `SHIP_WASM_SOAK=1` | run the ten-minute memory soak |
| `SHIP_WASM_HEADED=1` | show the browser |
| `SHIP_WASM_BUDGET_MIN` | wall-clock budget for `bun run test` (default 30) |

## The files

- `unit/` — pure functions (wasm parsing, the test server, timing analysis, the event
  contract). No browser, runs in milliseconds.
- `artifacts.test.ts` — reads the `.wasm` directly: no function large enough or with enough
  locals to endanger V8's optimising compiler, and `HOST-API.md` ships next to `2ship.js`.
- `boot.test.ts` — a missing or corrupt `mm.o2r` is reported as an `error` event rather than
  a black canvas; `host.html` boots; optional files really are optional.
- `smoke.test.ts` — boots, renders, and keeps running.
- `host-api.test.ts` — the contract in `mm/wasm/HOST-API.md`: event shapes, console return
  values, commands from inside a listener, files coming back out, booting to a warp point.
- `audio.test.ts` — audio is produced and the device consumes it.
- `timing.test.ts` (slow) — the loop ticks at `60 / R_UPDATE_RATE` Hz and draws one frame per
  tick.
- `smoke-tiering.test.ts` — runs with V8 compiling every function up front, which is how the
  sibling port's renderer crash reproduced in seconds instead of minutes.
- `regression.test.ts` — the audio overrun that corrupted the audio globals: three minutes of
  play, and a warp-point boot into Termina Field, which used to die in ten seconds. Slow by
  design; these are the tests that would notice it coming back.
- `soak.test.ts` (opt-in) — ten minutes without heap growth.

## Playing a build

`bun run serve` serves the build with `host.html` at <http://127.0.0.1:8724>. Nothing is
cached, so rebuild and reload.

## If a run hangs

A page whose main thread is stuck inside wasm never answers `page.evaluate`, so every call
into it is bounded (`PAGE_CALL_TIMEOUT`) and `bun run test` has a wall-clock budget on top.
The page's console still arrives over the DevTools protocol while the main thread is wedged,
which is usually the only clue available — `withGame` appends the last few lines to any
failure. Needs bun 1.4+; 1.2.x drops the browser connection partway through a multi-file run.
