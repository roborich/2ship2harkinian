#include "prevent_bss_reordering.h"
#include "z64.h"
#include "regs.h"
#include "functions.h"
#include "fault.h"
#include <libultraship/bridge/gfxdebuggerbridge.h>
#include <libultraship/bridge/consolevariablebridge.h>
#include <libultraship/bridge/windowbridge.h>
#include <string.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include "2s2h/EmbedderBridge.h"
void Ship_RunFrameGuarded(void (*runFrame)(void));
#endif

// Variables are put before most headers as a hacky way to bypass bss reordering
FaultAddrConvClient sGraphFaultAddrConvClient;
FaultClient sGraphFaultClient;
GfxMasterList* gGfxMasterDL;
CfbInfo sGraphCfbInfos[3];
OSTime sGraphPrevUpdateEndTime;

#include "variables.h"
#include "macros.h"
#include "buffers.h"
#include "idle.h"
#include "sys_cfb.h"
#include "system_malloc.h"
#include "z64speed_meter.h"
#include "overlays/gamestates/ovl_daytelop/z_daytelop.h"
#include "overlays/gamestates/ovl_file_choose/z_file_select.h"
#include "overlays/gamestates/ovl_opening/z_opening.h"
#include "overlays/gamestates/ovl_select/z_select.h"
#include "overlays/gamestates/ovl_title/z_title.h"
#include "z_title_setup.h"
#include "BenPort.h"

void Graph_StartFrame();
void Graph_ProcessGfxCommands(Gfx* commands);
void Graph_ProcessFrame(void (*run_one_game_iter)(void));

void Graph_FaultClient(void) {
    FaultDrawer_DrawText(30, 100, "ShowFrameBuffer PAGE 0/1");
    osViSwapBuffer(SysCfb_GetFramebuffer(0));
    osViSetMode(gActiveViMode);
    osViSetSpecialFeatures(OS_VI_DITHER_FILTER_ON | OS_VI_GAMMA_OFF);
    Fault_WaitForInput();
    osViSwapBuffer(SysCfb_GetFramebuffer(1));
    osViSetMode(gActiveViMode);
    osViSetSpecialFeatures(OS_VI_DITHER_FILTER_ON | OS_VI_GAMMA_OFF);
}

void Graph_InitTHGA(TwoHeadGfxArena* arena, Gfx* buffer, s32 size) {
    THGA_Init(arena, buffer, size);
}

void Graph_SetNextGfxPool(GraphicsContext* gfxCtx) {
    GfxPool* pool = &gGfxPools[gfxCtx->gfxPoolIdx % 2];

    gGfxMasterDL = &pool->master;
    gSegments[0x0E] = gGfxMasterDL;

    pool->headMagic = GFXPOOL_HEAD_MAGIC;
    pool->tailMagic = GFXPOOL_TAIL_MAGIC;

    Graph_InitTHGA(&gfxCtx->polyOpa, pool->polyOpaBuffer, sizeof(pool->polyOpaBuffer));
    Graph_InitTHGA(&gfxCtx->polyXlu, pool->polyXluBuffer, sizeof(pool->polyXluBuffer));
    Graph_InitTHGA(&gfxCtx->overlay, pool->overlayBuffer, sizeof(pool->overlayBuffer));
    Graph_InitTHGA(&gfxCtx->work, pool->workBuffer, sizeof(pool->workBuffer));
    Graph_InitTHGA(&gfxCtx->debug, pool->debugBuffer, sizeof(pool->debugBuffer));

    gfxCtx->polyOpaBuffer = pool->polyOpaBuffer;
    gfxCtx->polyXluBuffer = pool->polyXluBuffer;
    gfxCtx->overlayBuffer = pool->overlayBuffer;
    gfxCtx->workBuffer = pool->workBuffer;
    gfxCtx->debugBuffer = pool->debugBuffer;

    gfxCtx->curFrameBuffer = SysCfb_GetFramebuffer(gfxCtx->framebufferIndex % 2);
    gSegments[0x0F] = gfxCtx->curFrameBuffer;

    gfxCtx->zbuffer = SysCfb_GetZBuffer();

    gSPBranchList(&gGfxMasterDL->disps[0], pool->polyOpaBuffer);
    gSPBranchList(&gGfxMasterDL->disps[1], pool->polyXluBuffer);
    gSPBranchList(&gGfxMasterDL->disps[2], pool->overlayBuffer);
    gSPBranchList(&gGfxMasterDL->disps[3], pool->workBuffer);
    gSPEndDisplayList(&gGfxMasterDL->disps[4]);
    gSPBranchList(&gGfxMasterDL->debugDisp[0], pool->debugBuffer);
}

