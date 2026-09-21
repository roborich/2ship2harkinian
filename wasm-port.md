# 2 Ship 2 Harkinian in the browser — WebAssembly port plan

Working plan for branch `wasm` (2S2H `61384c2c8`; LUS pinned at `7f9b86a5`).
Goal: 2Ship running in a browser tab, single-threaded, with the host page supplying the
game files.

This is a **second** port of the same shape. Ship of Harkinian was taken to a playable
browser build on `roborich/Shipwright` branch `wasm` (65 commits off `cb71e22a7`), and the
findings, traps and measurements from that work are written up in that repo's
`wasm-port.md` and `wasm-rom-extract.md`. Read them first — most of the expensive
discovery is already paid for. This document records what carries over, what does not, and
what is genuinely new here.

## Status (2026-09-21)

**Milestones 0-4 are done.** The game boots in a browser, renders Termina/Clock Town
correctly, runs at the right speed, plays audio and responds to the console. Milestone 3 (a
GUI-only boot) was skipped: the full game rendered on the first attempt, so there was nothing
to isolate.

| | |
|---|---|
| `2ship.wasm` | 23.6 MB raw · 6.5 MB gzip · **3.5 MB brotli** |
| `2ship.js` / `2ship.data` | 0.4 MB / 1.8 MB |
| Tick rate | 60/`R_UPDATE_RATE` Hz, within 5%, one frame drawn per tick |
| Heap | 512 MB at the initial size, no growth observed over ~2 minutes |
| Tests | 37, passing (`mm/wasm/tests`) |

3.5 MB over the wire is an ordinary web download, so **size is not a constraint** and no
splitting or streaming strategy is needed — the same conclusion the SoH port reached.

Build it with:

```
cmake --build build-cmake --target Generate2ShipOtr     # 2ship.o2r, from a desktop build
emcmake cmake -H. -Bbuild-wasm -G "Unix Makefiles" -DCMAKE_BUILD_TYPE=Release \
  -DSHIP_WASM_ASSET_DIR=$PWD/build-cmake/mm
cmake --build build-wasm -j10
```

`mm.o2r` is not built in and not built here: produce it from a ROM with a desktop build and
hand it to the page (`mm/wasm/HOST-API.md`).

### The audio overrun — fixed 2026-09-21

For about a day this looked like two defects: a hang (an sfx bank's linked list turning
circular) and a crash a minute or two into any session (an out-of-bounds read inside
`osRecvMesg`, draining an audio queue). I wrote the second one up as the single-threaded
audio handshake needing a rewrite. **That was wrong**, and it was wrong because I read the
`osRecvMesg` stack without asking what had corrupted the queue in the first place.

AddressSanitizer answered it in one run: `global-buffer-overflow`, **WRITE of size 21600**,
in `aClearBufferImpl`, from the `CODEC_S16` / `CODEC_OPUS` branch of
`AudioSynth_ProcessSample` (`mm/src/audio/lib/synthesis.c`, the
`(numSamplesToLoadAdj + SAMPLES_PER_FRAME) * SAMPLE_SIZE` clear).

`rspa.buf` in `mm/2s2h/mixer.c` emulates the RSP's DMEM window. It was `0xC80` bytes biased
by `-0x0330` — exactly the `0x0330..0x0FB0` range the ucode's DMEM map uses, and correct
right up until a command asks for more than fits. `DMEM_UNCOMPRESSED_NOTE` leaves 2,624 bytes
above it, so that one command wrote about **19 KB past the end of a static struct**, into
whatever the linker had placed next: the audio globals, `gAudioCtx`, and the sfx banks' static
entry arrays. Both symptoms were that one write, seen from two directions.

On hardware the RSP cannot reach outside DMEM at all, so the fix is to make the emulated
window behave the same way. Rather than bounds-check all 28 `aXxxImpl` shims, it now covers
every address a 16-bit DMEM address can name plus the largest transfer a command can request:
a `uint16_t` address plus a `uint16_t` count cannot reach outside `0x20000`, so unsigned
counts are safe by construction and only the two signed ones need a clamp. Legitimate traffic
is unaffected — the map lands at the same offsets in the same order — and the extra 128 KB is
static.

| | before | after |
|---|---|---|
| Warp-point boot (Termina Field) | dead in ~10 s | clean |
| Normal boot | dead in 1–2 min | 150 s clean, 4 scene transitions |
| Measured tick rate | 5.10 Hz (the loop had stopped) | **19.74 Hz** against 20 |
| Audio drops | — | 0 |

**Still open: why the clear was oversized.** 21,600 bytes is `numSamplesToLoadAdj ≈ 10784`
where a sane value is a few hundred, on the branch that handles the port's own streamed-audio
codecs. The window now bounds the damage, but that number is still wrong, and the Opus stub
(§"Ports nearly verbatim") is a suspect worth eliminating first.

