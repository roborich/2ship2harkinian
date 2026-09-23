# 2Ship wasm — host API

What a page embedding `2ship.js` / `2ship.wasm` / `2ship.data` can hand in, hear back, and
send. The build knows nothing about its host; everything below is plain browser machinery.
The build copies this file next to `2ship.js`, so it ships with the artifacts. Background
and build notes are in `EMBEDDING.md` in the 2ship2harkinian repo.

## 1. Files in: `Module.shipFiles`

Set before `2ship.js` loads. Keys are absolute VFS paths, values `Uint8Array`:

```js
Module.shipFiles = {
  '/mm.o2r':                bytes,  // required
  '/2ship2harkinian.json':  bytes,  // optional: config
  '/saves/file1.sav':       bytes,  // optional: saves
  '/mods/<name>.o2r':       bytes,  // optional: mod layers, loaded in sorted filename order
};
```

Do not supply `2ship.o2r`; it is inside the module, packaged in `2ship.data` and
version-locked to the binary. A copy written here makes the unpack fail.

## 2. Events out: `CustomEvent('2ship')` on `window`

Attach the listener **before** `2ship.js` loads; the title screen fires events at boot.
Events are dispatched between frames, after the frame that raised them, so a listener can
call `Ship_RunConsoleCommand` directly without acting on a half-updated game.

```js
window.addEventListener('2ship', ({ detail }) => { switch (detail.type) { /* ... */ } });
```

| `detail.type` | Fields | Meaning |
|---|---|---|
| `load-game` | `fileNum` | A save was loaded and its first scene is up; sent just before that `scene` event. Play-state commands now act on the player's game. |
| `scene` | `sceneId`, `spawnNum`, `entrance`, `day`, `time`, `isNight`, `playerForm` | A scene finished initialising (boot, load, warp, door). MM's vocabulary is the three-day cycle, not OoT's age and time of day: `day` is `Save::day` ("totalday"), `time` the in-game clock as the game stores it, `isNight` a boolean, and `playerForm` the current mask form (Deku, Goron, Zora, Fierce Deity, Human). `entrance` is the packed `Save::entrance` value. |
| `file-saved` | `path`, `bytes` | The game wrote its config or a save. `bytes` is a `Uint8Array` copy of the whole file. Persist it yourself; the VFS is lost on reload. Files you supplied at boot are not echoed back. |
| `file-removed` | `path` | A watched file is gone: a save erased, or one the game moved aside as unreadable. Delete your copy, or the next boot brings it back. |
| `quit` | — | The main loop stopped for good (for example after the `quit` command). Any final `file-saved` events arrive first. |
| `error` | `message` | The game stopped: a C++ exception escaped a frame, or at startup the game archives were missing or from an incompatible version (then no `scene` ever arrives). Any final `file-saved` events arrive first. Treat it as `quit` with a reason. |

## 3. Commands in: `Ship_RunConsoleCommand`

Runs one line through the in-game debug console:

```js
const run = cmd => Module.ccall('Ship_RunConsoleCommand', 'number', ['string'], [cmd]);
run('entrance 0');
```

Return value: `0` success · `1` the command refused (bad arguments, or no play state) ·
`-1` the console isn't up yet · `-2` unknown command. Call it only after the runtime is up;
the first `2ship` event is a safe signal. The command takes effect on the next frame.

| Command | Needs play state | Does |
|---|---|---|
| `entrance <index>` | yes | Instant warp to an entrance index; a `scene` event follows. |
| `spawn <...>` | yes | Spawns an actor. |
| `pos [x y z]` | yes | Reads or sets the player's position. |
| `reload` | yes | Re-enters the current entrance (reloads the scene). |
| `void` | yes | Void out to the last respawn point. |
| `reset` | no | Back to the title screen. |
| `file_select` | no | Back to file select. |
| `quit` | no | Closes the game: final `file-saved` events, then `quit`. |
| `give_item <...>` | yes | Grants an item. |

Every command is registered with its arguments in `DebugConsole_Init()` in
`mm/2s2h/DeveloperTools/DebugConsole.cpp`, and they all work here the same way.

**There is no `warp` command yet.** SoH has one that takes an age and a time of day and
starts a fresh game when called outside gameplay, which is how a host boots straight into a
scene. The MM equivalent — an entrance plus a day and a clock time — is not written; until
it is, a host boots into the game the way a player does (`file_select`, then input) and then
uses `entrance`.

## 4. Diagnostics: `Ship_GetStats` (unstable)

For tests and profiling, not for building on: the fields can change without notice.

```js
JSON.parse(Module.ccall('Ship_GetStats', 'string'));
// { ticks, draws, updateRate, audioBuffered, audioDrops, interpolationFps, sceneId, synthOversized }
```

`ticks` counts frame-loop callbacks and `draws` the frames drawn in them; this build pins one
draw per tick, so anything else is a regression. `updateRate` is the game's vsync divisor (the loop
runs at `60 / updateRate` Hz — 3 in gameplay, 2 in the pause menu and message boxes, 1 on the
title, file select, opening and "Dawn of the Nth Day" screens). `audioBuffered` is the number
of samples queued for the audio device, and `audioDrops` the updates discarded because that
queue was already full. `interpolationFps` is the frame interpolator's target; `20` means off,
and this build always reports 20 whatever the config asks for. `sceneId` is `-1` outside a play
state. `synthOversized` counts audio synthesis loads larger than a note can legitimately ask for;
it is zero on a healthy build and non-zero means the note update path is being skipped again.

## 5. Converting a ROM

Not built yet. SoH ships a second, independent module (`soh-extract.js`) that turns a ROM
into the archive §1 asks for; the 2Ship equivalent is Milestone 6 in `wasm-port.md`. Until
then, produce `mm.o2r` with a desktop build and hand it to the page.
