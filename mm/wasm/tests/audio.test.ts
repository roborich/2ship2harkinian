import { expect, test } from "bun:test";
import { playConfig, playFiles } from "./lib/configs";
import { BOOT_TIMEOUT, SLOW, TEST_TIMEOUT } from "./lib/env";
import { type Game } from "./lib/game";
import { useSuite, withGame } from "./lib/suite";
import { audioDrains, audioDropsDuring, synthOversizedDuring } from "./lib/timing";

// The browser build plays through the Web Audio player (libultraship WebAudioAudioPlayer): an
// AudioWorklet on the browser's audio rendering thread, fed updates the game synthesises once
// per tick on the main thread. The queue in front of the worklet is real headroom, so a long
// frame is covered by what is already queued. SDL's Emscripten player stays as the fallback
// for a browser without AudioWorklet; its callback runs on the main thread, where a long
// frame is audible however deep the queue is.
const suite = useSuite();
const slowTest = SLOW ? test : test.skip;

const configWith = (backend: string) => {
    const config = playConfig();
    config.Window = { ...config.Window, AudioBackend: backend };
    return playFiles(config);
};

// The backend the game settled on, as it wrote it back to the config.
async function savedBackend(game: Game): Promise<string | undefined> {
    const text = await game.savedText("/2ship2harkinian.json");
    return text ? JSON.parse(text).Window?.AudioBackend : undefined;
}

test("audio is produced and the device consumes it", () =>
    withGame(suite, { inlineFiles: playFiles() }, async (game) => {
        await game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });
        const samples = await game.sampleStats(8000, 100);
        // Something was queued at some point...
        expect(samples.some((s) => s.audioBuffered > 0)).toBe(true);
        // ...and the queue went down again, which is the only proof the device is playing.
        // A suspended AudioContext never drains and would make every other check meaningless.
        expect(audioDrains(samples)).toBe(true);
        // ...and nothing was synthesised from stale note state (see synthOversizedDuring).
        expect(synthOversizedDuring(samples)).toBe(0);
    }), TEST_TIMEOUT);

// The queue target leaves room for a full update below the players' drop threshold; see the
// static_assert next to SAMPLES_HIGH in BenPort.cpp. If that arithmetic is wrong, whole
// updates are thrown away and the music stutters.
slowTest("no audio update is dropped during play", () =>
    withGame(suite, { inlineFiles: playFiles() }, async (game) => {
        await game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });
        await Bun.sleep(3000);
        const samples = await game.sampleStats(30_000, 100);
        expect(audioDrains(samples)).toBe(true);
        expect(audioDropsDuring(samples)).toBe(0);
        expect(synthOversizedDuring(samples)).toBe(0);
    }), TEST_TIMEOUT);

// A config from a Mac install names "coreaudio". LUS used to fall through to the null player
// for any backend it was not built with, so the game ran silent with nothing in the console.
// It now takes the platform's first backend, which here is the Web Audio player.
test("a config naming a backend this build lacks plays through Web Audio", () =>
    withGame(suite, { inlineFiles: configWith("coreaudio") }, async (game) => {
        await game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });
        const samples = await game.sampleStats(5000, 100);
        expect(audioDrains(samples)).toBe(true);
        expect(await savedBackend(game)).toBe("webaudio");
        const audio = await game.webAudio();
        expect(audio).not.toBeNull();
        expect(audio!.ready).toBe(true);
        expect(audio!.contextState).toBe("running");
    }), TEST_TIMEOUT);

// The worklet runs on the audio thread, so once the title screen is up and the queue is
// primed it should never have to fill a block with silence.
test("the Web Audio worklet consumes without underruns on the title screen", () =>
    withGame(suite, { inlineFiles: playFiles() }, async (game) => {
        await game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });
        await Bun.sleep(2000); // let the queue reach its target
        const before = (await game.webAudio())!;
        const samples = await game.sampleStats(5000, 100);
        const after = (await game.webAudio())!;
        expect(audioDrains(samples)).toBe(true);
        expect(after.consumed).toBeGreaterThan(before.consumed);
        expect(after.underruns - before.underruns).toBe(0);
        expect(after.dropped).toBe(0);
        expect(audioDropsDuring(samples)).toBe(0);
    }), TEST_TIMEOUT);

// The worklet loads after the player has already reported success. If that load fails (a
// page whose CSP forbids blob: scripts, say) the player is silent for good, so LUS notices
// on the next audio call and falls back to SDL, without writing "sdl" into the config.
test("a worklet that fails to load falls back to SDL for the session only", () =>
    withGame(suite, {
        inlineFiles: playFiles(),
        initScript: "AudioWorklet.prototype.addModule = () => Promise.reject(new Error('blocked by test'));",
    }, async (game) => {
        await game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });
        const samples = await game.sampleStats(5000, 100);
        expect(audioDrains(samples)).toBe(true);
        expect(await game.webAudio()).toBeNull();
        expect(await savedBackend(game)).not.toBe("sdl");
    }), TEST_TIMEOUT);

// SDL's ScriptProcessorNode player stays as the fallback for browsers without AudioWorklet,
// and a config may still name it.
test("the SDL player still plays when the config names it", () =>
    withGame(suite, { inlineFiles: configWith("sdl") }, async (game) => {
        await game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });
        const samples = await game.sampleStats(5000, 100);
        expect(audioDrains(samples)).toBe(true);
        expect(await game.webAudio()).toBeNull();
    }), TEST_TIMEOUT);
