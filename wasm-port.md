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

**Milestones 0-4 are done, bar the audio player.** The game boots in a browser, renders
Termina/Clock Town correctly, runs at the right speed, plays audio and responds to the console.
Milestone 3 (a GUI-only boot) was skipped: the full game rendered on the first attempt, so
there was nothing to isolate. Milestone 4 was marked complete on the strength of "plays audio",
which it does — through SDL, on the page's main thread. The player it was supposed to land is
§"Milestone 4b".

| | |
|---|---|
| `2ship.wasm` | 23.3 MB raw · 6.4 MB gzip · **3.5 MB brotli** (3.46; 3.56 with `-export-dynamic`) |
| `2ship.js` / `2ship.data` | 0.2 MB / 1.8 MB |
| Tick rate | 60/`R_UPDATE_RATE` Hz, within 5%, one frame drawn per tick |
| Heap | 512 MB at the initial size, no growth observed over ~2 minutes |
| Tests | 38, passing (`mm/wasm/tests`) — two of them vacuously; see below |

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
codecs. The window now bounds the damage, but that number is still wrong.

*Narrowed 2026-09-21.* The size cannot come from a note's tuning, which was the first
suspicion. `numSamplesToLoad = (frequencyFixedPoint * numSamplesPerUpdate * 2 +
samplePosFrac) >> 16` (`mm/src/audio/lib/synthesis.c:964-966`), and two hard bounds apply:

- `frequencyFixedPoint` is a **`u16`** (`mm/include/z64audio.h:435`), and
  `AudioPlayback_NoteSetResamplingRate` (`mm/src/audio/lib/playback.c:125-145`) clamps every
  sample that is not a synthetic wave to `1.99998` before the conversion. `CODEC_S16` takes
  the non-synthetic path, so the ratio is capped at ~2.0 whatever tuning the sample carries —
  a streamed 48 kHz file does not get to ask for 30×.
- `numSamplesPerUpdate` is structurally small: `updatesPerFrame = (target + 0x10) / 0xD0 + 1`
  (`mm/src/audio/lib/heap.c:956`), so the per-update count lands near 208 regardless of the
  sampling frequency. With `refreshRate = 60` at 32 kHz it is 176/184/168, and the
  final-update remainder is 192.

So a healthy clear is at most `(≈400 + 16) * 2` ≈ **832 bytes**, and 10,784 samples requires
either `numSamplesPerUpdate ≈ 5392` — which nothing in that derivation can produce — or a
**negative** `numSamplesPerUpdate` wrapping through the `u32 numSamplesToLoadFixedPoint` at
`synthesis.c:904`.

A second tell points the same way: `codec` is a **4-bit field** (`mm/include/audio/soundfont.h:51`)
and vanilla MM samples are `CODEC_ADPCM` (0) or `CODEC_SMALL_ADPCM` (3). Reaching the
`CODEC_S16` / `CODEC_OPUS` arm at all on a stock boot with no custom audio means the `Sample`
the note pointed at was already garbage. The Opus stub is therefore *not* the suspect it
looked like: it is downstream of the same bad pointer.

Which reframes the whole thing — **the oversized clear is a symptom, not the origin.** Widening
the window contained the blast radius, which is why the crashes stopped, but the first write is
still unexplained and may still be happening harmlessly inside the 128 KB buffer.

Next step, cheaper than more theorising: at `synthesis.c:1151`, when
`numSamplesToLoadAdj > 2 * numSamplesPerUpdate`, log `numSamplesPerUpdate`,
`frequencyFixedPoint`, `sample->codec`, `sample` and `noteIndex` once and run the ASan recipe
below. Do it on **desktop as well**, with the same `mm.o2r` — if it reproduces there, this
leaves the wasm port's scope entirely and becomes a 2Ship bug report, the same way the config
use-after-free did.

Two guards remain in `mm/src/audio/sfx.c` as canaries — a bound on the bank walk and a refusal
to unlink the list sentinel. The failure they catch is silent and total, and they cost one
comparison per entry.