Two guards remain in `mm/src/audio/sfx.c` as canaries — a bound on the bank walk and a refusal
to unlink the list sentinel. The failure they catch is silent and total, and they cost one
comparison per entry.

### Also fixed: a use-after-free in the config migration

From the same ASan run. `Ben::ConfigVersion1Updater::Update` bound `const auto&` to a
subobject of the temporary that `Ship::Config::GetNestedJson()` returns **by value**; lifetime
extension does not reach through a member call, so the temporary died at the end of the
statement and every read through the reference was a use-after-free. Desktop finds the freed
bytes intact and carries on. This one is not wasm-specific — it is a latent bug in 2Ship that
the browser build's allocator simply refuses to forgive.

### The tool that found both

`-fsanitize=address` works on this module, and was worth the 10-minute link:

```
emcmake cmake -H. -Bbuild-wasm-asan -G "Unix Makefiles" -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DSHIP_WASM_ASSET_DIR=$PWD/build-cmake/mm \
  -DCMAKE_C_FLAGS=-fsanitize=address -DCMAKE_CXX_FLAGS=-fsanitize=address \
  -DCMAKE_EXE_LINKER_FLAGS="-fsanitize=address -sINITIAL_MEMORY=1073741824 -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=8388608"
```

The resulting module is ~380 MB and takes about 40 s to instantiate, so the test harness's
10-second call timeout has to be avoided — poll the console instead of calling into the page.
`__asan_default_options` in `EmbedderBridge.cpp` sets `halt_on_error=0`, which is what makes
one run report the whole list rather than one item per relink; it also turns off
`detect_container_overflow`, which the FetchContent dependencies trip as a known false
positive. Reach for this before theorising about a memory fault again.

### Not started

Milestone 5 (storage, mods, keyboard polish), Milestone 6 (the ROM converter), the Web Audio
player, and depth readback. The build plays through SDL's Emscripten audio backend, whose
callback runs on the page's main thread, so any long frame is audible.

## Scope for the first pass

Same narrow scope that made the SoH port a port and not a rewrite:

- **Archives are provided, never extracted, by the game module.** The page hands over
  `mm.o2r`; the build ships a host-generated `2ship.o2r` alongside it, version-pinned.
  In-browser ROM extraction is a *separate module* (`2ship-extract.js`), built from the
  same tree, run by the host in a worker. Milestone 6.
- **Keyboard first, controllers later.** LUS treats keyboard as a first-class input device;
  Emscripten's SDL2 has a working Gamepad-API backend, so controllers are a bonus, not a
  blocker.
- **Enhancements and GUI stay compiled in.** 316 files under `mm/` call `CVarGet*`, and
  enhancements are wired through GameInteractor hooks, not isolated behind a flag. Removing
  them is strictly more work than keeping them. See "What not to strip".
- **Single-threaded.** No pthreads, no SharedArrayBuffer, no COOP/COEP.
- **One rendered frame per game tick.** Interpolated sub-frames need a second yield point
  inside `RunCommands`, which the frame state machine does not have. Out of scope; see §1.

## Why this is tractable: the preconditions hold

Four things decide whether this approach works at all. All four are true in this tree.

### 1. The frame loop is already re-entrant

`mm/src/code/graph.c:363-431` — `RunFrame()` is a resumable state machine, structurally
identical to SoH's:

```c
static struct RunFrameContext {
    GraphicsContext gfxCtx;
    GameState* gameState;
    GameStateOverlay* nextOvl;
    GameStateOverlay* ovl;
    int state;
} runFrameContext;
```

with `switch (runFrameContext.state) { case 1: goto nextFrame; }` at the top, and
`Graph_ThreadEntry` (`:429`) reduced to `while (WindowIsRunning()) RunFrame();`.

Consequence: **no Asyncify** (binary size and speed) and **no `-sPROXY_TO_PTHREAD`**
(which would drag in SharedArrayBuffer and COOP/COEP response headers). `RunFrame` becomes
an `emscripten_set_main_loop` callback almost verbatim. The SoH patch to its `graph.c` is a
near-literal copy.

There is exactly one yield point and it sits *after* `Graph_ProcessGfxCommands` returns, so
every interpolated sub-frame of a tick is rendered synchronously and only the last one is
presented. Hence "one frame per tick" above.

### 2. The tick rate is not constant, and audio depends on it

`R_UPDATE_RATE` is `SREG(30)` (`mm/include/regs.h:71`), set through
`GameState_SetFramerateDivisor` (`mm/src/code/game.c:41-45`). The game runs at
`60/R_UPDATE_RATE` Hz *and* synthesises `R_UPDATE_RATE` audio buffers per frame
(`AUDIO_FRAMES_PER_UPDATE`, `mm/2s2h/BenPort.cpp:833`), so the two cancel and audio always
lands at 32 kHz.

