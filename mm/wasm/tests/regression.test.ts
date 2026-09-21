import { expect, test } from "bun:test";
import { baseConfig, playFiles } from "./lib/configs";
import { BOOT_TIMEOUT } from "./lib/env";
import { useSuite, withGame } from "./lib/suite";

// Both of these were live defects until the DMEM window in mm/2s2h/mixer.c was sized to
// cover the addresses the audio ucode can name. A single oversized aClearBuffer was spraying
// ~19 KB across the neighbouring audio globals; everything below is a way of noticing that.
// See wasm-port.md, "The audio overrun".
const suite = useSuite();

// The corruption reached gAudioCtx's message queues, and the next osRecvMesg walked off the
// heap. Emscripten's handler then stopped the main loop, so the canvas froze with nothing in
// the page to say why. It took one to two minutes.
test("the game survives three minutes of play", () =>
    withGame(suite, { inlineFiles: playFiles() }, async (game) => {
        await game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });
        const start = await game.stats();
        await game.sampleStats(180_000, 2000);
        const end = await game.stats();
        expect(end.ticks).toBeGreaterThan(start.ticks + 3000);
        expect(await game.problems()).toEqual([]);
    }), 300_000);

// It also reached the sfx banks, whose entries are static arrays laid out beside the audio
// globals. gSfxBanks[bank][0].next came to point at 0 -- the list's own head sentinel -- and
// AudioSfx_ChooseActiveSfx walked the cycle forever, wedging the tab. Booting to a saved warp
// point in Termina Field reproduced it in about ten seconds.
test("booting to a warp point leaves the sfx banks intact", () => {
    const config = baseConfig();
    config.CVars.gDeveloperTools.WarpPoint = { ...config.CVars.gDeveloperTools.WarpPoint, BootToWarpPoint: 1 };
    return withGame(suite, { inlineFiles: { "/2ship2harkinian.json": JSON.stringify(config, null, 4) } }, async (game) => {
        await game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });
        await Bun.sleep(30_000);
        const corrupt = game.consoleErrors.concat(game.pageErrors).filter((line) => /SFX bank|out of bounds/.test(line));
        expect(corrupt).toEqual([]);
        expect((await game.stats()).ticks).toBeGreaterThan(400);
    });
}, 180_000);
