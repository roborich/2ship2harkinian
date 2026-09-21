import { expect, test } from "bun:test";
import { playFiles } from "./lib/configs";
import { BOOT_TIMEOUT, TEST_TIMEOUT } from "./lib/env";
import { DEFAULT_FILES, withoutFile } from "./lib/game";
import { useSuite, withGame, withPage } from "./lib/suite";

const suite = useSuite();

// Without this the game fails at the first resource load, in a loop that never returns to
// the page and that no event reports -- a black canvas and nothing else.
test("a missing mm.o2r is reported as an error event", () =>
    withGame(suite, { files: withoutFile(DEFAULT_FILES, "/mm.o2r") }, async (game) => {
        const { event } = await game.waitForEvent("error", { timeout: BOOT_TIMEOUT });
        expect(event.message).toContain("mm.o2r");
    }), TEST_TIMEOUT);

test("bytes that are not an archive are reported, not crashed on", () =>
    withGame(
        suite,
        { files: withoutFile(DEFAULT_FILES, "/mm.o2r"), inlineFiles: { "/mm.o2r": "this is an HTTP error page" } },
        async (game) => {
            const { event } = await game.waitForEvent("error", { timeout: BOOT_TIMEOUT });
            expect(event.message).toContain("mm.o2r");
        },
    ), TEST_TIMEOUT);

test("host.html boots with every host file present", () =>
    withPage(suite, "/build/host.html", undefined, async (game) => {
        await game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });
    }), TEST_TIMEOUT);

test("boots cleanly when the optional config is missing", () =>
    withGame(suite, { files: withoutFile(DEFAULT_FILES, "/2ship2harkinian.json") }, async (game) => {
        await game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });
        expect(await game.problems()).toEqual([]);
    }), TEST_TIMEOUT);

test("a save that is not JSON does not stop the game at boot", () =>
    withGame(suite, { inlineFiles: { ...playFiles(), "/saves/file2.json": "this is not a save" } }, async (game) => {
        await game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });
        await Bun.sleep(2000);
        expect(await game.problems()).toEqual([]);
    }), TEST_TIMEOUT);