MM changes the divisor in **more** places than OoT does:

| Divisor | Rate | Sites |
|---|---|---|
| 3 | 20 Hz | gameplay (`game.c:235`), `z_play.c:784,831,865,894,930,953`, kaleido NES ×5 |
| 2 | 30 Hz | pause setup (`z_kaleido_setup.c:138`), message (`z_message.c:5993`) |
| 1 | 60 Hz | title (`z_title.c:245`), select (`z_select.c:1133`), opening (`z_opening.c:59`), file choose (`z_file_choose_NES.c:2617`), **day transition (`z_daytelop.c:243`)**, pre-NMI (`z_prenmi.c:53`), `z_play.c:1001` |

`z_daytelop.c` is the one that matters for testing: the "Dawn of the Nth Day" screen is
entered mid-gameplay every in-game day, so a timing or audio test that assumes 20 Hz
throughout a play session will see a 60 Hz stretch it did not expect.

A loop pinned to one rate breaks the cancellation and audio comes out at
`rate * R_UPDATE_RATE * ~533` samples/sec — wrong speed in every state but the one it was
pinned to. The frame callback must re-derive its delay from `R_UPDATE_RATE` after every
frame. SoH's `TickClock_Advance` (a running deadline, so `setTimeout` lateness does not
accumulate, with a restart when the rate changes or the loop falls three ticks behind) ports
as-is.

### 3. The N64 threads are inert

`mm/CMakeLists.txt:141` does `list(FILTER src__ EXCLUDE REGEX "src/libultra/os/")`, so the
decomp's thread implementation is never compiled — what links are empty stubs.
`mm/src/code/main.c:119` creates and starts the graph "thread" (both no-ops) and then calls
`Graph_ThreadEntry(0)` directly on the main thread at `:123`. LUS's message queues are
non-blocking stubs.

### 4. Real threads are few, and fewer than SoH's

Under Emscripten without `-pthread`, every `std::thread` construction aborts. Each needs a
shim:

| Thread | Where | Shim |
|---|---|---|
| Audio | `mm/2s2h/BenPort.cpp:861` | not started; fill inline from the frame callback |
| LUS ResourceManager pool | libultraship | synchronous executor (LUS patch) |
| spdlog async logger | libultraship `Context.cpp` | synchronous sink (LUS patch) |
| Extractor pool *(desktop only)* | `mm/2s2h/BenPort.cpp:333` | inside `RunExtract`, compiled out |
| Custom-audio decoders *(on demand)* | `mm/2s2h/resource/importer/AudioSampleFactory.cpp:314-322` | decode inline |

2Ship has **no SaveManager thread pool** and **no networking stack** — no Anchor, no Sail,
and CrowdControl is already behind `ENABLE_CROWD_CONTROL` (`mm/2s2h/BenPort.cpp:45-48`) with
its source directory absent from the tree. That is three of SoH's shims gone.

## What 2Ship gets for free, and what it does not

### Ports nearly verbatim from the SoH branch

- **CMake.** `CMakeLists.txt` here has the same skeleton as SoH's: `GFX_DEBUG_DISASSEMBLER`
  at `:89`, `GBI_UCODE` at `:92`, `add_subdirectory(libultraship)` at `:186`, ZAPD +
  OTRExporter + game at `:207-209`. `mm/CMakeLists.txt` has the same `if (NOT TARGET
  ZAPDLib)` at `:71`, the same `list(FILTER … Extractor)` idiom at `:114-128`, and the same
  `-pthread` in the final GCC/Clang `else()` at `:450,455`. SoH's `CMake/emscripten-deps.cmake`
  (FetchContent with `OVERRIDE_FIND_PACKAGE` for zlib, libzip, nlohmann_json, tinyxml2,
  spdlog) is game-agnostic and copies over unchanged.
- **`graph.c`** — the frame callback and tick clock.
- **The audio handshake.** `mm/2s2h/BenPort.cpp:807-880` (the thread + condition variables)
  and `:1201-1207` / `:1254-1256` (the `audio.processing` handshake inside
  `Graph_ProcessGfxCommands`) are line-for-line the SoH code. Same split of the update body
  into an `OTRAudio_FillBuffer` that desktop calls from the thread and wasm calls inline.
  Without touching *both* sites, the first frame deadlocks on an audio thread that was never
  started.
- **Audio buffer sizing.** `InitAudio` at `mm/2s2h/BenPort.cpp:644` uses the same
  `DesiredBuffered = 1680` (≈52 ms against a 50 ms frame — about 2 ms of slack). Same deeper
  target for the browser, same `static_assert` tying it to the player's drop threshold.