**Resolved 2026-09-23: it was never a bad pointer.** `AudioPlayback_ProcessNotes`
(`mm/src/audio/lib/playback.c:203`) carried an N64 memory-map check, `(uintptr_t)parentLayer <
0x7FFFFFFF → skip this note`, already compiled out for Wii U. On 64-bit desktop no pointer is
below that, so it never fired. On wasm32 every pointer is, so it skipped **every note attached to
a sequence layer**: no envelope, no vibrato, no `AudioPlayback_InitSampleState`, and synthesis
never saw the note while it was held. A note only became audible when its layer released it,
starting at one attack step with the decay already forced on — the "melody right, rhythm wrong,
everything staccato" music the browser build had from the first boot. The same skip meant a
note's `synthState` was never reset for a new occupant of the slot, so `AudioSynth_ProcessSample`
ran on the previous note's sample position; a stale position past a shorter sample's end makes
`numSamplesUntilEnd` negative, and the `skip:` path then issues the oversized clear. So the
21,600-byte write was downstream of the skipped update, not of a garbage `Sample*` — the
`CODEC_S16` attribution was wrong.

Measured on the same 60 s of Termina Field before and after guarding the check out under
`__EMSCRIPTEN__`: synthesis-boundary discontinuities fell from 2.3 % of 528/560-frame boundaries
to the interior rate, 6× amplitude cliffs from 25 to 1, the per-frame RMS floor rose from 19 to
500, and note iterations reaching synthesis roughly doubled with the small-ADPCM share (the
sequenced instruments) going from 2 % to 12 %. Tick rate, drops and the player were unchanged
and were never the problem. The scripts are the PCM tap and analysis under the session
scratchpad (`audio-capture/capture.ts`, `analyse.py`, `boundaries.py`, `holes.py`); the tap
wraps the global `AudioWorkletNode` from a test `initScript`, so it needs no rebuild.

What stays: a counter of oversized loads, `synthOversized` in `Ship_GetStats`
(`gWasmSynthOversizedLoads`, `synthesis.c`), which the audio tests hold at zero; the widened
DMEM window; and the two `sfx.c` canaries.

Found on the way, **desktop-only, not fixed here**: `aMixImplSSE2` in `mm/2s2h/mixer.c:730-733`
does `outx7fffLoVec = _mm_unpacklo_epi16(outx7fffLoVec, outx7fffHiVec)` and then reads the
overwritten `outx7fffLoVec` in the `_mm_unpackhi_epi16` on the next line, and the same for
`inxGainLoVec`/`inxGainHiVec`, so samples 4-7 of every 8-sample block get the wrong mix on
x86-64 Windows and Linux builds. It is in `develop`, never runs on wasm (no `-msimd128`) or on
arm64 Macs (NEON), and `aMixImplRef` and `aMixImplNEON` are correct. The `#if 0` AVX2 copy has the
same bug. Report upstream with a unit test comparing the three implementations on random input.

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

### Found by comparing against the finished SoH branch — 2026-09-21

The SoH port was written up in `~/code/soh-wasm-port-notes.md` and its branch re-read against
this one, commit by commit. The headline is that the expensive things are already right: the
frame loop and tick clock, one draw per tick, the whole build-flag table including both halves
of the V8/TurboFan pair, the `-pthread` exclusion, the `SubmitTask` seam, the synchronous
logger, and the compile-time spdlog cutoff are at parity or verbatim-identical. Five of the
eight LUS wasm commits are here already. **The entire LUS-side gap is audio.**

Four things did come out of it, none of them in the frame loop.

**1. The pause screen does a synchronous GPU→CPU readback.** This document previously claimed
(§"Resolved along the way") that `ReadFramebufferToCPU` is never reached. That is wrong for MM.
The chain is live: `mm/src/code/z_play.c:1520` (the pause background prerender) →
`FB_WriteFramebufferSliceToCPU` (`mm/2s2h/framebuffer_effects.c:114`) → `gDPReadFB` →
`gfx_read_fb_handler_custom` (`libultraship/src/fast/interpreter.cpp:4183-4184`), which does a
`gfx->Flush()` and then `ReadFramebufferToCPU` — a blocking
`glReadPixels(0, 0, 320, 240, GL_RGBA, GL_UNSIGNED_BYTE)` of 307 KB plus a 76,800-iteration
conversion loop (`libultraship/src/fast/backends/gfx_opengl.cpp:1000-1023`). A full pipeline
flush and a readback stall, inside the frame callback, on a routine player action. Two more
live sites in `mm/src/overlays/actors/ovl_En_Arrow/z_en_arrow.c:723` and `:748`.

