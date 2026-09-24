#ifdef __EMSCRIPTEN__
#include "EmbedderBridge.h"

#include <emscripten.h>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>
#include <spdlog/spdlog.h>
#include <spdlog/fmt/fmt.h>
#include <libultraship/libultraship.h>
#include "2s2h/GameInteractor/GameInteractor.h"

extern "C" {
#include "variables.h"
extern PlayState* gPlayState;
int AudioPlayer_Buffered(void);
uint32_t Ship_GetInterpolationFPS(void);
}

// ---- AddressSanitizer ---------------------------------------------------------------------
// Compiled only into an `-fsanitize=address` build, where it is the one supported way to set
// ASAN_OPTIONS: a browser has no environment to read them from.
//
//   halt_on_error=0             report every fault and keep going, so one run of the game
//                               collects the whole list instead of one item per relink
//                               (an ASan link of this module takes about ten minutes)
//   detect_container_overflow=0 the std::vector annotations need every translation unit that
//                               touches the container to be instrumented, which is not true
//                               of the FetchContent dependencies; prism's shader header
//                               parser reports one and it is a known false-positive shape
//
// Remove either when chasing something it hides.
#if defined(__has_feature)
#if __has_feature(address_sanitizer)
extern "C" const char* __asan_default_options(void) {
    return "halt_on_error=0:detect_container_overflow=0:print_stacktrace=1";
}
#endif
#endif

// ---- outbound ----------------------------------------------------------------------------
// A listener runs inside dispatchEvent, synchronously, and may call Ship_RunConsoleCommand.
// Inside the frame that raised the event, that command would act on a half-updated game: a
// warp issued from a 'scene' listener would be undone by the rest of Play_Init. So events
// raised during a frame are held and dispatched after it, by Ship_EmbedderAfterFrame. What
// the bridge sends from outside a frame -- file changes, 'quit', 'error' -- goes out at once.

static std::vector<std::string> sHeldEvents;

// Hands one event to the page. JSON is parsed on the JS side so the detail object is a
// plain object the listener can destructure, whoever the listener is.
static void DispatchEvent(const std::string& json) {
    EM_ASM({ window.dispatchEvent(new CustomEvent('2ship', { detail : JSON.parse(UTF8ToString($0)) })); },
           json.c_str());
}

static void DispatchHeldEvents() {
    // A listener's command can raise events of its own; those wait for the next frame.
    std::vector<std::string> events;
    events.swap(sHeldEvents);
    for (const auto& json : events) {
        DispatchEvent(json);
    }
}

// The path a host sees: absolute in the VFS, e.g. /saves/file1.json.
static std::string VfsPath(const std::filesystem::path& path) {
    return std::filesystem::absolute(path).lexically_normal().generic_string();
}

// 'load-game' promises that play-state commands work, but OnSaveLoad fires from file
// select, before the play state exists. The load is remembered and reported with the first
// scene of that game instead.
static int32_t sLoadedFileNum = -1;

static void OnSaveLoad(s16 fileNum) {
    sLoadedFileNum = fileNum;
}

// MM's own vocabulary. `entrance` is the value Save::entrance holds -- the scene and spawn
// packed as the game stores them -- and day/time/isNight are the three-day cycle, which is
// what a host wanting to place the player actually needs. playerForm is Deku/Goron/Zora/
// Fierce Deity/Human.
static void OnSceneInit(s8 sceneId, s8 spawnNum) {
    if (sLoadedFileNum >= 0) {
        sHeldEvents.push_back(fmt::format(R"({{"type":"load-game","fileNum":{}}})", sLoadedFileNum));
        sLoadedFileNum = -1;
    }
    sHeldEvents.push_back(
        fmt::format(R"({{"type":"scene","sceneId":{},"spawnNum":{},"entrance":{},)"
                    R"("day":{},"time":{},"isNight":{},"playerForm":{}}})",
                    sceneId, spawnNum, gSaveContext.save.entrance, gSaveContext.save.day, gSaveContext.save.time,
                    gSaveContext.save.isNight ? "true" : "false", gSaveContext.save.playerForm));
}

