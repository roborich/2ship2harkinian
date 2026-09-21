import { expect } from "bun:test";
import { baseConfig, playFiles } from "./lib/configs";
import { BOOT_TIMEOUT, TEST_TIMEOUT } from "./lib/env";
import { knownBug } from "./lib/known";
import { useSuite, withGame } from "./lib/suite";

// Tests for defects that are known and not fixed. Skipped unless SHIP_WASM_KNOWN_BUGS=1,
// which runs them to confirm they still fail. The commit that fixes one turns it into an
// ordinary `test`. See wasm-port.md, "What is broken".
const suite = useSuite();

// The audio update trips a memory access out of bounds inside osRecvMesg, one or two minutes
// into any session, and Emscripten's handler then stops the main loop: the canvas freezes
// with no error in the page. The queue it is draining (gAudioCtx.threadCmdProcQueueP) is
// filled by Audio_Update on what used to be the game thread and drained by
// AudioMgr_CreateNextAudioBuffer on what used to be the audio thread, and this build runs
// both on one thread in a fixed order within a frame.
knownBug("audio-oob", "the game survives three minutes of play", () =>
    withGame(suite, { inlineFiles: playFiles() }, async (game) => {
        await game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });
        const start = await game.stats();
        await game.sampleStats(180_000, 2000);
        const end = await game.stats();
        expect(end.ticks).toBeGreaterThan(start.ticks + 3000);
        expect(await game.problems()).toEqual([]);
    }), 300_000);

// Booting to a saved warp point in Termina Field corrupts an SFX bank's linked list:
// gSfxBanks[bank][0].next comes to point at 0, the list's own head sentinel.
// AudioSfx_ChooseActiveSfx then walks a cycle. The walk is bounded now (sfx.c), so this no
// longer wedges the tab, but the corruption itself is unexplained and the bank goes quiet.
knownBug("sfx-bank-cycle", "booting to a warp point leaves the sfx banks intact", () => {
    const config = baseConfig();
    config.CVars.gDeveloperTools.WarpPoint = { ...config.CVars.gDeveloperTools.WarpPoint, BootToWarpPoint: 1 };
    return withGame(suite, { inlineFiles: { "/2ship2harkinian.json": JSON.stringify(config, null, 4) } }, async (game) => {
        await game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });
        await Bun.sleep(20_000);
        const corrupt = game.consoleErrors.concat(game.pageErrors).filter((line) => /SFX bank|out of bounds/.test(line));
        expect(corrupt).toEqual([]);
    });
}, TEST_TIMEOUT);