**In SoH this function has no callers** — only a declaration and a definition. So that port
never paid the cost, which is why its notes do not mention it and why the assumption carried
over here untested. Its notes also say this path uses `GL_UNSIGNED_SHORT_5_5_5_1`, "which
WebGL2 `readPixels` forbids"; that is stale. Our LUS already reads RGBA8 and converts, so it is
spec-legal — which is precisely *why* it runs rather than failing. The problem is the
synchronisation, not the format.

**2. `GetPixelDepth` queues per-coordinate blits and then reads nothing.** In
`libultraship/src/fast/backends/gfx_opengl.cpp:1026-1090`, both
`glReadPixels(… GL_DEPTH_STENCIL …)` calls sit behind `#ifndef USE_OPENGLES`, which this build
now sets. The single-coordinate branch declares `uint32_t depth_stencil_value` at `:1035`,
never writes it, and feeds it to `res.emplace(…, (depth_stencil_value >> 18) << 2)`. The
multi-coordinate branch still runs one `glBlitFramebuffer` **per coordinate per frame**
(`:1063-1074`) and then reads nothing at all. MM drives this harder than OoT:
`mm/src/code/z_lights.c:411` once per `LIGHT_POINT_GLOW` light per frame, plus
`mm/src/code/z_kankyo.c:532` and `mm/src/code/sys_cfb.c:133`.

**3. Interpolation still builds its recording tree every frame.** `target_fps` is correctly
forced (`mm/2s2h/BenPort.cpp:1365`), so no extra frames are *drawn* — but
`FrameInterpolation_StartRecord`
(`mm/2s2h/Enhancements/FrameInterpolation/FrameInterpolation.cpp:468-470`) sets
`is_recording = true` whenever `GetInterpolationFPS() != 20`, independently of that. The whole
matrix and gfx-op recording tree then gets built every frame for data nothing consumes, and
`mm/src/code/z_kankyo.c:3394` switches the skybox stars onto the slower projection-matrix path.
Reachable two ways in a browser: the unguarded slider at `mm/2s2h/BenGui/BenMenu.cpp:623-652`,
or an embedder handing over a desktop config — which is the *documented* workflow
(`mm/wasm/HOST-API.md`).

**4. A desktop config silences the build, and two tests hide it.** `Audio::GetSavedAudioBackend`
(`libultraship/src/ship/audio/Audio.cpp:69-84`) returns `WASAPI` or `COREAUDIO` from the config
string on any platform. Under Emscripten neither `case` exists in `InitAudioPlayer` (`:17-35`),
so it falls to `default:` → `NullAudioPlayer` — silent, with no diagnostic — and
`SetCurrentAudioBackend` writes the bad value straight back. SoH fixed this in LUS `30d0cf54`
by resolving an absent backend against `mAvailableAudioBackends`. Separately,
`mm/2s2h/BenGui/Menu.cpp:316` passes the full `audioBackendsMap`, so the browser build offers
*Windows Audio Session API* and *CoreAudio* in the dropdown; SoH's `f3d5e096c` filters it
through `GetAvailableAudioBackends()`.

Two tests are green over this and should not be:

- `mm/wasm/tests/smoke.test.ts:26` boots `staleDesktopConfig()` — which sets
  `AudioBackend: "coreaudio"` (`mm/wasm/tests/lib/configs.ts:26-31`) — and only asserts that a
  picture appears. It never checks that anything is audible.
- `mm/wasm/tests/timing.test.ts:32` sets `config.CVars.gSettings.InterpolationFPS = 60`. That is
  SoH's CVar path (`CVAR_SETTING("InterpolationFPS")`). This tree has no `CVAR_SETTING` macro:
  the CVar is the flat `gInterpolationFPS` (`mm/2s2h/BenPort.cpp:867`,
  `mm/2s2h/BenGui/BenMenu.cpp:624`). The test writes a key nothing reads, interpolation stays at
  20, and `drawsPerTick ≈ 1` passes for free — so the one-draw-per-tick guarantee is untested.

### Not started