// The file's bytes travel as a Uint8Array copy, so the host owns them outright and the
// event carries the same thing whether the file is JSON (config, saves) or not.
static void DispatchFileSaved(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    std::vector<char> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    std::string vfsPath = VfsPath(path);
    EM_ASM(
        {
            window.dispatchEvent(new CustomEvent(
                '2ship',
                { detail : { type : 'file-saved', path : UTF8ToString($0), bytes : HEAPU8.slice($1, $1 + $2) } }));
        },
        vfsPath.c_str(), bytes.data(), bytes.size());
}

static void DispatchFileRemoved(const std::string& path) {
    DispatchEvent(fmt::format(R"({{"type":"file-removed","path":{}}})", nlohmann::json(VfsPath(path)).dump()));
}

// ---- saved files -------------------------------------------------------------------------
// The game writes its config and saves into the in-memory filesystem through several
// unrelated paths, and removes saves through others. Rather than hook each one, watch the
// config and everything under saves/ and report whatever changed or disappeared since the
// last frame.

struct FileStamp {
    std::filesystem::file_time_type mtime;
    uintmax_t size;
    bool operator!=(const FileStamp& o) const {
        return mtime != o.mtime || size != o.size;
    }
};

using FileSnapshot = std::map<std::string, FileStamp>;

struct FileChanges {
    std::vector<std::string> saved;
    std::vector<std::string> removed;
};

static FileSnapshot sSeenFiles;
static bool sSeenFilesPrimed = false;

static std::vector<std::filesystem::path> WatchedFiles() {
    std::vector<std::filesystem::path> files;
    files.push_back(Ship::Context::GetPathRelativeToAppDirectory("2ship2harkinian.json"));
    std::error_code ec;
    // 2Ship keeps saves in `saves/` as file<N>.json, with file<N>backup.json alongside
    // (SaveManager.cpp:33, :231) -- not OoT's Save/file<N>.sav.
    for (const auto& entry :
         std::filesystem::directory_iterator(Ship::Context::GetPathRelativeToAppDirectory("saves"), ec)) {
        if (entry.is_regular_file(ec)) {
            files.push_back(entry.path());
        }
    }
    return files;
}

static FileSnapshot SnapshotWatchedFiles() {
    FileSnapshot snapshot;
    for (const auto& path : WatchedFiles()) {
        std::error_code ec;
        FileStamp stamp{ std::filesystem::last_write_time(path, ec), std::filesystem::file_size(path, ec) };
        if (!ec) {
            snapshot[path.generic_string()] = stamp;
        }
    }
    return snapshot;
}

// What changed between two snapshots: files that are new or different, and files that are gone.
static FileChanges DiffSnapshots(const FileSnapshot& before, const FileSnapshot& after) {
    FileChanges changes;
    for (const auto& [path, stamp] : after) {
        auto seen = before.find(path);
        if (seen == before.end() || seen->second != stamp) {
            changes.saved.push_back(path);
        }
    }
    for (const auto& [path, stamp] : before) {
        if (!after.contains(path)) {
            changes.removed.push_back(path);
        }
    }
    return changes;
}

// Reports every watched file that changed or disappeared since the last call. The first
// call only records what the host supplied, so nothing is reported that the game did not
// itself write.
static void ReportFileChanges() {
    FileSnapshot now = SnapshotWatchedFiles();
    if (sSeenFilesPrimed) {
        FileChanges changes = DiffSnapshots(sSeenFiles, now);
        for (const auto& path : changes.saved) {
            DispatchFileSaved(path);
        }
        for (const auto& path : changes.removed) {
            DispatchFileRemoved(path);
        }
    }
    sSeenFiles = std::move(now);
    sSeenFilesPrimed = true;
}

// ---- diagnostics -------------------------------------------------------------------------
// Counters for mm/wasm/tests and for profiling. Not part of the host contract: the fields
// can change without notice.

static uint64_t sTicks = 0;
static uint64_t sDraws = 0;
static uint64_t sAudioDrops = 0;

void Ship_EmbedderCountDraws(size_t draws) {
    sDraws += draws;
}

void Ship_EmbedderCountAudioDrop(void) {
    sAudioDrops++;
}

// Returns a JSON object, valid until the next call. updateRate is R_UPDATE_RATE, the game's
// vsync divisor; sceneId is -1 outside a play state. interpolationFps is what the frame
// interpolator asks for, and 20 means it is switched off -- this build always reports 20, so a
// host-supplied config cannot turn the recording work back on.
// synthOversized counts synthesis loads larger than a note can legitimately ask for; see
// gWasmSynthOversizedLoads in mm/src/audio/lib/synthesis.c. Zero on a healthy build.
extern "C" uint32_t gWasmSynthOversizedLoads;

