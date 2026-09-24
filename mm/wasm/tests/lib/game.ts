import { chromium, type Browser, type Page } from "playwright-core";
import { HEADED } from "./env";
import type { TestServer } from "./server";
import type { StatsSample } from "./timing";

// Globals that exist only inside the page; the callbacks passed to page.evaluate run there.
declare const Module: any;
declare global {
    interface Window {
        __ship: Recorder;
        __shipBoot: BootConfig;
    }
}

export type ShipEvent = { type: string; at: number; [field: string]: any };
export type WebAudioState = {
    contextState: string;
    ready: boolean;
    failed: boolean;
    queued: number;
    consumed: number;
    dropped: number;
    underruns: number;
};
type Recorder = {
    events: ShipEvent[];
    savedBytes: Record<string, Uint8Array>;
    listenerResults: number[];
    runtimeReady: boolean;
    aborted: string | null;
    harnessError: string | null;
};
type BootConfig = { files: Record<string, string>; inlineFiles: Record<string, string>; moduleUrl: string };

export type BootOptions = {
    // VFS path -> path under the files mount.
    files?: Record<string, string>;
    // VFS path -> text, for configs a test builds itself.
    inlineFiles?: Record<string, string>;
    // Runs in the page before any of its scripts, for breaking a browser API on purpose.
    initScript?: string;
};

// N64 buttons on the keyboard, as the files directory's config maps them.
export const PAD = { A: "KeyX", B: "KeyC", START: "Space" } as const;

// What the harness fetches for a boot. Only the game archive is required; a config makes
// the run reproducible. No save: 2Ship keeps saves in `saves/` as `file<N>.json`
// (SaveManager.cpp:33, :231), and a test that wants one supplies it through `inlineFiles`,
// so the suite does not depend on a save file being present in the files directory.
export const DEFAULT_FILES: Record<string, string> = {
    "/mm.o2r": "mm.o2r",
    "/2ship2harkinian.json": "2ship2harkinian.json",
};

const FATAL_CONSOLE = /Unhandled exception|Aborted\(|RuntimeError|Uncaught/;

// A page whose main thread is stuck (a wasm loop that never returns to the event loop) never
// answers page.evaluate. Without a bound, a test waits on it past its own deadline, bun's test
// timeout abandons the promise, and the process never exits.
const PAGE_CALL_TIMEOUT = 10_000;

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function withoutFile(files: Record<string, string>, vfsPath: string): Record<string, string> {
    return Object.fromEntries(Object.entries(files).filter(([path]) => path !== vfsPath));
}

export function describeEvents(events: ShipEvent[]): string {
    const brief = events.map((e) =>
        e.type === "scene" ? `scene(${e.sceneId}/day${e.day})` : e.path ? `${e.type}(${e.path})` : e.type,
    );
    return brief.length ? brief.slice(-20).join(", ") : "none";
}

export async function launchBrowser(jsFlags: string[] = []): Promise<Browser> {
    const args = ["--autoplay-policy=no-user-gesture-required"];
    if (jsFlags.length) {
        args.push(`--js-flags=${jsFlags.join(" ")}`);
    }
    return chromium.launch({ headless: !HEADED, args });
}

// Runs in the page before any of its own scripts, so no event is missed.
function installRecorder() {
    const record: any = {
        events: [],
        savedBytes: {},
        listenerResults: [],
        runtimeReady: false,
        aborted: null,
        harnessError: null,
    };
    window.__ship = record;
    window.addEventListener("2ship", (e: any) => {
        const { bytes, ...fields } = e.detail;
        if (bytes) {
            record.savedBytes[fields.path] = bytes;
            fields.byteLength = bytes.length;
        }
        record.events.push({ ...fields, at: performance.now() });
    });
}

// Opens any page (host.html, the harness) with the event recorder installed.
export async function openPage(browser: Browser, url: string, setup?: (page: Page) => Promise<void>): Promise<Game> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const game = new Game(page);
    await page.addInitScript(installRecorder);
    if (setup) {
        await setup(page);
    }
    await page.goto(url);
    return game;
}