Milestone 5 (storage, mods, keyboard polish), Milestone 6 (the ROM converter), the Web Audio
player, and depth readback. The build plays through SDL's Emscripten audio backend, whose
callback runs on the page's main thread, so any long frame is audible — and the deep queue
already configured (`WASM_AUDIO_DESIRED_BUFFERED 4320`, `mm/2s2h/BenPort.cpp:155`) is currently
135 ms of latency buying nothing, because the code that drains it is the thing being starved.

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

4. **Depth readback, and a framebuffer readback that is worse than depth.**
   *(Revised 2026-09-21 after review. Revised again the same day: the second bullet below was
   wrong, and wrong in a way worth recording.)*

   - `ReadFramebufferToCPU`'s `GL_UNSIGNED_SHORT_5_5_5_1` readback **is already fixed
     upstream** at `7f9b86a5`: it reads RGBA/UNSIGNED_BYTE and converts on the CPU
     (`libultraship/src/fast/backends/gfx_opengl.cpp:1000-1023`), so it is spec-legal under
     WebGL2.
   - ~~2Ship never issues it anyway: there is no `gsSPReadFB` / `G_READFB` anywhere in
     `mm/src` or `mm/2s2h`.~~ **False.** The macro is spelled **`gDPReadFB`**, and grepping
     for the other two names found nothing while three live call sites sat in the tree:
     `mm/2s2h/framebuffer_effects.c:114` (reached from `mm/src/code/z_play.c:1520`, the pause
     background prerender) and `mm/src/overlays/actors/ovl_En_Arrow/z_en_arrow.c:723` / `:748`.
     Being spec-legal is what makes this bite: the readback *runs*, synchronously, with a
     pipeline flush in front of it, every time the player pauses. See §"Found by comparing
     against the finished SoH branch", item 1. A negative grep is not evidence unless the
     spelling was checked against the header first.
   - The *other* MM framebuffer effects (`FB_CopyToFramebuffer` / `FB_DrawFromFramebuffer` in
     `z_play.c` and `z_visfbuf.c`, and the rest of `framebuffer_effects.c`) do go through
     `OTR_G_COPYFB` → `CopyFramebuffer` → `glBlitFramebuffer`, which WebGL2 has. That part of
     the earlier revision holds.

   What is left is depth readback, compiled out under `USE_OPENGLES` because WebGL2
   `readPixels` cannot read `GL_DEPTH_STENCIL`. *(Corrected 2026-09-21: "leaving
   `depth_stencil_value` uninitialized" was only half of it. The single-coordinate branch does
   read an uninitialised local, but the batched branch fills a zero-initialised
   `std::vector<uint32_t>`, which reads as **fully occluded** — so the sun flare and the point
   glows were not flickering, they were never drawing at all.)*
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
- **`-Wl,-export-dynamic` is desktop-only now.** It had to stay until that inlining cap was in
  place, because exported functions are never inlined and it was masking the problem above.
  With the cap it went: exports fell from 1561 to 12, `2ship.js` from 429 KB to 223 KB and
  `2ship.wasm` by 460 KB, with `artifacts.test.ts` and `smoke-tiering.test.ts` still passing.
  If tier-up regresses, lower the cap rather than restore the flag.
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

### Milestone 4 — boots to title, with sound ✅ DONE, minus the player

- Pre-mount `2ship.o2r` (via `--preload-file`, `SHELL:`-wrapped) and accept `mm.o2r` from the
  host.
- The archive preflight that replaces `RunExtract`: refuse to start on a port archive from
  another build or a game archive from an incompatible version, and report *why* through the
  embedder bridge. Without it, a missing or stale `mm.o2r` fails at the first resource load,
  in a loop that never returns to the page and that no event reports.
- ❌ Land `WebAudioAudioPlayer` in the LUS fork and make it the browser default, SDL the
  fallback. **Not done** — the milestone was marked complete on the strength of "plays audio",
  which it does, through SDL. The plan is now §"Milestone 4b" below.
- Deepen the audio target; keep the `static_assert` that ties it to the player's drop
  threshold. Done (`mm/2s2h/BenPort.cpp:155-158`, `:902-906`) — but see 4b: the depth is only
  headroom once the consumer is off the main thread.