- **Opus stubs.** `mm/2s2h/mixer.c:108-132` uses `opus`/`opusfile`, which have no Emscripten
  port. Stub `aOPUSdecImpl` / `aOPUSFree` to silence; it costs custom streamed Opus audio and
  nothing else. Ogg and Vorbis have ports.
- **The whole `wasm/` directory shape** — `host.html`, `HOST-API.md`, `EMBEDDING.md`, and the
  bun + Playwright test harness (`lib/wasm.ts`, `lib/server.ts`, `lib/game.ts`, `lib/timing.ts`
  and the smoke/boot/audio/timing/soak/artifacts suites). The harness is game-agnostic; only
  the assertions are not.

### Needs real work

1. **The libultraship rebase — smaller than the line counts suggest.**
   *(Revised 2026-09-21 after review, and after the port was actually done.)* An earlier
   draft called this the biggest unknown, on the strength of upstream churn in the files the
   patch touches. That churn is mostly Doxygen: `AudioPlayer.h`'s "+114" is comments, and the
   only semantic change to the audio interface between the pins is `~AudioPlayer()` becoming
   `virtual`. `WebAudioAudioPlayer` implements `DoInit`/`DoClose`/`DoPlay`/`Buffered`, none
   of which changed.

   A 3-way dry run (`git merge-tree fdcaf633 <lus-wasm-tip> 7f9b86a5`) produces **four
   conflict hunks, all trivial**: the `WEBAUDIO` enum member, `HasFailed()`, and the fact
   that upstream deleted `Config::GetCurrentAudioBackend` and moved backend resolution into
   `Audio::GetSavedAudioBackend()` — so the Config.cpp half of the patch lands in Audio.cpp
   instead. `ResourceManager.{h,cpp}`, `Context.cpp`, `gfx_opengl.cpp`, `gfx_sdl2.cpp` and
   both CMakeLists merge clean.

   Confirmed in practice: the non-audio half landed as 99 lines across 6 files and
   libultraship compiled clean under Emscripten on the first attempt. Budget **≤1 day**
   including Web Audio.

   This work benefits both ports — SoH and 2Ship consume the same LUS — so do it once, on a
   fork branched from `7f9b86a5`, and point both trees at it.

2. **`Extract.cpp` → `RomInfo` split.** SoH lifted the pure ROM/CRC checks out of the GUI
   extractor so the worker module could reuse them without ZAPD's GUI dependencies.
   `mm/2s2h/Extractor/Extract.cpp` (639 lines) has the same `CallZapd` → `zapd_report` shape
   (`:569-624`) and the same `FastCrc32C.c`, so the same refactor applies — but against MM's
   ROM table, by hand.

3. **`EmbedderBridge` retargeting.** The mechanism (DOM `CustomEvent('soh')` out,
   `ccall('…_RunConsoleCommand')` in, `…_GetStats` for tests) is generic and copies over. The
   *payloads* are OoT-shaped: `scene { sceneNum, entranceIndex }`, `load-game { fileNum }`,
   and a `warp` console command that resolves age and time of day. MM needs its own vocabulary
   — day of the three-day cycle, not age.

4. **Depth readback — the only real WebGL2 gap.**
   *(Revised 2026-09-21 after review.)* An earlier draft claimed MM's framebuffer effects
   would hit two WebGL2 gaps harder than OoT. Checked, and that is wrong on both counts:

   - `ReadFramebufferToCPU`'s `GL_UNSIGNED_SHORT_5_5_5_1` readback **is already fixed
     upstream** at `7f9b86a5` (it reads RGBA/UNSIGNED_BYTE and converts on the CPU) — and
     2Ship never issues it anyway: there is no `gsSPReadFB` / `G_READFB` anywhere in
     `mm/src` or `mm/2s2h`.
   - Every MM framebuffer effect (`FB_CopyToFramebuffer` / `FB_DrawFromFramebuffer` in
     `z_play.c` and `z_visfbuf.c`, and all of `framebuffer_effects.c`) goes through
     `OTR_G_COPYFB` → `CopyFramebuffer` → `glBlitFramebuffer`, which WebGL2 has. Nothing
     here is MM-specific or harder than OoT.

   What is left is depth readback, compiled out under `USE_OPENGLES` because WebGL2
   `readPixels` cannot read `GL_DEPTH_STENCIL`, leaving `depth_stencil_value` uninitialized.
   Its consumers are exactly OoT's two: `mm/src/code/z_kankyo.c:532` (sun occlusion) and
   `mm/src/code/z_lights.c:411` (glow check), both reached through
   `OTRGetPixelDepthPrepare` / `OTRGetPixelDepth` (`mm/2s2h/BenPort.cpp:1277-1299`).
   Budget **1–2 days** for a depth-to-color path or a CVar that disables it.