GameStateOverlay* Graph_GetNextGameState(GameState* gameState) {
    GameStateFunc gameStateInit = GameState_GetInit(gameState);

    // Generates code to match gameStateInit to a gamestate entry and returns it if found
#define DEFINE_GAMESTATE_INTERNAL(typeName, enumName) \
    if (gameStateInit == typeName##_Init) {           \
        return &gGameStateOverlayTable[enumName];     \
    }
#define DEFINE_GAMESTATE(typeName, enumName, name) DEFINE_GAMESTATE_INTERNAL(typeName, enumName)

#include "tables/gamestate_table.h"

#undef DEFINE_GAMESTATE
#undef DEFINE_GAMESTATE_INTERNAL

    return NULL;
}

uintptr_t Graph_FaultAddrConv(uintptr_t address, void* param) {
    uintptr_t addr = address;
    GameStateOverlay* gameStateOvl = &gGameStateOverlayTable[0];
    uintptr_t ramConv;
    void* ramStart;
    size_t diff;
    s32 i;

    for (i = 0; i < gGraphNumGameStates; i++, gameStateOvl++) {
        diff = (uintptr_t)gameStateOvl->vramEnd - (uintptr_t)gameStateOvl->vramStart;
        ramStart = gameStateOvl->loadedRamAddr;
        ramConv = (uintptr_t)gameStateOvl->vramStart - (uintptr_t)ramStart;

        if (ramStart != NULL) {
            if ((addr >= (uintptr_t)ramStart) && (addr < (uintptr_t)ramStart + diff)) {
                return addr + ramConv;
            }
        }
    }
    return 0;
}

void Graph_Init(GraphicsContext* gfxCtx) {
    memset(gfxCtx, 0, sizeof(GraphicsContext));
    gfxCtx->gfxPoolIdx = 0;
    gfxCtx->framebufferIndex = 0;
    gfxCtx->viMode = NULL;
    gfxCtx->viConfigFeatures = gViConfigFeatures;
    gfxCtx->xScale = gViConfigXScale;
    gfxCtx->yScale = gViConfigYScale;
    osCreateMesgQueue(&gfxCtx->queue, gfxCtx->msgBuff, ARRAY_COUNT(gfxCtx->msgBuff));
    // Fault_AddClient(&sGraphFaultClient, (void*)Graph_FaultClient, NULL, NULL);
    // Fault_AddAddrConvClient(&sGraphFaultAddrConvClient, Graph_FaultAddrConv, NULL);
}

void Graph_Destroy(GraphicsContext* gfxCtx) {
    // Fault_RemoveClient(&sGraphFaultClient);
    // Fault_RemoveAddrConvClient(&sGraphFaultAddrConvClient);
}

/**
 * Constructs the graphics OSTask and forwards it to the scheduler.
 * Waits for up to 3 additional seconds for any current graphics task to complete.
 * If it does not signal completion in that time, retry or trigger a crash.
 */
