#pragma once

// 2S2H [WASM] The channel between the browser build and whatever page embeds it. Two
// directions, neither of which knows anything about the embedder:
//
//   out: DOM CustomEvents named "2ship" on window, detail = { type, ...fields }, dispatched
//        between frames so a listener may send commands back.
//        "load-game"    { fileNum }                 a save was loaded and its first scene is
//                                                   up; commands that need a play state work
//        "scene"        { sceneId, spawnNum,        a scene finished initialising. MM's
//                         entrance, day, time,      vocabulary: the three-day cycle, not
//                         isNight, playerForm }     OoT's age and time of day.
//        "file-saved"   { path, bytes }             the game wrote its config or a save;
//                                                   bytes is a Uint8Array copy of the file
//        "file-removed" { path }                    a watched file is gone
//        "quit"         {}                          the main loop has stopped for good
//        "error"        { message }                 the game stopped: an exception escaped
//                                                   a frame, or the archives are unusable
//   in:  Module.ccall('Ship_RunConsoleCommand', 'number', ['string'], ['reset'])
//        runs a line through the game's debug console; returns the command's result.
//   diagnostics: Module.ccall('Ship_GetStats', 'string') returns counters as JSON, for tests.
//
// See mm/wasm/EMBEDDING.md, "Talking to the game".
#ifdef __EMSCRIPTEN__
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
// Called first thing in InitOTR: records the files the host supplied, so that everything the
// game writes from then on, boot included, is reported.
void Ship_EmbedderPrimeFiles(void);
// Called once GameInteractor exists: registers the hooks behind the "scene" and "load-game"
// events.
void Ship_InitEmbedderBridge(void);
// Called by the frame loop (graph.c) after each frame: reports files the game wrote.
void Ship_EmbedderAfterFrame(void);
// Called by the frame loop when the window has closed, before the loop is cancelled.
void Ship_EmbedderQuit(void);
// Called by the frame guard for an exception escaping a frame.
void Ship_EmbedderError(const char* message);
// Called by Graph_ProcessGfxCommands with the number of frames it drew this tick; read
// back through Ship_GetStats.
void Ship_EmbedderCountDraws(size_t draws);
// Called by the audio update when the player is about to drop it; read back through
// Ship_GetStats.
void Ship_EmbedderCountAudioDrop(void);
#ifdef __cplusplus
}
#endif
#endif