- Measure a Release build. SoH's came to 24.7 MB raw / **4.2 MB brotli**, which settled the
  question of whether any splitting or streaming strategy was needed (it was not). Expect a
  similar order here; measure before deciding anything.

**Exit criterion:** boots past the title into the opening cutscene (MM has no attract demo;
the flow is N64 logo → TitleSetup → `z_opening.c` running `Play_Init`), drawing textured
Play-state geometry — verified by screenshot rather than inference, since an early
flat-gradient frame is a transition fade, not proof of rendering.

### Milestone 4b — the Web Audio player

**Why.** Emscripten's SDL2 plays through a `ScriptProcessorNode`, whose `onaudioprocess` is a
**main-thread event** sized by `SampleLength`. The code that moves samples from SDL's queue to
the device is therefore the thing a long frame starves, so queue depth is not the lever it
looks like — any frame over roughly 20–40 ms is audible however much is queued. SoH spent days
tuning the queue before working this out; do not repeat that. The fix is a new LUS player whose
consumer runs on the browser's audio rendering thread, at which point the 135 ms target already
configured here becomes real headroom.

Worse here than in SoH: MM changes `R_UPDATE_RATE` far more often (2 in the pause menu and every
message box, 1 on title / file select / "Dawn of the Nth Day"), so long frames and rate
transitions are both more frequent.

**What is already in place.** More than it looks. The game side is done and commented for a
player that does not exist yet — `WASM_AUDIO_DESIRED_BUFFERED 4320` and
`WASM_AUDIO_DROP_THRESHOLD 6000` (`mm/2s2h/BenPort.cpp:155-158`), the `static_assert` tying the
target to the drop threshold (`:902-906`), `Ship_EmbedderCountAudioDrop` and the `audioDrops`
counter (`mm/2s2h/EmbedderBridge.cpp:207-228`), and the inline `OTRAudio_FillBuffer()` at the
top of `Graph_ProcessGfxCommands` (`:1348-1353`). So are the diagnostics: `mm/wasm/host.html:76-86`
already reads `Module.LUSWebAudio`, and `mm/wasm/tests/lib/game.ts:278` already has the
`webAudio()` accessor and `BootOptions.initScript`. **Nothing on the 2Ship side needs porting
except a menu label and the availability filter.**

The two LUS forks are also the same generation — same `src/ship/audio/` layout, same
`SoundMatrixDecoder`, and `AudioPlayer.cpp` / `SDLAudioPlayer.cpp` are byte-identical between
them. The player drops in unchanged.

**Step 1 — the three new files, verbatim from SoH's LUS** (`f859ced9` plus the review fixes in
`5eaac696`; take them as one change rather than reproducing the first commit's two bugs):

| File | Size | Note |
|---|---|---|
| `libultraship/include/ship/audio/WebAudioAudioPlayer.h` | ~34 lines | Only the `SOH [WASM]` → `2S2H [WASM]` marker changes. |
| `libultraship/src/ship/audio/WebAudioAudioPlayer.cpp` | ~61 lines | `kRingCapacityFrames = 16384`, `kMaxQueuedFrames = 6000`. |
| `libultraship/src/ship/audio/WebAudioAudioPlayer.js` | ~291 lines | The `--js-library`. |

The design, for the record: an `AudioWorklet` (processor name `lus-audio`) fed by `postMessage`
with **transferred** `Int16Array`s copied out via `HEAP16.slice(...)` — no `SharedArrayBuffer`,
so no COOP/COEP and no constraint on any embedder. The worklet posts back
`{consumed, dropped, underruns}` every fourth render quantum and immediately on any underrun;
`Buffered()` is `max(0, queued - consumed - dropped)`. On underrun it fills the quantum with
silence and **does not advance `readPos`**, so queued audio plays back intact rather than being
skipped. It resamples with linear interpolation when the browser refuses
`new AudioContext({sampleRate: 32000})`. Output honours `GetNumOutputChannels()` (2 or 6),
duplicating the last source channel if the destination is wider — so this tree's 5.1 path is
covered without extra work.

**Step 2 — LUS wiring. This is where 2Ship diverges from SoH** and the one part that is not a
copy. SoH's LUS moved the backend-name mapping into `Config.cpp`; ours keeps it in `Audio.cpp`
behind an `mConfig` member. So:

- `include/ship/audio/Audio.h:12` — insert `WEBAUDIO` **before** `NUL`. (LUS persists the
  backend as a string, so the insertion point is safe; a CVar storing the index would not be.)
- `include/ship/audio/AudioPlayer.h` — add `virtual bool HasFailed() { return false; }`,
  Doxygen-commented to match the file, and the `#ifdef __EMSCRIPTEN__` include at the bottom
  beside the SDL and Null ones. `~AudioPlayer()` is already `virtual` here, so no destructor
  work.
- `src/ship/audio/Audio.cpp`:
  - `InitAudioPlayer()` — add `case AudioBackend::WEBAUDIO` under `#ifdef __EMSCRIPTEN__`, and
    on `Init()` failure fall back to SDL rather than `NUL`.
  - `Init()` — push `WEBAUDIO` **first**, before `SDL`, so it is the browser default; then the
    `std::find` availability guard from item 4 above. Keep the trailing `SetAudioChannels(...)`.
    Needs `#include <algorithm>`.
  - `GetSavedAudioBackend()` — the `"webaudio"` string, and `#ifdef __EMSCRIPTEN__ return
    AudioBackend::WEBAUDIO;` in the default chain. Keep the `"pulse"` → SDL migration ahead of
    it.
  - `SetCurrentAudioBackend()` — `case WEBAUDIO: mConfig->SetString(…, "webaudio")`.
  - `GetAudioPlayer()` — the `HasFailed()` poll. Every audio entry point in
    `src/libultraship/bridge/audiobridge.cpp` funnels through it, so the once-per-frame
    `AudioPlayer_Buffered()` *is* the poll; no extra plumbing.
  - New `FallBackToSdl(const char* why)` — sets `mAudioBackend` and calls `InitAudioPlayer()`
    **directly**. This matters more here than in SoH, because our `SetCurrentAudioBackend`
    calls `mConfig->Save()` unconditionally (`Audio.cpp:126`): routing the fallback through it
    would persist `"sdl"` and pin every future session to the main-thread player over one
    session's CSP failure.
- `src/ship/CMakeLists.txt` — an `if (EMSCRIPTEN)` block passing the `--js-library` via
  `target_link_options(libultraship PUBLIC "SHELL:…")` plus an `INTERFACE_LINK_DEPENDS` so
  editing the JS relinks, with `else()` filtering the files out of the desktop build.

**Step 3 — game side.** Two small things: `{ Ship::AudioBackend::WEBAUDIO, "Web Audio" }` in
`mm/2s2h/BenGui/MenuTypes.h:291`, and the availability filter from item 4 — as an
`unordered_map` returned by reference and passed as `&AvailableAudioBackendsMap()` to match this
tree's `Combobox` signature (`mm/2s2h/BenGui/UIWidgets.hpp:673` takes a pointer). **Do these
together:** adding the enum member is exactly what makes "Web Audio" selectable on desktop,
where it would play through the null player.

**Step 4 — tests and docs.** Port the four tests from SoH's `soh/wasm/tests/audio.test.ts`
(a backend this build lacks plays through Web Audio; no underruns on the title screen; a worklet
rejected via `initScript` falls back to SDL *without* persisting it; SDL still works when the
config names it), and replace the stale "no Web Audio player yet" header in
`mm/wasm/tests/audio.test.ts`. Then the `Window.AudioBackend` row in `mm/wasm/EMBEDDING.md`,
plus a note that **a gamepad button is not a user gesture** — a controller-only session needs
one touch or click before the context will start.

**Traps, all of which cost SoH a review round:**

- **`--js-library`, not `EM_ASM`.** The macro splits its code block at every comma outside
  parentheses, which rules out object literals; the JS is full of them, and a file allows
  comments.
- **`DoInit()` returning true is not "audio works".** The worklet loads asynchronously
  afterwards. Without `HasFailed()`, a page whose CSP forbids `blob:` scripts is silent for the
  whole session with nothing but one `console.error`.
- **Keep the resume listeners armed for the session.** A context can leave `running` with no
  `visibilitychange` — an iOS phone call, Siri, a headphone or Bluetooth route change. The
  250 ms `navigator.userActivation.hasBeenActive` poll is what rescues a controller-only
  session after a gesture anywhere on the page.