void Graph_TaskSet00(GraphicsContext* gfxCtx, GameState* gameState) {
    static s32 retryCount = 10;
    static s32 cfbIdx = 0;
    OSTask_t* task = &gfxCtx->task.list.t;
    OSScTask* scTask = &gfxCtx->task;
    OSTimer timer;
    OSMesg msg;
    CfbInfo* cfb;

retry:
// osSetTimer(&timer, OS_USEC_TO_CYCLES(3 * 1000 * 1000), 0, &gfxCtx->queue, (OSMesg)666);
// osRecvMesg(&gfxCtx->queue, &msg, OS_MESG_BLOCK);
// osStopTimer(&timer);
#if 0
    if (msg == (OSMesg)666) {
        osSyncPrintf("GRAPH SP TIMEOUT\n");
        if (retryCount >= 0) {
            retryCount--;
            Sched_SendGfxCancelMsg(&gSchedContext);
            goto retry;
        } else {
            // graph.c: No more! die!
            osSyncPrintf("graph.c:もうダメ！死ぬ！\n");
            //Fault_AddHungupAndCrashImpl("RCP is HUNG UP!!", "Oh! MY GOD!!");
        }
    }
#endif
    gfxCtx->masterList = gGfxMasterDL;
    if (gfxCtx->callback != NULL) {
        gfxCtx->callback(gfxCtx, gfxCtx->callbackArg);
    }

    task->type = M_GFXTASK;
    task->flags = OS_SC_DRAM_DLIST;
    task->ucode_boot = SysUcode_GetUCodeBoot();
    task->ucode_boot_size = SysUcode_GetUCodeBootSize();
    task->ucode = SysUcode_GetUCode();
    // task->ucode_data = SysUcode_GetUCodeData();
    task->ucode_size = SP_UCODE_SIZE;
    task->ucode_data_size = SP_UCODE_DATA_SIZE;
    task->dram_stack = (u64*)gGfxSPTaskStack;
    task->dram_stack_size = sizeof(gGfxSPTaskStack);
    task->output_buff = gGfxSPTaskOutputBufferPtr;
    task->output_buff_size = gGfxSPTaskOutputBufferEnd;
    task->data_ptr = (u64*)gGfxMasterDL;
    OPEN_DISPS(gfxCtx);
    task->data_size = (uintptr_t)WORK_DISP - (uintptr_t)gfxCtx->workBuffer;
    CLOSE_DISPS(gfxCtx);

    task->yield_data_ptr = (u64*)gGfxSPTaskYieldBuffer;
    task->yield_data_size = sizeof(gGfxSPTaskYieldBuffer);

    scTask->next = NULL;
    scTask->flags = OS_SC_RCP_MASK | OS_SC_SWAPBUFFER | OS_SC_LAST_TASK;

    if (SREG(33) & 1) {
        SREG(33) &= ~1;
        scTask->flags &= ~OS_SC_SWAPBUFFER;
        gfxCtx->framebufferIndex--;
    }

    scTask->msgQ = &gfxCtx->queue;
    scTask->msg.ptr = NULL;

    { s32 pad; }

    cfb = &sGraphCfbInfos[cfbIdx];
    cfbIdx = (cfbIdx + 1) % ARRAY_COUNT(sGraphCfbInfos);

    cfb->fb1 = gfxCtx->curFrameBuffer;
    cfb->swapBuffer = gfxCtx->curFrameBuffer;

    if (gfxCtx->updateViMode) {
        gfxCtx->updateViMode = false;
        cfb->viMode = gfxCtx->viMode;
        cfb->features = gfxCtx->viConfigFeatures;
        cfb->xScale = gfxCtx->xScale;
        cfb->yScale = gfxCtx->yScale;
    } else {
        cfb->viMode = NULL;
    }
    cfb->unk_10 = 0;
    cfb->updateRate = gameState->framerateDivisor;

    scTask->framebuffer = cfb;

    while (gfxCtx->queue.validCount != 0) {
        osRecvMesg(&gfxCtx->queue, NULL, OS_MESG_NOBLOCK);
    }

    gfxCtx->schedMsgQ = &gSchedContext.cmdQ;
    osSendMesg(&gSchedContext.cmdQ, OS_MESG_PTR(scTask), OS_MESG_BLOCK);
    Sched_SendEntryMsg(&gSchedContext);
}

void Graph_UpdateGame(GameState* gameState) {
    GameState_GetInput(gameState);
    GameState_IncrementFrameCount(gameState);
    // BENTODO
    if (SREG(20) < 3) {
        Audio_Update();
    }
}

/**
 *  Run the game state logic, then finalize the gfx buffer
 *  and run the graphics task for this frame.
 */