5. **What the 80-commit LUS gap actually brings.** Not the audio interface (above), but:
   - **The shaders were rewritten.** Upstream deleted
     `src/fast/shaders/opengl/default.shader.{fs,vs}` and replaced them with a single
     `default.shader.glsl`. SoH's finding that `USE_OPENGLES ON` fixes shader compilation was
     validated against the *old* files. This must be re-validated under WebGL2, and it is now
     the one part of the gap with genuinely unknown cost.
   - `monocypher` is FetchContent'd unconditionally and linked `PUBLIC` — a new network fetch
     that `emscripten-deps.cmake` does not account for. Pure C; should build.
   - `find_package(Python3 REQUIRED COMPONENTS Interpreter)` is now needed at LUS configure
     time (it generates `DefaultKeys.h`). Host-side, but M0 must list it.
   - `ENABLE_SCRIPTING` is new, pulls in libtcc, and `LibraryLoader.cpp` `#error`s on any
     target that is not Windows/Linux/Apple. Default OFF and this tree never sets it —
     **record that it must stay OFF for Emscripten.**

6. **Storage is a bigger surface here than in SoH.** SoH's `file-saved` watch covered one
   config file and `/Save/`. 2Ship writes to disk from `SaveManager/SaveManager.cpp` (~30
   sites, its own `saves/` directory), `BinarySaveConverter.cpp`, three TimeSplits trackers,
   `DeveloperTools.cpp`, `DeleteFileOnDeath.cpp`, `Rando/StartingItems.cpp`,
   `Rando/ExcludedChecks.cpp`, `Rando/Spoiler/File.cpp` and `PresetManager.cpp`. It also
   *reads* a spoiler file at `Saving/NewFileSetup.cpp:126` through an unguarded
   `json::parse`. Enumerate these in M5 rather than assuming SoH's two paths.

   `Enhancements/ModMenu/ModMenu.cpp` scans a mods directory; SoH needed a ~120-line rewrite
   of its equivalent to tolerate a config listing mods that are absent from MEMFS. Add it to
   the carry-over list.

7. **Exception handling.** 29 `throw` sites and 18 `std::sto*` call sites under `mm/2s2h`.
   Emscripten disables exception catching by default and any `throw` aborts; budget
   `-fwasm-exceptions`, tree-wide, with `-sWASM_LEGACY_EXCEPTIONS=1` named explicitly so every
   object and every Emscripten port agrees on the ABI.

   Separately: an exception escaping the frame callback reaches Emscripten's
   `handleException`, which stops the main loop — the tab stays alive, the game freezes, and
   the console shows only "Uncaught Exception {stack: undefined}" with no message. SoH added a
   `RunFrameGuarded` wrapper to name it. Carry that over.

8. **A `warp` console command does not exist here.** 2Ship's console
   (`mm/2s2h/DeveloperTools/DebugConsole.cpp`) has `entrance`, `spawn`, `pos`, `file_select`,
   `reset`, `void`, `reload`, `give_item`, `quit` — nothing with a day/time vocabulary. SoH's
   `warp` is new work here, not a retarget.

9. **`audioBackendsMap` needs a `WEBAUDIO` entry.** `mm/2s2h/BenGui/MenuTypes.h:291-296`
   lists WASAPI/CoreAudio/SDL/Null. 2Ship's map combobox heals an unknown key to
   `comboMap->begin()->first`, which on an `unordered_map` is arbitrary — so merely opening
   Settings could silently switch the backend. Must land with the Web Audio player.

### Traps that do *not* apply here

- **No networking amputation.** See §4 above. CrowdControl is already behind
  `ENABLE_CROWD_CONTROL` and its source directory is absent from the tree.
- **No `ReadFramebufferToCPU`.** See above.

### A trap that arrives differently — the fault path

*(Corrected 2026-09-21: an earlier draft said this tree has no `fault.c`. It does —
`mm/src/boot/fault.c`, and it is compiled.)* `Fault_AddHungupAndCrashImpl`
(`mm/src/boot/fault.c:1171`) is `assert(0)`, with the decomp's
`*(u32*)0x11111111 = 0` commented out below it. Under a Release build `NDEBUG` compiles the
assert away, so the function **returns** and all 24 `Fault_AddHungupAndCrash` call sites
carry on with the corrupted state that brought them there — the same silent-continue trap
SoH had, reached by a different route. (The commented-out store would not have helped
either: in linear memory `0x11111111` is a valid address ~286 MB in and would not trap.)
Fixed with `abort()` under `__EMSCRIPTEN__`, which traps in wasm and gives the page a stack
trace.

### Traps that do apply, already diagnosed

Do not re-discover these. From the SoH branch:

- **`USE_OPENGLES` defaults to OFF** in LUS, so a naive Emscripten build compiles the
  *desktop* GL path and generates desktop GLSL against a WebGL2 context. Every shader fails.
  Set `USE_OPENGLES ON` plus `IMGUI_IMPL_OPENGL_ES3` for ImGui's backend, and
  `-sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2` so the GLES3 entry points resolve.
- **No GL context version is requested** outside `__APPLE__` in `gfx_sdl2.cpp`, so SDL hands
  back WebGL1. Request `SDL_GL_CONTEXT_MAJOR_VERSION=3` and the ES profile.
- **`glewInit()` is guarded `#if !defined(__linux__)`** and Emscripten does not define
  `__linux__`, so it compiles in. Same trap in `Context::GetAppBundlePath` (`/proc/self/exe`)
  and the crash handler.
- **`-pthread` in the final `else()`** requests a *shared-memory* build under Emscripten —
  exactly the SharedArrayBuffer/COOP-COEP dependency this target exists to avoid. Guard it
  (`mm/CMakeLists.txt:450,455`).
- **CMake de-duplicates repeated `--preload-file` tokens**, silently dropping the second
  archive. Use `SHELL:` so each flag stays with its path.
- **Browser logging dominates boot time.** One SoH boot emitted 7,670 console lines; each
  spdlog call crosses into JS and lands in devtools. Compiling trace/debug out took the same
  boot to 28 lines. Default `SPDLOG_MIN_CUTOFF` to info for this target. This is a
  performance fix, not a tidiness one — and it means "is the synchronous ResourceManager fast
  enough" cannot be measured until it is done.
- **Binaryen inlines any single-caller function regardless of size.** In SoH that folded 35
  `RegionTable_Init_*` builders into one 3.3 MB function, and V8's TurboFan crashed the
  renderer compiling it a few minutes into every session ("Aw, Snap", `EXC_BREAKPOINT` on a
  `ThreadPoolForegroundWorker`). Fix in the link:
  `-sBINARYEN_EXTRA_PASSES=--one-caller-inline-max-function-size=1000`. Reproduce in seconds
  with `--js-flags="--no-wasm-dynamic-tiering --no-wasm-lazy-compilation"`. 2Ship's Rando
  tables are the obvious candidate for the same shape.
- **`-Wl,-export-dynamic` must stay** until that inlining cap is in place: exported functions
  are never inlined, and it was masking the problem above.
- **SDL's Emscripten audio callback runs on the main thread** (a ScriptProcessorNode
  `onaudioprocess`), so any frame longer than ~20-40 ms crackles *however much* audio is
  queued — every `DesiredBuffered` value tunes a queue upstream of the real bottleneck. The
  fix is the LUS `WebAudioAudioPlayer`: an AudioWorklet fed by `postMessage` with transferred
  buffers, no SharedArrayBuffer, so the consumer runs on the audio thread. SDL stays as the
  fallback.
- **Indirect-call signature traps.** wasm traps when a call's declared and actual signatures
  differ; the decomp does this freely and native builds tolerate it. Enumerate with a native
  `-fsanitize=function` build *before* chasing them in a browser.
- **IDBFS is write-behind.** Nothing reaches IndexedDB until `FS.syncfs()`, and the config
  save in `~Context` never runs in a browser tab. (SoH sidestepped this entirely by making
  the host page own all storage — see Milestone 5.)

## The work

Milestones mirror SoH's, which were chosen so each one has a single possible cause of
failure. Do not reorder them.

### Milestone 0 — toolchain and baseline ✅ DONE

- `git submodule update --init --recursive` (all three submodules are currently unchecked-out
  in this tree).
- emsdk 6.0.9 (`~/emsdk`), the version the SoH build used.
- Python 3 on PATH: LUS now `find_package(Python3 REQUIRED)`s at configure time.
- A desktop build that can run `make Generate2ShipOtr`, since `2ship.o2r` must be produced by
  a host ZAPD and handed to the wasm build.
- Confirm the desktop build is green before changing anything.

### Milestone 1 — compiles and links ✅ DONE

**Outcome.** libultraship compiled under Emscripten on the first attempt, and the decomp
needed no source change to translate to wasm — everything below was build plumbing, as on the
SoH side. Two source bugs did surface at the link, both real and neither Emscripten's doing:
`framebuffer_effects.c` declared `gfx_create_framebuffer` with five parameters where
`interpreter.h` declares six (the last a C++ default argument a C prototype cannot express),
and `graph.c` called `PadMgr_ThreadEntry` with an argument it does not take. Native builds
tolerate both; wasm has typed calls, and wasm-ld had replaced every `gfx_create_framebuffer`
call with a stub that traps — which would have taken down the first frame using a framebuffer
effect. `--use-port=libpng` was needed beyond the plan's list, for `ColorPictograph`.


