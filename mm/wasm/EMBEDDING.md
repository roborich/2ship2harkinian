# Embedding the 2Ship wasm build

The contract between this build and a host page. It is deliberately small: the game reads
its files from an in-memory filesystem and knows nothing about where they came from — no
IndexedDB, no network, no assumptions about the embedder. A host obtains bytes however it
likes and hands them over.

`HOST-API.md` is the reference for the API itself and ships next to the build output. This
file is the background: how to build it, what the build contains, and what the browser
target does differently from desktop.

## Building

The port archive is produced by a **desktop** build, because ZAPD is a host tool and is not
part of the cross build:

```
cmake -H. -Bbuild-cmake -G "Unix Makefiles" -DCMAKE_BUILD_TYPE=Release
cmake --build build-cmake --target Generate2ShipOtr      # -> build-cmake/mm/2ship.o2r
```

Then the wasm build (emsdk 6.0.9):

```
source ~/emsdk/emsdk_env.sh
emcmake cmake -H. -Bbuild-wasm -G "Unix Makefiles" -DCMAKE_BUILD_TYPE=Release \
  -DSHIP_WASM_ASSET_DIR=$PWD/build-cmake/mm
cmake --build build-wasm -j10
```

Outputs, in `build-wasm/mm`:

| | |
|---|---|
| `2ship.wasm` | 23.6 MB raw · 6.5 MB gzip · **3.5 MB brotli** |
| `2ship.js` | 0.4 MB |
| `2ship.data` | 1.8 MB — holds `2ship.o2r` and nothing else |
| `host.html`, `HOST-API.md` | copied from `mm/wasm/` |

Serve all of them plus your host page from the same directory. 3.5 MB over the wire is an
ordinary web download, so there is no splitting or streaming strategy and none is needed.

`2ship.data` contains only the port archive, which is built from this repo and
version-checked against `gBuildVersion`. **Nothing extracted from a ROM ends up in the
output**, so the build can be published as is. `mm.o2r` is the page's to supply.

For local play, `bun run serve` in `mm/wasm/tests` serves the build with `host.html`.

### Getting an `mm.o2r`

There is no in-browser ROM converter yet (Milestone 6 in `wasm-port.md`). Produce the
archive with a desktop build — put a ROM at `OTRExporter/mm.z64` and run the `ExtractAssets`
target — and hand the result to the page. It must come from the same build as the binary:
the archive records the port version and the game refuses one from any other, reporting it
through the `error` event rather than failing at the first resource load.

## What the browser target does differently

- **Single-threaded.** No pthreads, no SharedArrayBuffer, no COOP/COEP headers, so the build
  can be served from anywhere. The audio thread, the resource-manager pool, spdlog's async
  logger and the streamed-sample decoders all run inline.
- **One rendered frame per game tick.** Interpolated sub-frames need a loop paced by the
  display to be seen; this one ticks at the game's rate, so they would be drawn back to back
  and only the last would reach the screen. `InterpolationFPS` therefore has no effect.
- **The frame rate is the game's, not the display's.** The loop is driven by
  `emscripten_set_main_loop` at `60 / R_UPDATE_RATE` Hz, re-derived after every frame:
  20 Hz in gameplay, 30 in the pause menu and message boxes, 60 on the title, file select and
  "Dawn of the Nth Day" screens. `requestAnimationFrame` would run at the display's rate and
  desynchronise both the game speed and the audio.
- **The canvas renders at CSS resolution.** `SDL_WINDOW_ALLOW_HIGHDPI` is off, because SDL
  would size the backing store by `devicePixelRatio` while ImGui keeps reporting CSS pixels
  and LUS mixes the two. Use the internal-resolution setting to supersample.
- **Audio plays through SDL's Emscripten backend**, whose callback runs on the page's main
  thread — so a long frame is audible however deep the queue is. A Web Audio player that
  runs the consumer on the audio thread exists on the SoH side and is not ported yet.
- **No ROM extractor, no crash handler, no gfx debugger, no Opus.** Opus and OpusFile have no
  Emscripten port, so custom *streamed Opus* music decodes to silence; Ogg Vorbis, MP3 and
  FLAC go through dr_libs and work.

## Storage

The page owns storage. The module writes into MEMFS and reports every change through
`file-saved` / `file-removed` events (`HOST-API.md` §2); persist them wherever you like. The
VFS is lost on reload, so anything not persisted by the host is gone.

This is deliberate, and it is worth not undoing. The obvious alternative — mounting IDBFS —
is write-behind, so nothing reaches IndexedDB until `FS.syncfs()`, and the config save in
`~Context` never runs in a browser tab. Keeping storage on the page's side removes that
problem, keeps the module storage-agnostic, and means the published artifact contains
nothing derived from a ROM.

## Debugging

- The build keeps function names (`--profiling-funcs`), so a browser stack trace reads
  `AudioSynth_Update` rather than `$func11146`.
- `host.html?memtrace` overlays the wasm and JS heap sizes and keeps a trail in
  `localStorage` that survives a renderer crash:
  `JSON.parse(localStorage.getItem('2ship-memtrace-prev'))`.
- `Ship_GetStats` returns frame, audio and scene counters (`HOST-API.md` §4).
- **For anything that looks like memory corruption, build with AddressSanitizer** before
  theorising. The recipe, and the two details that make it usable here, are in
  `wasm-port.md`, "The tool that found both". It found the audio overrun in one run after a
  day of reasoning backwards from stack traces.
- A page whose main thread is stuck inside wasm never answers `page.evaluate`, but its
  console still arrives over the DevTools protocol. That is usually the only clue available.