void Graph_ExecuteAndDraw(GraphicsContext* gfxCtx, GameState* gameState) {
    u32 problem;
    if (GfxDebuggerIsDebugging()) {
        Graph_ProcessGfxCommands(&gGfxMasterDL->taskStart[0]);
        return;
    }

    gameState->unk_A3 = 0;
    Graph_SetNextGfxPool(gfxCtx);

    GameState_Update(gameState);

    OPEN_DISPS(gfxCtx);

    gSPEndDisplayList(WORK_DISP++);
    gSPEndDisplayList(POLY_OPA_DISP++);
    gSPEndDisplayList(POLY_XLU_DISP++);
    gSPEndDisplayList(OVERLAY_DISP++);
    gSPEndDisplayList(DEBUG_DISP++);

    CLOSE_DISPS(gfxCtx);

    {
        Gfx* gfx = gGfxMasterDL->taskStart;

        gSPSegment(gfx++, 0x0E, gGfxMasterDL);
        gSPDisplayList(gfx++, D_0E000000_TO_SEGMENTED(disps[3]));     // Work buffer
        gSPDisplayList(gfx++, D_0E000000_TO_SEGMENTED(disps[0]));     // OPA buffer
        gSPDisplayList(gfx++, D_0E000000_TO_SEGMENTED(disps[1]));     // XLU buffer
        gSPDisplayList(gfx++, D_0E000000_TO_SEGMENTED(disps[2]));     // Overlay buffer
        gSPDisplayList(gfx++, D_0E000000_TO_SEGMENTED(debugDisp[0])); // Debug buffer

        gDPPipeSync(gfx++);
        gDPFullSync(gfx++);
        gSPEndDisplayList(gfx++);
    }

    problem = false;

    {
        GfxPool* pool = &gGfxPools[gfxCtx->gfxPoolIdx % 2];

        if (pool->headMagic != GFXPOOL_HEAD_MAGIC) {
            // Fault_AddHungupAndCrash("../graph.c", 1054);
        }
        if (pool->tailMagic != GFXPOOL_TAIL_MAGIC) {
            // Fault_AddHungupAndCrash("../graph.c", 1066);
        }
    }

    if (THGA_IsCrash(&gfxCtx->polyOpa)) {
        problem = true;
    }
    if (THGA_IsCrash(&gfxCtx->polyXlu)) {
        problem = true;
    }
    if (THGA_IsCrash(&gfxCtx->overlay)) {
        problem = true;
    }
    if (THGA_IsCrash(&gfxCtx->work)) {
        problem = true;
    }
    if (THGA_IsCrash(&gfxCtx->debug)) {
        problem = true;
    }

    if (!problem) {
        Graph_TaskSet00(gfxCtx, gameState);
        gfxCtx->gfxPoolIdx++;
        gfxCtx->framebufferIndex++;

        if (GfxDebuggerIsDebuggingRequested()) {
            GfxDebuggerDebugDisplayList(&gGfxMasterDL->taskStart[0]);
        }
        Graph_ProcessGfxCommands(&gGfxMasterDL->taskStart[0]);
    }

    {
        OSTime time = osGetTime();

        gRSPGfxTimeTotal = gRSPGfxTimeAcc;
        gRSPAudioTimeTotal = gRSPAudioTimeAcc;
        // #region @2S2H [Port] gRDPTimeAcc is usually set in Sched_HandleRDPDone, which
        // is currently never called and stubbed out in the port. For now we're
        // just opting to set this to the time per frame / 10 instead, no idea
        // how bad of an idea this is. :)
        gRDPTimeTotal = (time - gRDPTimeAcc) / 10;
        gRSPGfxTimeAcc = 0;
        gRSPAudioTimeAcc = 0;
        gRDPTimeAcc = time;
        // #endregion

        if (sGraphPrevUpdateEndTime != 0) {
            gGraphUpdatePeriod = time - sGraphPrevUpdateEndTime;
        }
        sGraphPrevUpdateEndTime = time;
    }
}

void Graph_Update(GraphicsContext* gfxCtx, GameState* gameState) {
    gameState->unk_A3 = 0;

    Graph_UpdateGame(gameState);
    Graph_ExecuteAndDraw(gfxCtx, gameState);
}

static struct RunFrameContext {
    GraphicsContext gfxCtx;
    GameState* gameState;
    GameStateOverlay* nextOvl;
    GameStateOverlay* ovl;
    int state;
} runFrameContext;

