import type { SessionState, ToolParameterEntry, WithParts } from "./types"
import type { Logger } from "../logger"
import { applyPendingCompressionDurations, resetCompressionStarts } from "../compress/timing"
import { loadSessionState, saveSessionState } from "./persistence"
import {
    isSubAgentSession,
    findLastCompactionTimestamp,
    countTurns,
    resetOnCompaction,
    createMessageIdsState,
    createPruneMessagesState,
    loadMessageIdsState,
    loadPruneMessagesState,
    loadPruneMap,
    collectTurnNudgeAnchors,
} from "./utils"
import { getLastUserMessage } from "../messages/query"

export const checkSession = async (
    client: any,
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    manualModeDefault: boolean,
): Promise<void> => {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        // Fail open: with no user message this payload carries no identity, and
        // mutating here would attribute the request to whichever session this
        // state object happens to belong to.
        return
    }

    const lastSessionId = lastUserMessage.info.sessionID
    if (!lastSessionId) {
        // No identity in the payload: fail open and mutate nothing.
        return
    }

    if (state.sessionId !== null && state.sessionId !== lastSessionId) {
        // The routing layer hands over the state owned by this session, so a
        // mismatch means this payload cannot be attributed safely. Mutate nothing
        // rather than touching another session's state.
        logger.debug("Session identity mismatched with state owner; skipping state update", {
            expected: state.sessionId,
            received: lastSessionId,
        })
        return
    }

    if (state.sessionId === null) {
        // Claim the state for this payload before any await, so a concurrent
        // request for the same session re-enters this entry instead of installing
        // a second one.
        state.sessionId = lastSessionId
    }

    await ensureSessionInitialized(
        client,
        state,
        lastSessionId,
        logger,
        messages,
        manualModeDefault,
    )

    const lastCompactionTimestamp = findLastCompactionTimestamp(messages)
    if (lastCompactionTimestamp > state.lastCompaction) {
        state.lastCompaction = lastCompactionTimestamp
        resetOnCompaction(state)
        logger.info("Detected compaction - reset stale state", {
            timestamp: lastCompactionTimestamp,
        })

        saveSessionState(state, logger).catch((error) => {
            logger.warn("Failed to persist state reset after compaction", {
                error: error instanceof Error ? error.message : String(error),
            })
        })
    }

    state.currentTurn = countTurns(state, messages)
}

export function createSessionState(): SessionState {
    return {
        sessionId: null,
        initialized: false,
        isSubAgent: false,
        manualMode: false,
        compressPermission: undefined,
        pendingManualTrigger: null,
        prune: {
            tools: new Map<string, number>(),
            messages: createPruneMessagesState(),
        },
        nudges: {
            contextLimitAnchors: new Set<string>(),
            turnNudgeAnchors: new Set<string>(),
            iterationNudgeAnchors: new Set<string>(),
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
        },
        compressionTiming: {
            startsByCallId: new Map<string, number>(),
            pendingByCallId: new Map(),
        },
        toolParameters: new Map<string, ToolParameterEntry>(),
        subAgentResultCache: new Map<string, string>(),
        toolIdList: [],
        messageIds: createMessageIdsState(),
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: undefined,
        systemPromptTokens: undefined,
    }
}

export function resetSessionState(state: SessionState): void {
    state.sessionId = null
    state.initialized = false
    state.isSubAgent = false
    state.manualMode = false
    state.compressPermission = undefined
    state.pendingManualTrigger = null
    state.prune = {
        tools: new Map<string, number>(),
        messages: createPruneMessagesState(),
    }
    state.nudges = {
        contextLimitAnchors: new Set<string>(),
        turnNudgeAnchors: new Set<string>(),
        iterationNudgeAnchors: new Set<string>(),
    }
    state.stats = {
        pruneTokenCounter: 0,
        totalPruneTokens: 0,
    }
    // Starts are dropped, pending durations are not. A start belongs to the
    // conversation this state was bound to before the reset. A pending duration is
    // still on its way to a block: `ensureSessionInitialized` calls this reset
    // *before* it loads the session's blocks and applies what is pending, which is
    // how a completion that arrived before the session was loaded reaches its
    // block - dropping it here would lose that duration for good.
    // Cleared in place rather than reassigned, unlike `messageIds`/`prune` above:
    // an in-flight operation can hold the timing maps directly (createEventHandler
    // in lib/hooks.ts, finalizeSession in lib/compress/pipeline.ts), and it has to
    // observe the reset instead of writing into a map this state no longer owns.
    resetCompressionStarts(state)
    state.toolParameters.clear()
    state.subAgentResultCache.clear()
    state.toolIdList = []
    // Kept as a reset: ensureSessionInitialized loads the session right after this
    // and restores what was persisted, including the alias space (see below). With
    // no file on disk the empty default is the session's state.
    state.messageIds = createMessageIdsState()
    state.lastCompaction = 0
    state.currentTurn = 0
    state.modelContextLimit = undefined
    state.systemPromptTokens = undefined
}

export async function ensureSessionInitialized(
    client: any,
    state: SessionState,
    sessionId: string,
    logger: Logger,
    messages: WithParts[],
    manualModeEnabled: boolean,
): Promise<void> {
    if (state.sessionId === sessionId && state.initialized) {
        return
    }

    // logger.info("session ID = " + sessionId)
    // logger.info("Initializing session state", { sessionId: sessionId })

    resetSessionState(state)
    state.manualMode = manualModeEnabled ? "active" : false
    state.sessionId = sessionId

    const isSubAgent = await isSubAgentSession(client, sessionId)
    state.isSubAgent = isSubAgent
    // logger.info("isSubAgent = " + isSubAgent)

    state.lastCompaction = findLastCompactionTimestamp(messages)
    state.currentTurn = countTurns(state, messages)
    state.nudges.turnNudgeAnchors = collectTurnNudgeAnchors(messages)

    const persisted = await loadSessionState(sessionId, logger)
    if (persisted === null) {
        // Nothing on disk: the reset state is the session's state, and marking it
        // initialized keeps later requests from re-resetting it.
        state.initialized = true
        return
    }

    state.prune.tools = loadPruneMap(persisted.prune.tools)
    state.prune.messages = loadPruneMessagesState(persisted.prune.messages)
    state.nudges.contextLimitAnchors = new Set<string>(persisted.nudges.contextLimitAnchors || [])
    state.nudges.turnNudgeAnchors = new Set<string>([
        ...state.nudges.turnNudgeAnchors,
        ...(persisted.nudges.turnNudgeAnchors || []),
    ])
    state.nudges.iterationNudgeAnchors = new Set<string>(
        persisted.nudges.iterationNudgeAnchors || [],
    )
    state.stats = {
        pruneTokenCounter: persisted.stats?.pruneTokenCounter || 0,
        totalPruneTokens: persisted.stats?.totalPruneTokens || 0,
    }
    // The alias space has to come back with the session: without this the refs the
    // model was already shown are minted again from m0001 for other messages.
    state.messageIds = loadMessageIdsState(persisted.messageIds)

    const applied = applyPendingCompressionDurations(state)
    if (applied > 0) {
        await saveSessionState(state, logger)
    }

    state.initialized = true
}