- Fork libultraship from `7f9b86a5`; port the wasm patch (see "Needs real work" §1). Land
  the non-audio parts first — `USE_OPENGLES`, the GL context request, the synchronous
  ResourceManager and spdlog executors, the libzip `PUBLIC` link fix — and leave
  `WebAudioAudioPlayer` for Milestone 4. Fork ZAPDTR from `ee3397a` (which is *already* this
  tree's pin — the SoH wasm fork branches from the same commit and adds 21 lines across 3
  files).
- Add an `EMSCRIPTEN` arm to the platform chains in `CMakeLists.txt` and `mm/CMakeLists.txt`.
- `CMake/emscripten-deps.cmake`, copied from the SoH branch.
- Emscripten ports on both the compile *and* link line: `--use-port=sdl2 --use-port=ogg
  --use-port=vorbis --use-port=zlib`. Mixing a port header with a host library is a
  silent-corruption bug.
- `-fwasm-exceptions` + `-sWASM_LEGACY_EXCEPTIONS=1`, `FMT_CONSTEVAL=constexpr`,
  `GFX_DEBUG_DISASSEMBLER OFF`, `SPDLOG_MIN_CUTOFF` default of info.
- Exclude the host tools: ZAPD and OTRExporter subdirectories, the `ZAPDLib` link
  (`mm/CMakeLists.txt:538-540`, `:608`), the `ExtractAssets` / `Generate2ShipOtr` custom
  targets, and `mm/2s2h/Extractor/` sources (the existing filter at `:114` targets `ship__`;
  confirm the glob the sources actually arrive through).
- Stub Opus in `mm/2s2h/mixer.c`.
- `INITIAL_MEMORY` 512 MB, `ALLOW_MEMORY_GROWTH`, `STACK_SIZE` 4 MB, `EXIT_RUNTIME=0`.

**Exit criterion:** `2ship.js` + `2ship.wasm` link. Expect the source edits to be small —
SoH's decomp translated to wasm without a single source change, and everything else was
build plumbing.

### Milestone 2 — single-threaded shims ✅ DONE

- Compile out the body of `OTRGlobals::RunExtract` (`mm/2s2h/BenPort.cpp:275`). Beyond the
  ZAPD dependency, its `while (!extractDone)` frame-pump would hang the tab outright: it
  draws `BenGui` popups in a loop that never returns to the event loop, so the click to
  dismiss one could never arrive — and it runs *before* `Main()`. Replace it with the
  archive preflight (below).
- Guard `Messagebox_ShowErrorBox` (`:954`), which calls `Extractor::ShowErrorBox`, and the
  unguarded `#include "Extractor/Extract.h"` at `:40`.
- Split `OTRAudio_Thread`'s body into `OTRAudio_FillBuffer`; call it inline from
  `Graph_ProcessGfxCommands` (`:1201`) and delete the handshake on that path. Do not start
  the thread (`:861`); do not join it (`:880`).
- Synchronous decode in `AudioSampleFactory.cpp:314-322`.
- `emscripten_set_main_loop` + the tick clock in `graph.c`.
- Preload `gamecontrollerdb.txt` (a missing file only logs, but the log is noise).

### Milestone 3 — boots to an ImGui frame — SKIPPED

Not needed: the full game rendered correctly on the first attempt, so there was never a
failure with three possible causes to isolate. Kept below in case a render problem later
needs the game taken out of the picture.

Before touching the game, stand up SDL + WebGL2 + ImGui alone via
`Fast3dWindow::RunGuiOnly()`. This isolates the window/render/GUI stack from both the game
loop and the archives, so a Milestone 4 failure has one cause instead of three.
`OTRGlobals`' constructor (`mm/2s2h/BenPort.cpp:146-178`) is the seam: resource manager with
`2ship.o2r` only, then window, then GUI — everything after is game.

Force `ImGuiConfigFlags_ViewportsEnable` off: it needs real OS windows.

Delete this path once Milestone 4 lands; it will rot otherwise.

### Milestone 4 — boots to title, with sound ✅ DONE

- Pre-mount `2ship.o2r` (via `--preload-file`, `SHELL:`-wrapped) and accept `mm.o2r` from the
  host.
- The archive preflight that replaces `RunExtract`: refuse to start on a port archive from
  another build or a game archive from an incompatible version, and report *why* through the
  embedder bridge. Without it, a missing or stale `mm.o2r` fails at the first resource load,
  in a loop that never returns to the page and that no event reports.
- Land `WebAudioAudioPlayer` in the LUS fork and make it the browser default, SDL the
  fallback.
- Deepen the audio target; keep the `static_assert` that ties it to the player's drop
  threshold.