void RunFrame() {
    GraphicsContext gfxCtx;
    GameStateOverlay* nextOvl = &gGameStateOverlayTable[0];
    GameStateOverlay* ovl;
    GameState* gameState;
    u32 size;
    s32 pad[2];

    switch (runFrameContext.state) {
        case 0:
            break;
        case 1:
            goto nextFrame;
    }

    runFrameContext.nextOvl = &gGameStateOverlayTable[0];
    SysCfb_Init();
    Graph_Init(&runFrameContext.gfxCtx);
    while (runFrameContext.nextOvl) {
        runFrameContext.ovl = runFrameContext.nextOvl;
        Overlay_LoadGameState(runFrameContext.ovl);

        size = runFrameContext.ovl->instanceSize;
        osSyncPrintf("クラスサイズ＝%dバイト\n", size); // "Class size = %d bytes"

        runFrameContext.gameState = SystemArena_Malloc(size);

        memset(runFrameContext.gameState, 0, size); // fix
        GameState_Init(runFrameContext.gameState, runFrameContext.ovl->init, &runFrameContext.gfxCtx);

        uint64_t freq = GetFrequency();

        while (GameState_IsRunning(runFrameContext.gameState)) {

            Graph_StartFrame();

            // 2S2H [WASM] No argument: PadMgr_ThreadEntry is defined `void
            // PadMgr_ThreadEntry()` (padmgr.c) and works off sPadMgrInstance. The old
            // argument was ignored, but left graph.c and padmgr.c disagreeing about the
            // function's type, which wasm-ld reported as a signature mismatch.
            PadMgr_ThreadEntry();

            Graph_Update(&runFrameContext.gfxCtx, runFrameContext.gameState);
            // ticksB = GetPerfCounter();

            // Graph_ProcessGfxCommands(runFrameContext.gfxCtx.workBuffer);
            // Graph_ProcessGfxCommands(gGfxMasterDL->taskStart);
            //  uint64_t diff = (ticksB - ticksA) / (freq / 1000);
            //  printf("Frame simulated in %ims\n", diff);
            runFrameContext.state = 1;
            return;
        nextFrame:;
        }

        runFrameContext.nextOvl = Graph_GetNextGameState(runFrameContext.gameState);
        GameState_Destroy(runFrameContext.gameState);
        SystemArena_Free(runFrameContext.gameState);
        Overlay_FreeGameState(runFrameContext.ovl);
    }
    Graph_Destroy(&runFrameContext.gfxCtx);
}

#ifdef __EMSCRIPTEN__
// 2S2H [WASM] When the next tick is due. Ticks are scheduled against this running deadline
// rather than "period after this one started", so neither setTimeout's lateness nor the
// whole-millisecond timer resolution accumulates into a slow or fast game.
typedef struct {
    double nextTickMs;
    s32 updateRate;
} TickClock;

// Advances the clock past the tick that started at tickStartMs and returns the delay, in ms
// from that start, until the next one. A new update rate, or a loop more than three ticks
// behind (a background tab, a long synchronous load), restarts the deadline from now rather
// than racing to catch up.
static s32 TickClock_Advance(TickClock* clock, double tickStartMs, s32 updateRate) {
    double periodMs = 1000.0 * updateRate / 60.0;
    if (updateRate != clock->updateRate || clock->nextTickMs < tickStartMs - 3.0 * periodMs) {
        clock->updateRate = updateRate;
        clock->nextTickMs = tickStartMs;
    }
    clock->nextTickMs += periodMs;
    double delayMs = clock->nextTickMs - tickStartMs;
    return delayMs > 0.0 ? (s32)(delayMs + 0.5) : 0;
}