- **Do not count underruns while the tab is hidden.** A throttled loop starves the worklet by
  design; counting those makes the metric useless.
- **Read `HEAP16` at call time, never cache a heap view** — memory growth reassigns it. The
  processor function must also be hermetic: it is stringified into a blob and evaluated in the
  worklet's global scope, where only the Web Audio globals exist.
- **`6000` now lives in three places** — the new player, `SDLAudioPlayer::DoPlay`, and
  `mm/2s2h/BenPort.cpp:158`. They must stay equal or the `static_assert` guards nothing.

**Exit criterion:** the four ported tests pass, and `Module.LUSWebAudio.underruns` stays at zero
across a pause, a scene transition and a camera flip — the three things that were audible
before.

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

## What is left

Milestones 0-4 are done bar the audio player (see Status, and Milestone 4b). What remains, in
the order I would do it — the first four rows are small, and every one of them is currently
masked by a test that passes:

| | | |
|---|---|---|
| **Audio backend availability guard + menu filter** | ~15 lines | Port LUS `30d0cf54` and SoH's `f3d5e096c`. A config naming `coreaudio` silences the build through `NullAudioPlayer` with no diagnostic. Do this first: otherwise it is a false lead the moment anyone touches audio. Add `audioDrains(...)` to `mm/wasm/tests/smoke.test.ts:26`, which covers this case today and never listens. |
| **Force `GetInterpolationFPS()` to 20 under Emscripten** | ~1 hour | `mm/2s2h/BenPort.cpp:861-870`. Closes the `is_recording` path for a host-supplied desktop config, not just the UI — better than SoH's UI-only guard — and lets `:1365` drop its `#ifdef`. Guard the three widgets at `mm/2s2h/BenGui/BenMenu.cpp:623-652` too, so they are not inoperative controls. |
| ~~**Early-return `OTRGetPixelDepth*` under Emscripten**~~ | done | Landed. Removes a `glBlitFramebuffer` per coordinate per frame that nothing reads, the uninitialised single-coordinate read, and a `glDisable(GL_SCISSOR_TEST)` that `gfx_opengl.cpp` never re-enabled. Returns the game's own no-depth sentinel, so the sun flare, the point glows and the two Invadepoh UFO flares now draw — they previously never drew, because the batched readback was zero-filled. **Needs an eyeball**: they also draw through geometry that should hide them. |
| **Fix the vacuous timing test** | minutes | `mm/wasm/tests/timing.test.ts:32` → `config.CVars.gInterpolationFPS = 60`. Until then the one-draw-per-tick guarantee is untested. |
| **Web Audio player** | 1–2 days | See Milestone 4b for the full plan. Also the cheapest mitigation for the pause-screen readback stall, which becomes survivable rather than audible. |
| ~~**Why the DMEM clear was oversized**~~ | done | Not corruption: `playback.c:203` skipped every layered note on wasm32, which was also why the music was wrong. See "The audio overrun", *Resolved 2026-09-23*. |
| **The pause-screen framebuffer readback** | 1–2 days, or 0 | `z_play.c:1520` → a synchronous 307 KB `glReadPixels` plus a 76,800-iteration conversion, with a pipeline flush in front, every time the player pauses. SoH never reached this code. Land Web Audio first and measure: if the stall is not visible, a PBO + async readback is not worth the frame of staleness. |
| **`-fsanitize=function` sweep** | 0.5 day | Two signature mismatches were found, but both by wasm-ld — which only sees *direct* calls. Mismatches through function-pointer slots trap at runtime, and M5 exercises far more of the tree. Enumerate them on a native build before chasing one in a browser. |
| **Storage (M5)** | 1–2 days | Enumerate 2Ship's write paths — `SaveManager` (~30 sites, its own `saves/`), `BinarySaveConverter`, three TimeSplits trackers, `DeveloperTools`, `DeleteFileOnDeath`, `Rando/StartingItems`, `Rando/ExcludedChecks`, `Rando/Spoiler/File`, `PresetManager` — against the bridge's watch list, which currently covers the config and `saves/` only. `NewFileSetup.cpp:126` parses a spoiler file through an unguarded `json::parse`. |
| **Mods (M5)** | 1 day | `ModMenu.cpp` scans a mods directory; SoH needed a rewrite of its equivalent to tolerate a config listing mods absent from MEMFS. Untested here. |
| **Depth readback** | 1–2 days | Compiled out under `USE_OPENGLES` because WebGL2 `readPixels` cannot read `GL_DEPTH_STENCIL`. Four consumers: `z_kankyo.c:532` (sun), `z_lights.c:411` (glow), and `z_en_invadepoh.c:1301` / `z_en_invadepoh_demo.c:581` (UFO flares), the last two reaching the single-coordinate branch every frame because neither calls Prepare. Occlusion is now permanently off (see above), so these effects draw through walls. Needs a depth-to-color path or a CVar to suppress them. |
| **Measure** | 1 day | Performance under load, scene-load hitching on the synchronous ResourceManager (Termina Field is the load to measure), and the memory ceiling on Safari/iOS. All still unmeasured. |
| **Controllers, input polish** | 1 day | Emscripten's SDL2 has a working Gamepad-API backend; untested. |
| **A `warp` console command** | 1 day | 2Ship has `entrance`/`spawn`/`pos` but nothing with a day-and-time vocabulary, so a host cannot boot straight into a scene the way SoH's can. New work, not a retarget. |
| **M6: ROM -> o2r converter** | 2–3 days | `2ship-extract.js`, modelled on SoH's `soh/wasm/extract/`. Cheaper here: 2 extraction configs against SoH's 14. |

