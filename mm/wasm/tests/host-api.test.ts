import { expect, test } from "bun:test";
import { bootWarpConfig, playFiles, staleDesktopConfig } from "./lib/configs";
import { BOOT_TIMEOUT, TEST_TIMEOUT } from "./lib/env";
import { type Game } from "./lib/game";
import { useSuite, withGame } from "./lib/suite";
import { documentedEventTypes, emittedEventTypes } from "./lib/contract";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_DIR } from "./lib/env";

// mm/wasm/HOST-API.md is the spec for everything in this file.
const suite = useSuite();

const bootToScene = (game: Game) => game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });

test("every event the bridge sends is documented, and every documented one is sent", () => {
    const bridge = readFileSync(join(REPO_DIR, "mm/2s2h/EmbedderBridge.cpp"), "utf8");
    const hostApi = readFileSync(join(REPO_DIR, "mm/wasm/HOST-API.md"), "utf8");
    expect(emittedEventTypes(bridge)).toEqual(documentedEventTypes(hostApi));
});

test("an unknown command returns -2 and a known one returns 0", () =>
    withGame(suite, { inlineFiles: playFiles() }, async (game) => {
        await bootToScene(game);
        expect(await game.run("no_such_command")).toBe(-2);
        expect(await game.run("reload")).toBe(0);
    }), TEST_TIMEOUT);

// MM's vocabulary, not OoT's: the three-day cycle rather than an age and a time of day.
test("a scene event carries MM's own fields", () =>
    withGame(suite, { inlineFiles: playFiles() }, async (game) => {
        const { event } = await bootToScene(game);
        expect(typeof event.sceneId).toBe("number");
        expect(typeof event.spawnNum).toBe("number");
        expect(typeof event.entrance).toBe("number");
        expect(typeof event.day).toBe("number");
        expect(typeof event.time).toBe("number");
        expect(typeof event.isNight).toBe("boolean");
        expect(typeof event.playerForm).toBe("number");
    }), TEST_TIMEOUT);

// §4: a host boots straight into a scene through the config alone, on a new save at day 1,
// 8:00, in human form. The point is a spot in Termina Field known to have floor under it.
test("a boot warp point in the config starts a new game in that scene", () => {
    const termina = { entranceId: 0x5400, roomNum: 0, pos: { x: -1940.3, y: -82.4, z: 1648.6 }, rotY: 27003 };
    return withGame(suite, { inlineFiles: playFiles(bootWarpConfig(termina)) }, async (game) => {
        const loaded = await game.waitForEvent("load-game", { timeout: BOOT_TIMEOUT });
        const { event } = await game.waitForEvent("scene", { from: loaded.index });
        expect(loaded.event.fileNum).toBe(255);
        expect(event.sceneId).toBe(0x2d); // SCENE_00KEIKOKU
        expect(event.entrance).toBe(termina.entranceId);
        expect(event.day).toBe(1);
        expect(event.time).toBeGreaterThanOrEqual(0x5555); // CLOCK_TIME(8, 0)
        expect(event.time).toBeLessThan(0x5655);
        expect(event.playerForm).toBe(4); // PLAYER_FORM_HUMAN

        // §3: the play state is up, and `entrance` reads its argument as hex.
        const from = await game.eventCount();
        expect(await game.run("entrance d800")).toBe(0); // ENTRANCE(SOUTH_CLOCK_TOWN, 0)
        const warped = await game.waitForEvent("scene", { from, timeout: 30_000 });
        expect(warped.event.sceneId).toBe(0x6f); // SCENE_CLOCKTOWER
    });
}, TEST_TIMEOUT);

test("Ship_GetStats reports a running loop", () =>
    withGame(suite, { inlineFiles: playFiles() }, async (game) => {
        await bootToScene(game);
        const first = await game.stats();
        await Bun.sleep(2000);
        const second = await game.stats();
        expect(second.ticks).toBeGreaterThan(first.ticks);
        expect([1, 2, 3]).toContain(second.updateRate);
        expect(second.draws).toBeGreaterThan(first.draws);
    }), TEST_TIMEOUT);

// A listener runs inside dispatchEvent; the bridge holds events until after the frame that
// raised them, so a command sent from a listener acts on a settled game rather than a
// half-updated one.
test("a command sent from inside an event listener is accepted", () =>
    withGame(suite, { inlineFiles: playFiles() }, async (game) => {
        await bootToScene(game);
        await game.armCommandOnEvent("scene", "reload");
        const from = await game.eventCount();
        expect(await game.run("reload")).toBe(0);
        await game.waitForEvent("scene", { from, timeout: 30_000 });
        await game.waitUntil(async () => (await game.listenerResults()).length > 0, "the listener's command to run", 30_000);
        expect(await game.listenerResults()).toEqual([0]);
    }), TEST_TIMEOUT);

// The page owns storage: the module writes into MEMFS and reports what changed, so the host
// can persist it.
test("the config the game writes comes back as a file-saved event", () =>
    withGame(suite, { inlineFiles: playFiles() }, async (game) => {
        await bootToScene(game);
        const saved = await game.waitForEvent("file-saved", {
            match: (e) => e.path === "/2ship2harkinian.json",
            timeout: 60_000,
        });
        expect(saved.event.byteLength).toBeGreaterThan(0);
        expect(JSON.parse((await game.savedText("/2ship2harkinian.json"))!)).toHaveProperty("CVars");
    }), TEST_TIMEOUT);

// A config carried over from a desktop install is corrected at boot (here, an audio backend
// the browser does not have), and the host must be told, or it hands back the stale copy on
// every boot. This held before the bridge primed its snapshot first thing in InitOTR, but
// only because controller setup and the first frame happen to save the config again.
test("a config the game corrects at boot comes back corrected", () =>
    withGame(suite, { inlineFiles: { "/2ship2harkinian.json": staleDesktopConfig() } }, async (game) => {
        const scene = await bootToScene(game);
        const saved = await game.waitForEvent("file-saved", { match: (e) => e.path === "/2ship2harkinian.json" });
        expect(saved.index).toBeLessThan(scene.index);
        expect(JSON.parse((await game.savedText("/2ship2harkinian.json"))!).Window.AudioBackend).toBe("webaudio");
    }), TEST_TIMEOUT);