// 2S2H [WASM] A browser tab must return to its event loop to draw anything or receive
// input, so the game cannot own an infinite loop. RunFrame() is already a resumable state
// machine (see RunFrameContext above), which makes it usable as a callback directly.
//
// The tick rate is the game's, not the display's. It is not constant: the game runs at
// 60/R_UPDATE_RATE Hz and GameState_SetFramerateDivisor changes R_UPDATE_RATE per game
// state, so the delay to the next callback is re-derived after every frame (see below).
// setTimeout-driven rather than requestAnimationFrame, which would run at the display's
// rate and desynchronise both the game speed and the audio. See wasm-port.md.
static void Graph_EmscriptenFrame(void) {
    static TickClock sClock;
    // Emscripten's setTimeout scheduler measures the delay from when this callback started.
    double tickStartMs = emscripten_get_now();

    if (!WindowIsRunning()) {
        Ship_EmbedderQuit();
        emscripten_cancel_main_loop();
        return;
    }
    Ship_RunFrameGuarded(RunFrame);
    Ship_EmbedderAfterFrame();

    // 2S2H [WASM] R_UPDATE_RATE is the N64's vsync divisor: the game runs at
    // 60/R_UPDATE_RATE Hz and synthesises R_UPDATE_RATE audio buffers per frame, so the two
    // cancel and audio always comes out at 32 kHz. Game states change it -- 3 while playing,
    // 2 in the pause menu and in message boxes, 1 on the title, file select, opening and
    // map-select screens -- and a loop pinned to one rate breaks that cancellation: at a
    // fixed 20 Hz, pausing would produce 2/3 of the samples per second and the music would
    // play slow, the title screen 1/3.
    if (R_UPDATE_RATE > 0) {
        emscripten_set_main_loop_timing(EM_TIMING_SETTIMEOUT, TickClock_Advance(&sClock, tickStartMs, R_UPDATE_RATE));
    }
}
#endif

void Graph_ThreadEntry(void* arg0) {
#ifdef __EMSCRIPTEN__
    // 20 Hz is the R_UPDATE_RATE == 3 case; Graph_EmscriptenFrame re-derives the rate from
    // R_UPDATE_RATE after each frame, so this is only the starting value.
    // simulate_infinite_loop = 1: unwinds this stack without running destructors, so
    // everything Main() set up stays alive for the callbacks. It does not return.
    emscripten_set_main_loop(Graph_EmscriptenFrame, 20, 1);
#else
    while (WindowIsRunning()) {
        RunFrame();
    }
#endif
}

// #region 2S2H [Debugging] Debugging methods for viewing file/line info in the renderer.
// Particularly useful with the Gfx Debugger window
// Modeled after OOT-debug decomp
void Graph_OpenDisps(Gfx** dispRefs, Gfx* dispVals, GraphicsContext* gfxCtx, const char* file, s32 line) {
    // Copy pointers and values for restoration in CloseDisps
    dispRefs[0] = gfxCtx->polyOpa.p;
    dispVals[0] = gfxCtx->polyOpa.p[0];
    dispRefs[1] = gfxCtx->polyXlu.p;
    dispVals[1] = gfxCtx->polyXlu.p[0];
    dispRefs[2] = gfxCtx->overlay.p;
    dispVals[2] = gfxCtx->overlay.p[0];

    gDPNoOpOpenDisp(gfxCtx->polyOpa.p++, file, line);
    gDPNoOpOpenDisp(gfxCtx->polyXlu.p++, file, line);
    gDPNoOpOpenDisp(gfxCtx->overlay.p++, file, line);
}

void Graph_CloseDisps(Gfx** dispRefs, Gfx* dispVals, GraphicsContext* gfxCtx, const char* file, s32 line) {
    // If no instructions were added for a buffer since the OpenDisp,
    // restore the buffer pointer and original value (essentially removing the noop open)
    if (dispRefs[0] + 1 == gfxCtx->polyOpa.p) {
        gfxCtx->polyOpa.p = dispRefs[0];
        gfxCtx->polyOpa.p[0] = dispVals[0];
    } else {
        gDPNoOpCloseDisp(gfxCtx->polyOpa.p++, file, line);
    }

    if (dispRefs[1] + 1 == gfxCtx->polyXlu.p) {
        gfxCtx->polyXlu.p = dispRefs[1];
        gfxCtx->polyXlu.p[0] = dispVals[1];
    } else {
        gDPNoOpCloseDisp(gfxCtx->polyXlu.p++, file, line);
    }

    if (dispRefs[2] + 1 == gfxCtx->overlay.p) {
        gfxCtx->overlay.p = dispRefs[2];
        gfxCtx->overlay.p[0] = dispVals[2];
    } else {
        gDPNoOpCloseDisp(gfxCtx->overlay.p++, file, line);
    }
}
// #endregion