// Boots the build through page/harness.html, the way an embedder hands over its files.
export async function bootGame(browser: Browser, server: TestServer, options: BootOptions = {}): Promise<Game> {
    const boot: BootConfig = {
        files: Object.fromEntries(Object.entries(options.files ?? DEFAULT_FILES).map(([vfs, rel]) => [vfs, `/files/${rel}`])),
        inlineFiles: options.inlineFiles ?? {},
        moduleUrl: "/build/2ship.js",
    };
    const game = await openPage(browser, `${server.url}/page/harness.html`, async (page) => {
        await page.addInitScript((config) => {
            window.__shipBoot = config;
        }, boot);
        if (options.initScript) {
            await page.addInitScript(options.initScript);
        }
    });
    await game.waitUntil(() => game.evaluate(() => window.__ship.runtimeReady), "the runtime to start", 60_000);
    return game;
}

export class Game {
    crashed = false;
    readonly consoleErrors: string[] = [];
    readonly pageErrors: string[] = [];

    constructor(readonly page: Page) {
        page.on("crash", () => (this.crashed = true));
        page.on("pageerror", (error) => this.pageErrors.push(String(error)));
        page.on("console", (message) => {
            if (message.type() === "error") {
                this.consoleErrors.push(message.text());
            }
        });
    }

    async close(): Promise<void> {
        await withTimeout(this.page.context().close(), PAGE_CALL_TIMEOUT, "closing the page").catch(() => {});
    }

    evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> {
        return withTimeout(
            this.page.evaluate(fn as any, arg) as Promise<R>,
            PAGE_CALL_TIMEOUT,
            "a call into the page (is its main thread stuck?)",
        );
    }

    // ---- events ---------------------------------------------------------------------------

    events(): Promise<ShipEvent[]> {
        return this.evaluate(() => window.__ship.events);
    }

    async eventCount(): Promise<number> {
        return (await this.events()).length;
    }

    // Waits for an event of `type` at or after index `from` that satisfies `match`.
    async waitForEvent(
        type: string,
        { from = 0, match = () => true, timeout = 60_000 }: { from?: number; match?: (e: ShipEvent) => boolean; timeout?: number } = {},
    ): Promise<{ event: ShipEvent; index: number }> {
        return this.waitUntil(
            async () => {
                const events = await this.events();
                const index = events.findIndex((e, i) => i >= from && e.type === type && match(e));
                return index >= 0 ? { event: events[index], index } : null;
            },
            `a '${type}' event`,
            timeout,
        );
    }

    async waitUntil<T>(probe: () => Promise<T | null | undefined | false>, what: string, timeout: number): Promise<T> {
        const deadline = performance.now() + timeout;
        for (;;) {
            await this.assertAlive();
            const value = await probe();
            if (value) {
                return value;
            }
            if (performance.now() > deadline) {
                throw new Error(`timed out after ${timeout} ms waiting for ${what}; events: ${describeEvents(await this.events())}`);
            }
            await Bun.sleep(200);
        }
    }

    async assertAlive(): Promise<void> {
        if (this.crashed) {
            throw new Error("the renderer crashed");
        }
        const state = await this.evaluate(() => ({ aborted: window.__ship.aborted, harnessError: window.__ship.harnessError }));
        if (state.aborted || state.harnessError) {
            throw new Error(`the module stopped: ${state.aborted ?? state.harnessError}`);
        }
    }

    // Everything that suggests the game is broken: error events, fatal console lines,
    // uncaught page errors.
    async problems(): Promise<string[]> {
        const errorEvents = (await this.events()).filter((e) => e.type === "error").map((e) => `error event: ${e.message}`);
        return [...errorEvents, ...this.consoleErrors.filter((t) => FATAL_CONSOLE.test(t)), ...this.pageErrors];
    }

    // ---- commands -------------------------------------------------------------------------

    run(command: string): Promise<number> {
        return this.evaluate((c) => Module.ccall("Ship_RunConsoleCommand", "number", ["string"], [c]), command);
    }

    // Adds a listener that runs `command` the first time a `type` event arrives, from inside
    // the event dispatch, and records the command's result in __soh.listenerResults.
    armCommandOnEvent(type: string, command: string): Promise<void> {
        return this.evaluate(
            ([t, c]) => {
                const listener = (e: any) => {
                    if (e.detail.type !== t) return;
                    window.removeEventListener("2ship", listener);
                    window.__ship.listenerResults.push(Module.ccall("Ship_RunConsoleCommand", "number", ["string"], [c]));
                };
                window.addEventListener("2ship", listener);
            },
            [type, command],
        );
    }

    listenerResults(): Promise<number[]> {
        return this.evaluate(() => window.__ship.listenerResults);
    }

    // ---- diagnostics ----------------------------------------------------------------------

