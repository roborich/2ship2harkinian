import { expect, test } from "bun:test";
import { playFiles } from "./lib/configs";
import { BOOT_TIMEOUT, SOAK } from "./lib/env";
import { useSuite, withGame } from "./lib/suite";

// Opt-in (SHIP_WASM_SOAK=1). The heap is allowed to grow while the first scene loads; after
// that, ten minutes in the same place should not need more memory.
//
// This will fail today: see wasm-port.md, "The audio crash" -- the run stops after a minute
// or two with a memory access out of bounds inside the audio update. Kept because it is the
// test that will prove that fixed.
const suite = useSuite();
const SOAK_MS = 10 * 60_000;
const ALLOWED_GROWTH_BYTES = 64 * 1024 * 1024;

(SOAK ? test : test.skip)("ten minutes of play does not grow the wasm heap", () =>
    withGame(suite, { inlineFiles: playFiles() }, async (game) => {
        await game.waitForEvent("scene", { timeout: BOOT_TIMEOUT });
        await Bun.sleep(60_000);
        const before = await game.heapBytes();
        await game.sampleStats(SOAK_MS, 10_000);
        expect((await game.heapBytes()) - before).toBeLessThan(ALLOWED_GROWTH_BYTES);
        expect(await game.problems()).toEqual([]);
    }), SOAK_MS + 5 * 60_000);
