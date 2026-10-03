import type { SessionState, WithParts } from "../state"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import { isSessionRegistry, resolveSessionState } from "../state/registry"
import { assignMessageRefs } from "../message-ids"
import { isIgnoredUserMessage } from "../messages/query"
import { deduplicate, purgeErrors } from "../strategies"
import { getCurrentParams, getCurrentTokenUsage } from "../token-utils"
import { sendCompressNotification } from "../ui/notification"
import type { ToolContext } from "./types"
import { buildSearchContext, fetchSessionMessages } from "./search"
import type { SearchContext } from "./types"
import { applyPendingCompressionDurations } from "./timing"

interface RunContext {
    ask(input: {
        permission: string
        patterns: string[]
        always: string[]
        metadata: Record<string, unknown>
    }): Promise<void>
    metadata(input: { title: string }): void
    sessionID: string
}

export interface NotificationEntry {
    blockId: number
    runId: number
    summary: string
    summaryTokens: number
}

export interface PreparedSession {
    state: SessionState
    rawMessages: WithParts[]
    searchContext: SearchContext
}

/**
 * Resolve the session state owned by this tool call and hold the rest of the
 * tool execution under that session's serialization chain, so tool mutations
 * cannot interleave with the same session's messages transform or commands.
 */
export async function withToolSession<T>(
    ctx: ToolContext,
    sessionId: string,
    operation: (state: SessionState) => Promise<T>,
): Promise<T> {
    const run = async () => {
        const state = resolveSessionState(ctx.source, sessionId)
        if (!state) {
            throw new Error("DCP: session identity unavailable for compress tool")
        }
        return operation(state)
    }

    if (isSessionRegistry(ctx.source) && sessionId) {
        return ctx.source.run(sessionId, run)
    }

    return run()
}

export async function prepareSession(
    ctx: ToolContext,
    state: SessionState,
    toolCtx: RunContext,
    title: string,
): Promise<PreparedSession> {
    if (state.manualMode && state.manualMode !== "compress-pending") {
        throw new Error(
            "Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context.",
        )
    }

    await toolCtx.ask({
        permission: "compress",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
    })

    toolCtx.metadata({ title })

    const rawMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID)

    await ensureSessionInitialized(
        ctx.client,
        state,
        toolCtx.sessionID,
        ctx.logger,
        rawMessages,
        ctx.config.manualMode.enabled,
    )

    assignMessageRefs(state, rawMessages, ctx.logger)

    deduplicate(state, ctx.logger, ctx.config, rawMessages)
    purgeErrors(state, ctx.logger, ctx.config, rawMessages)

    return {
        state,
        rawMessages,
        searchContext: buildSearchContext(state, rawMessages),
    }
}

export async function finalizeSession(
    ctx: ToolContext,
    state: SessionState,
    toolCtx: RunContext,
    rawMessages: WithParts[],
    entries: NotificationEntry[],
    batchTopic: string | undefined,
): Promise<void> {
    state.manualMode = state.manualMode ? "active" : false
    applyPendingCompressionDurations(state)
    await saveSessionState(state, ctx.logger, undefined, registryOf(ctx))

    const params = getCurrentParams(state, rawMessages, ctx.logger)
    const sessionMessageIds = rawMessages
        .filter((msg) => !isIgnoredUserMessage(msg))
        .map((msg) => msg.info.id)

    await sendCompressNotification(
        ctx.client,
        ctx.logger,
        ctx.config,
        state,
        toolCtx.sessionID,
        entries,
        batchTopic,
        sessionMessageIds,
        params,
    )
}

function registryOf(ctx: ToolContext) {
    return isSessionRegistry(ctx.source) ? ctx.source : undefined
}