    stats(): Promise<StatsSample & { sceneId: number }> {
        return this.evaluate(() => ({ ...JSON.parse(Module.ccall("Ship_GetStats", "string", [], [])), t: performance.now() }));
    }

    async sampleStats(durationMs: number, everyMs = 250): Promise<StatsSample[]> {
        const samples: StatsSample[] = [];
        const end = performance.now() + durationMs;
        while (performance.now() < end) {
            await this.assertAlive();
            samples.push(await this.stats());
            await Bun.sleep(everyMs);
        }
        return samples;
    }

    heapBytes(): Promise<number> {
        return this.evaluate(() => Module.HEAPU8.buffer.byteLength);
    }

    // The Web Audio player's state (libultraship WebAudioAudioPlayer.js), or null when another
    // player is in use. Counts are frames; `underruns` is the number of render quanta the
    // worklet had to fill with silence while the tab was visible.
    webAudio(): Promise<WebAudioState | null> {
        return this.evaluate(() => {
            const state = Module.LUSWebAudio;
            if (!state) return null;
            return {
                contextState: state.ctx.state,
                ready: state.node !== null,
                failed: !!state.failed,
                queued: state.queued,
                consumed: state.consumed,
                dropped: state.dropped,
                underruns: state.underruns,
            };
        });
    }

    // The text of a file the game reported through a 'file-saved' event, or null.
    savedText(path: string): Promise<string | null> {
        return this.evaluate((p) => {
            const bytes = window.__ship.savedBytes[p];
            return bytes ? new TextDecoder().decode(bytes) : null;
        }, path);
    }

    // ---- filesystem -----------------------------------------------------------------------

    listDir(path: string): Promise<string[]> {
        return this.evaluate((p) => (Module.FS.analyzePath(p).exists ? Module.FS.readdir(p).filter((n: string) => n !== "." && n !== "..") : []), path);
    }

    writeFile(path: string, text: string): Promise<void> {
        return this.evaluate(([p, t]) => Module.FS.writeFile(p, t), [path, text]);
    }

    unlink(path: string): Promise<void> {
        return this.evaluate((p) => Module.FS.unlink(p), path);
    }

    // ---- input and picture ----------------------------------------------------------------

    // Holds a key long enough for a 20 Hz frame loop to see it.
    async pressButton(key: string, holdMs = 200): Promise<void> {
        await this.page.locator("#canvas").focus();
        await this.page.keyboard.down(key);
        await Bun.sleep(holdMs);
        await this.page.keyboard.up(key);
    }

    // Fraction of sampled canvas pixels that are not near-black.
    async canvasLitFraction(): Promise<number> {
        const png = await this.page.locator("#canvas").screenshot({ timeout: PAGE_CALL_TIMEOUT });
        return this.evaluate(async (b64) => {
            const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext("2d")!;
            context.drawImage(bitmap, 0, 0);
            const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
            let lit = 0;
            let sampled = 0;
            for (let i = 0; i < data.length; i += 4 * 7) {
                sampled++;
                if (data[i] + data[i + 1] + data[i + 2] > 30) lit++;
            }
            return lit / sampled;
        }, png.toString("base64"));
    }

    // The title fades in and out, so a single screenshot can be black; keep looking.
    waitForPicture(minLit = 0.05, timeout = 30_000): Promise<number> {
        return this.waitUntil(async () => {
            const lit = await this.canvasLitFraction();
            return lit >= minLit ? lit : null;
        }, `the canvas to show at least ${minLit * 100}% lit pixels`, timeout);
    }
}

// Title -> file select -> file 1. Resolves once the save has loaded.
//
// For a test that needs a real save rather than any play state; one that only needs a play
// state boots to a warp point instead (mm/wasm/HOST-API.md §4, bootWarpConfig). The sleeps are
// generous because file select runs at 60 Hz while gameplay runs at 20, and the transitions
// between them are not instant.
export async function loadFirstSave(game: Game): Promise<{ event: ShipEvent; index: number }> {
    const from = await game.eventCount();
    if ((await game.run("file_select")) !== 0) {
        throw new Error("file_select refused");
    }
    await Bun.sleep(3000);
    await game.pressButton(PAD.A);
    await Bun.sleep(1500);
    await game.pressButton(PAD.A);
    await Bun.sleep(1500);
    await game.pressButton(PAD.A);
    return game.waitForEvent("load-game", { from, timeout: 45_000 });
}
