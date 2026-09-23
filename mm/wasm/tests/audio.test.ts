import { expect, test } from "bun:test";
import { playFiles } from "./lib/configs";
import { BOOT_TIMEOUT, SLOW, TEST_TIMEOUT } from "./lib/env";
import { useSuite, withGame } from "./lib/suite";
import { audioDrains, audioDropsDuring, synthOversizedDuring } from "./lib/timing";

// The browser build has no Web Audio player yet (see wasm-port.md, Milestone 4): it plays
// through SDL's Emscripten backend, whose callback runs on the page's main thread. That
// makes a long frame audible however deep the queue is, so these tests check that audio is
// produced and consumed at all -- not that it is glitch-free.
const suite = useSuite();
const slowTest = SLOW ? test : test.skip;

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
