import { expect, test } from "bun:test";
import { playConfig, playFiles } from "./lib/configs";
import { BOOT_TIMEOUT, SLOW, TEST_TIMEOUT } from "./lib/env";
import { useSuite, withGame } from "./lib/suite";
import { drawsPerTick, tickRateSegments } from "./lib/timing";

// Opt-in (SHIP_WASM_SLOW=1): these sample the running game for tens of seconds, and their
// numbers mean little on a machine that is busy with something else.
const suite = useSuite();
const slowTest = SLOW ? test : test.skip;

// The game runs at 60/R_UPDATE_RATE Hz and synthesises R_UPDATE_RATE audio buffers per
// frame, so the two cancel and audio lands at 32 kHz. A loop pinned to one rate breaks that
// cancellation and the music plays at the wrong speed in every state but the one it was
// pinned to. MM changes the divisor more often than OoT does -- 3 in gameplay, 2 in the
// pause menu and message boxes, 1 on the title, file select and "Dawn of the Nth Day"
// screens -- so this is load-bearing.
slowTest("the loop ticks at 60 / R_UPDATE_RATE Hz, within 5%", () =>
    withGame(suite, { inlineFiles: playFiles() }, async (game) => {
        await game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });
        const samples = await game.sampleStats(25_000);
        const segments = tickRateSegments(samples, 5000);
        expect(segments.length).toBeGreaterThan(0);
        expect(segments.filter((s) => Math.abs(s.error) > 0.05)).toEqual([]);
    }), TEST_TIMEOUT);

// One rendered frame per game tick. Interpolated sub-frames need a loop paced by the display
// to be seen; this one ticks at the game's rate, so they would be drawn back to back and
// only the last would reach the screen, at up to three times the cost of a tick.
slowTest("60 fps interpolation still draws one frame per tick", () => {
    const config = playConfig();
    config.CVars.gSettings = { ...config.CVars.gSettings, InterpolationFPS: 60 };
    return withGame(suite, { inlineFiles: playFiles(config) }, async (game) => {
        await game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });
        await Bun.sleep(3000);
        const samples = await game.sampleStats(6000);
        expect(drawsPerTick(samples)).toBeCloseTo(1, 1);
    });
}, TEST_TIMEOUT);