Roughly **2 weeks** to a build that is playable, persists what it should, and converts its
own ROM. The first four rows are a day between them and remove three sources of per-frame work
plus one false lead; the Web Audio player is what stands between "renders correctly" and
"sounds right".

### Resolved along the way

Things earlier drafts flagged as risks, recorded so they are not re-litigated:

- **The libultraship rebase** — ~1 day, as the review predicted; the alarming upstream line
  counts were Doxygen. LUS compiled under Emscripten on the first attempt.
- **The shader rewrite** — upstream replaced `default.shader.{fs,vs}` with a single
  `default.shader.glsl` between the pins, and an earlier draft called re-validating it under
  WebGL2 "the real unknown". It needed nothing: `USE_OPENGLES ON` plus
  `IMGUI_IMPL_OPENGL_ES3` was sufficient and the game rendered correctly on the first boot.
- **MM's framebuffer *blits*** — not harder than OoT's; `FB_CopyToFramebuffer` and friends go
  through `glBlitFramebuffer`, which WebGL2 has. (This entry used to end "and
  `ReadFramebufferToCPU` is never reached", which was wrong — see §"Needs real work" item 4.
  The readback is reached, three times, and it is the most expensive thing in the port after
  audio.)
- **The V8 tier-up crash** that cost the SoH port a session — the Binaryen inlining cap
  carried over and works; `artifacts.test.ts` and an eager-tier-up run both pass.
- **The audio handshake** — I diagnosed the crash as the single-threaded integration needing
  a rewrite. It was a stray write. The integration is fine.

## Open questions

- ~~What corrupted the note's `Sample` before `AudioSynth_ProcessSample` asked to clear 21,600
  bytes of DMEM.~~ Answered 2026-09-23: nothing did; see "The audio overrun".
- Whether depth readback needs a depth-to-color path or just a CVar. (Until then, stop paying
  for the blits — see "What is left".)
- Whether the pause-screen `glReadPixels` stall is visible once the audio consumer is off the
  main thread, or only audible today. Measure before building an async readback path.
- Whether the synchronous ResourceManager executor is fast enough at scene load, or visibly
  hitches. Unanswered on the SoH side too. Termina Field is the load to measure.
- Memory ceiling. The build sits at its 512 MB initial size with no growth over a few
  minutes, but wasm32 caps at 4 GB and Safari and iOS are tighter than desktop Chrome. No
  mobile browser has been tried.
- Performance under load. MM is a heavier game than OoT and nothing here is a benchmark: the
  measurements so far only establish that the loop keeps its rate, not that it has headroom.
- Is `-fwasm-exceptions` acceptable for the target browsers?

Answered since the first draft: the shader rewrite (no work needed), MM's framebuffer *blits*
(no work needed — but not the readback, which was mis-cleared and does need work), and the
libultraship rebase (~1 day). See "Resolved along the way".
