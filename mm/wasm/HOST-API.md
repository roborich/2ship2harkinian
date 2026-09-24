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
  '/saves/file1.json':      bytes,  // optional: saves, file<N>.json, and file<N>backup.json
  '/mods/<name>.o2r':       bytes,  // optional: mod layers
};
```

`mm.o2r` is accepted from any 2Ship with the same **major** version as this build (5.x): the
game compares nothing else (`VerifyArchiveVersion` in `mm/2s2h/BenPort.cpp`). An archive a user
extracted with a 5.x desktop install works as it is.

Mods are the `.o2r` files anywhere under `/mods/`, named by filename without the extension.
With no `gSettings.EnabledMods` in the config they load in sorted path order. With one, its
`|`-separated names load in that order first, any other mods after them in sorted path order,
and names with no file are dropped from the list, which the game then saves back
(`UpdateModFiles` in `mm/2s2h/Enhancements/ModMenu/ModMenu.cpp`). **Mods have not been loaded
in the browser build yet**; the code path is the desktop one, unexercised here.

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
| `file-saved` | `path`, `bytes` | The game wrote its config or a save. `bytes` is a `Uint8Array` copy of the whole file. Persist it yourself; the VFS is lost on reload. A file you supplied comes back only if the game rewrote it: the config usually does at boot, migrated to this version and with any setting this build cannot honour (an audio backend from another platform) corrected. |
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
| `entrance <hex>` | yes | Instant warp to a packed entrance, **read as hex** (`entrance d800` is South Clock Town); a `scene` event follows. |
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

There is no `warp` command. To start in a scene, boot to a warp point (§4); to move within a
game, use `entrance`.

## 4. Booting into a scene from the config

A host can skip the title and file select and start the game at a chosen spot through the
config it hands in. This is the game's own Developer Tools > Warp Points feature
(`mm/2s2h/DeveloperTools/WarpPoint.cpp`). This one is a spot in Termina Field:

```json
{
  "CVars": { },
  "WarpPoints": {
    "prelude": {
      "bootToPoint": true,
      "entranceId": 21504,
      "roomNum": 0,
      "pos": { "x": -1940.3, "y": -82.4, "z": 1648.6 },
      "rotY": 27003
    }
  }
}
```

- `entranceId` is a packed entrance, `(entrance scene << 9) | (spawn << 4) | layer`, where the
  entrance scene is an `ENTR_SCENE_*` index (`mm/include/z64scene.h`), a different numbering
  from the `sceneId` the `scene` event carries: 21504 is `0x2A << 9`, Termina Field, whose
  `sceneId` is `0x2D`. It is the same
  value the `scene` event reports as `entrance` (in decimal there, as here), so a host can
  hand back one it was given. The player appears at `pos` rather than at the spawn; the low
  four bits pick the scene layer.
- `roomNum` is the room `pos` is in, `pos` a world position, and `rotY` the facing as a
  binary angle (`0x8000` is half a turn).
- The first point with `bootToPoint: true`, in name order, is used.
- `gEnhancements.Cutscenes.SkipToFileSelect` must be 0 or absent; with it on, the warp point is
  ignored.

What the boot gives you is **a new game, not a save**: day 1, 8:00, human form, three
hearts, the Kokiri Sword and no other items, and first-cycle story flags
(`Sram_InitNewSave`). There is no way yet to choose the day, the time or the form. The host
sees `load-game` with `fileNum: 255`, then `scene`, and from then on play-state commands
work.

A config written with no `ConfigVersion` that still carries the legacy
`gDeveloperTools.WarpPoint.*` CVars from an old desktop install has those migrated at boot into
a `WarpPoints` block that **replaces** the one supplied. Drop those CVars, or keep the
`ConfigVersion` the game wrote.

## 5. Diagnostics: `Ship_GetStats` (unstable)

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

## 6. Converting a ROM

Not built yet. SoH ships a second, independent module (`soh-extract.js`) that turns a ROM
into the archive §1 asks for; the 2Ship equivalent is Milestone 6 in `wasm-port.md`. Until
then, the page needs an `mm.o2r` extracted by a 2Ship 5.x desktop install (§1).
