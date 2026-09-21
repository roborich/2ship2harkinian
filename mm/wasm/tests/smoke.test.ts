import { expect, test } from "bun:test";
import { playFiles, staleDesktopConfig } from "./lib/configs";
import { BOOT_TIMEOUT, TEST_TIMEOUT } from "./lib/env";
import { useSuite, withGame } from "./lib/suite";
import { audioDrains } from "./lib/timing";

const suite = useSuite();

test("boots into the game and renders", () =>
    withGame(suite, { inlineFiles: playFiles() }, async (game) => {
        await game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });
        expect(await game.waitForPicture()).toBeGreaterThan(0.05);
        expect(await game.problems()).toEqual([]);
    }), TEST_TIMEOUT);

test("the frame loop keeps running: reload re-enters the scene", () =>
    withGame(suite, { inlineFiles: playFiles() }, async (game) => {
        await game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });
        const from = await game.eventCount();
        expect(await game.run("reload")).toBe(0);
        await game.waitForEvent("scene", { from, timeout: 30_000 });
        expect(await game.problems()).toEqual([]);
    }), TEST_TIMEOUT);

// A config from a desktop install names a window backend (Metal) and an audio backend
// (CoreAudio) that a browser build does not have. Neither should stop the boot.
test("a config naming backends this build lacks still boots", () =>
    withGame(suite, { inlineFiles: { "/2ship2harkinian.json": staleDesktopConfig() } }, async (game) => {
        await game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });
        expect(await game.waitForPicture()).toBeGreaterThan(0.05);
        // The null player boots and draws just as happily, so a picture proves nothing about
        // the audio fallback. A draining queue does: only a real device consumes samples.
        expect(audioDrains(await game.sampleStats(8000, 100))).toBe(true);
        expect(await game.problems()).toEqual([]);
    }), TEST_TIMEOUT);