extern "C" EMSCRIPTEN_KEEPALIVE const char* Ship_GetStats(void) {
    static std::string json;
    json = fmt::format(
        R"({{"ticks":{},"draws":{},"updateRate":{},"audioBuffered":{},"audioDrops":{},"sceneId":{},"interpolationFps":{},"synthOversized":{}}})",
        sTicks, sDraws, R_UPDATE_RATE, AudioPlayer_Buffered(), sAudioDrops,
        gPlayState != nullptr ? gPlayState->sceneId : -1, Ship_GetInterpolationFPS(), gWasmSynthOversizedLoads);
    return json.c_str();
}

// ---- entry points ------------------------------------------------------------------------

// Must run before anything in InitOTR can write a watched file: the context rewrites a stale
// Window.AudioBackend and the version updaters migrate the config, both before the bridge's
// hooks can be registered. Priming later would record the game's copy as the host's, and the
// host would never hear of those writes.
void Ship_EmbedderPrimeFiles(void) {
    ReportFileChanges();
}

void Ship_InitEmbedderBridge(void) {
    GameInteractor::Instance->RegisterGameHook<GameInteractor::OnSaveLoad>(OnSaveLoad);
    GameInteractor::Instance->RegisterGameHook<GameInteractor::OnSceneInit>(OnSceneInit);
}

void Ship_EmbedderAfterFrame(void) {
    sTicks++;
    DispatchHeldEvents();
    ReportFileChanges();
}

void Ship_EmbedderQuit(void) {
    // Anything raised or written on the way out goes first.
    DispatchHeldEvents();
    ReportFileChanges();
    DispatchEvent(R"({"type":"quit"})");
}

// 2S2H [WASM] An exception escaping the frame callback reaches Emscripten's
// handleException, which calls quit_ and stops the main loop: the tab stays alive, the game
// freezes, and the console shows only "Uncaught Exception {stack: undefined}" with no
// message. Name it, so the next one is diagnosable rather than mysterious.
void Ship_RunFrameGuarded(void (*runFrame)(void)) {
    try {
        runFrame();
    } catch (const std::exception& e) {
        SPDLOG_ERROR("Unhandled exception in frame: {}", e.what());
        Ship_EmbedderError(e.what());
        throw;
    } catch (...) {
        SPDLOG_ERROR("Unhandled non-standard exception in frame");
        Ship_EmbedderError("non-standard exception");
        throw;
    }
}

void Ship_EmbedderError(const char* message) {
    // The loop stops after this, with no Ship_EmbedderAfterFrame for the failing frame:
    // report what that frame raised or wrote now, so a save made just before the throw is
    // not lost.
    DispatchHeldEvents();
    ReportFileChanges();
    // `replace`: a what() carrying bytes that are not UTF-8 (a parse error quoting the file
    // it choked on) would otherwise make dump() throw, and the host would never hear of it.
    std::string text = nlohmann::json(message).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
    DispatchEvent(fmt::format(R"({{"type":"error","message":{}}})", text));
}

// Inbound. Called from JS between frames: the build is single-threaded, so a ccall can
// only land while no frame is running, and events are dispatched after their frame (see
// "outbound") so this holds inside a listener too. Handlers that queue work for the next
// frame behave exactly as they do when typed into the console.
//
// Returns the handler's own result (0 is success by convention), -1 before the console
// exists, -2 for a command the console does not know. The last case is separate because
// Console::Run reports "unknown command" as 0, the same value as success.
extern "C" EMSCRIPTEN_KEEPALIVE int32_t Ship_RunConsoleCommand(const char* command) {
    auto context = Ship::Context::GetRawInstance();
    if (context == nullptr || context->GetConsole() == nullptr) {
        SPDLOG_WARN("Ship_RunConsoleCommand(\"{}\") before the console exists; ignored", command);
        return -1;
    }
    auto console = context->GetConsole();
    std::string line = command;
    std::string name = line.substr(0, line.find(' '));
    if (!console->HasCommand(name)) {
        SPDLOG_WARN("Ship_RunConsoleCommand: unknown command \"{}\"", name);
        return -2;
    }
    std::string output;
    return console->Run(line, &output);
}
#endif // __EMSCRIPTEN__