- Measure a Release build. SoH's came to 24.7 MB raw / **4.2 MB brotli**, which settled the
  question of whether any splitting or streaming strategy was needed (it was not). Expect a
  similar order here; measure before deciding anything.

**Exit criterion:** boots past the title into the opening cutscene (MM has no attract demo;
the flow is N64 logo → TitleSetup → `z_opening.c` running `Play_Init`), drawing textured
Play-state geometry — verified by screenshot rather than inference, since an early
flat-gradient frame is a transition fade, not proof of rendering.

### Milestone 5 — playable

- Keyboard input, save persistence, mod layer.
- **Storage belongs to the host page, not the module.** SoH's second pass replaced an IDBFS
  design with `Module.shipFiles` — the page writes bytes into MEMFS during `preRun` and
  receives `file-saved` / `file-removed` events back. That removes the write-behind
  `syncfs()` problem entirely, keeps the module storage-agnostic, and means the published
  artifact contains nothing extracted from a ROM. Do the same; do not rebuild IDBFS.
- `EmbedderBridge`, retargeted to MM's vocabulary, plus `…_RunConsoleCommand` and
  `…_GetStats`.
- `host.html`, `EMBEDDING.md`, `HOST-API.md`.
- The bun + Playwright suite: boot, audio, timing, soak, artifacts (which asserts the
  Binaryen locals cap), host-api.
- Runtime CVar defaults rather than deletions for anything that misbehaves:
  `MultiViewports=0`, MSAA 1, one frame per tick.

### Milestone 6 — ROM → o2r in the browser

`2ship-extract.{js,wasm}`: ZAPD + OTRExporter + the pure ROM checks as a separate module the
host runs in a worker. Modelled on SoH's `soh/wasm/extract/`, which lists the ZAPD and
OTRExporter sources explicitly rather than using their own CMakeLists (ZAPD's adds `-pthread`
on every non-Darwin target and requires a libpng package a cross build cannot find).

Cheaper here than it was there: this tree ships **2** extraction configs
(`mm/assets/extractor/Config_GC_US.xml`, `Config_N64_US.xml`) against SoH's 14, so the
embedded recipe set is far smaller.

## What not to strip

Stripping the GUI and enhancements is tempting and is the wrong call:

- **316 files** under `mm/` call `CVarGet*`. Enhancements are wired in through GameInteractor
  hooks and `ShipInit`, not isolated behind a flag. Removing them produces link errors and
  dead branches across the tree — strictly more work than leaving them compiled.
- ImGui is the **only** debugging surface in a browser tab, where no native debugger can
  attach. The console commands are worth more here than on desktop, not less.

If something in that layer blocks boot, disable it **at runtime via CVar defaults** —
reversible, no deletion. The amputations in Milestone 1 are a different axis: they target OS
services that do not exist in a browser, not UI surface area.

## Effort

Assuming the milestone order above:

| | |
|---|---|
| M0 toolchain + baseline | 0.5 day |
| M1 CMake, amputations, Opus stub | 1–2 days |
| M1 libultraship rebase (incl. Web Audio) | ≤1 day |
| M1 **shader re-validation under WebGL2** | **1–3 days — the real unknown** |
| M2 frame loop, audio, thread shims | 1 day (near-copy) |
| M3 GUI-only boot | 0.5 day |
| M4 archives, title, audio tuning | 1–2 days |
| M4/M5 depth readback | 1–2 days |
| M5 EmbedderBridge, host.html, docs | 2–3 days |
| M5 storage enumeration + ModMenu healing | 1–2 days |
| M5 test suite port | 1–2 days |
| M5 **measure: MM perf, scene-load hitching, memory ceiling** | 1 day |
| M6 extractor module | 2–3 days |

**2–3 weeks to a playable browser build**, against what was a couple of months of discovery
on the SoH side. The total is much the same as the first draft's, but the risk sits in
different places: the LUS rebase and the framebuffer effects both turned out to be small,
and the shader rewrite, the storage surface and plain unmeasured performance took their
place.

## Open questions

- Whether LUS's rewritten `default.shader.glsl` compiles under WebGL2 with `USE_OPENGLES`.
  This is the one part of the 80-commit gap whose cost is not known.
- Whether depth readback needs a depth-to-color path or just a CVar.
- Whether the synchronous ResourceManager executor is fast enough at scene load, or visibly
  hitches. Unanswered on the SoH side too — the logging confound was removed but the question
  was never retested. Termina Field is the load to measure.
- Memory ceiling. wasm32 caps at 4 GB and `-sMAXIMUM_MEMORY=4GB` works in current desktop
  browsers, but Safari and iOS are tighter. Measure this tree's desktop RSS before committing.
- Performance. MM is a heavier game than OoT; entirely untested here.
- Is `-fwasm-exceptions` acceptable for the target browsers?
