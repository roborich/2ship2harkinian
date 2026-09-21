import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FILES_DIR } from "./env";

export function baseConfig(): any {
    return JSON.parse(readFileSync(join(FILES_DIR, "2ship2harkinian.json"), "utf8"));
}

// The base config set up to play, and to start where the tests expect. Debug mode off,
// because with DebugEnabled the file-select flow diverges; and BootToWarpPoint off, because
// the warp point saved in a developer's config sends the game somewhere the test did not ask
// for -- and, today, into the crash in wasm-port.md, "The audio crash".
export function playConfig(): any {
    const config = baseConfig();
    config.CVars.gDeveloperTools = { ...config.CVars.gDeveloperTools, DebugEnabled: 0 };
    if (config.CVars.gDeveloperTools.WarpPoint) {
        config.CVars.gDeveloperTools.WarpPoint = { ...config.CVars.gDeveloperTools.WarpPoint, BootToWarpPoint: 0 };
    }
    return config;
}

export const playFiles = (config: any = playConfig()) => ({ "/2ship2harkinian.json": JSON.stringify(config, null, 4) });

// What an embedder hands over from someone's desktop install: a window and audio backend
// this build does not have, and a saved warp point.
export function staleDesktopConfig(): string {
    const config = playConfig();
    config.Window = { ...config.Window, AudioBackend: "coreaudio", Backend: { Id: 2, Name: "Metal" } };
    return JSON.stringify(config, null, 4);
}
