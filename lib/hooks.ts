import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { assignMessageRefs } from "./message-ids"
import {
    buildPriorityMap,
    buildToolIdList,
    injectCompressNudges,
    injectExtendedSubAgentResults,
    injectMessageIds,
    prune,
    stripHallucinations,
    stripHallucinationsFromString,
    stripStaleMetadata,
    syncCompressionBlocks,
} from "./messages"
import { renderSystemPrompt, type PromptStore } from "./prompts"
import { buildProtectedToolsExtension } from "./prompts/extensions/system"
import { getLastUserMessage } from "./messages/query"
import {
    applyPendingCompressionDurations,
    buildCompressionTimingKey,
    consumeCompressionStart,
    resolveCompressionDuration,
} from "./compress/timing"
import { filterMessages, filterMessagesInPlace } from "./messages/shape"
import {
    applyPendingManualTrigger,
    handleContextCommand,
    handleDecompressCommand,
    handleHelpCommand,
    handleManualToggleCommand,
    handleManualTriggerCommand,
    handleRecompressCommand,
    handleStatsCommand,
    handleSweepCommand,
} from "./commands"
import { type HostPermissionSnapshot } from "./host-permissions"
import { compressPermission, syncCompressPermissionState } from "./compress-permission"
import { checkSession, ensureSessionInitialized, saveSessionState, syncToolCache } from "./state"
import { isSessionRegistry, resolveSessionState, type SessionSource } from "./state/registry"
import { cacheSystemPromptTokens } from "./ui/utils"

const INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "You are an anchored context summarization assistant for coding sessions",
    "Summarize what was done in this conversation",
]

function cloneMessages(messages: WithParts[]): WithParts[] {
    return structuredClone(messages)
}

function commitMessages(target: WithParts[], source: WithParts[]): void {
    target.splice(0, target.length, ...source)
}

/**
 * Session id carried by a messages payload: the last non-ignored user message,
 * then any shaped message (OpenCode always stamps `sessionID`).
 */
function resolvePayloadSessionId(messages: WithParts[]): string | null {
    const userMessage = getLastUserMessage(messages)
    if (userMessage?.info.sessionID) {
        return userMessage.info.sessionID
    }

    for (let i = messages.length - 1; i >= 0; i--) {
        const sessionID = (messages[i]?.info as { sessionID?: string } | undefined)?.sessionID
        if (sessionID) {
            return sessionID
        }
    }

    return null
}

/**
 * Hold an operation under the routing source's per-session serialization.
 * A plain state object has no queue (direct callers/tests) and runs inline.
 */
async function runWithSession(
    source: SessionSource,
    sessionId: string | null,
    operation: () => Promise<void>,
): Promise<void> {
    if (isSessionRegistry(source) && sessionId) {
        // The operation's own failures propagate to the caller's error handling,
        // which decides what is safe to expose.
        await source.run(sessionId, operation)
        return
    }
    await operation()
}

export function createSystemPromptHandler(
    source: SessionSource,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
) {
    return async (
        input: { sessionID?: string; model: { limit: { context: number } } },
        output: { system: string[] },
    ) => {
        // Resolve the session this callback belongs to. `input.sessionID` is
        // present on the main chat path but absent on others (e.g. language), and
        // an identity-less callback must not mutate any session's state.
        const sessionState = resolveSessionState(source, input.sessionID)

        if (sessionState && input.model?.limit?.context) {
            sessionState.modelContextLimit = input.model.limit.context
            logger.debug("Cached model context limit", { limit: sessionState.modelContextLimit })
        }

        if (sessionState?.isSubAgent && !config.experimental.allowSubAgents) {
            return
        }

        const systemText = output.system.join("\n")
        if (INTERNAL_AGENT_SIGNATURES.some((sig) => systemText.includes(sig))) {
            logger.info("Skipping DCP system prompt injection for internal agent")
            return
        }

        const effectivePermission =
            sessionState && input.sessionID === sessionState.sessionId
                ? compressPermission(sessionState, config)
                : config.compress.permission

        if (effectivePermission === "deny") {
            return
        }

        prompts.reload()
        const runtimePrompts = prompts.getRuntimePrompts()
        const newPrompt = renderSystemPrompt(
            runtimePrompts,
            buildProtectedToolsExtension(config.compress.protectedTools),
            !!sessionState?.manualMode,
            !!sessionState?.isSubAgent && config.experimental.allowSubAgents,
        )
        if (output.system.length > 0) {
            output.system[output.system.length - 1] += "\n\n" + newPrompt
        } else {
            output.system.push(newPrompt)
        }
    }
}

export function createChatMessageTransformHandler(
    client: any,
    source: SessionSource,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
    hostPermissions: HostPermissionSnapshot,
) {
    const transform = async (
        state: SessionState,
        output: { messages: WithParts[] },
        workingMessages: WithParts[],
        receivedMessages: number,
    ) => {
        const messages = filterMessagesInPlace(workingMessages)
        if (messages.length !== receivedMessages) {
            logger.warn("Skipping messages with unexpected shape during chat transform", {
                received: receivedMessages,
                usable: messages.length,
            })
        }

        await checkSession(client, state, logger, workingMessages, config.manualMode.enabled)

        syncCompressPermissionState(state, config, hostPermissions, workingMessages)

        if (state.isSubAgent && !config.experimental.allowSubAgents) {
            commitMessages(output.messages, workingMessages)
            return
        }

        stripHallucinations(workingMessages)
        cacheSystemPromptTokens(state, workingMessages)
        assignMessageRefs(state, workingMessages, logger)
        syncCompressionBlocks(state, logger, workingMessages)
        syncToolCache(state, config, logger, workingMessages)
        buildToolIdList(state, workingMessages)
        prune(state, logger, config, workingMessages)
        await injectExtendedSubAgentResults(
            client,
            state,
            logger,
            workingMessages,
            config.experimental.allowSubAgents,
        )
        const compressionPriorities = buildPriorityMap(config, state, workingMessages)
        prompts.reload()
        injectCompressNudges(
            state,
            config,
            logger,
            workingMessages,
            prompts.getRuntimePrompts(),
            compressionPriorities,
            isSessionRegistry(source) ? source : undefined,
        )
        injectMessageIds(state, config, workingMessages, compressionPriorities)
        applyPendingManualTrigger(state, workingMessages, logger)
        stripStaleMetadata(workingMessages)

        if (state.sessionId) {
            await logger.saveContext(state.sessionId, workingMessages)
        }

        commitMessages(output.messages, workingMessages)
    }

    return async (_input: {}, output: { messages: WithParts[] }) => {
        // Fail-open: catch transform failures so DCP bugs do not abort the session.
        try {
            if (!Array.isArray(output.messages)) {
                throw new Error("Chat transform output.messages is not an array")
            }

            const workingMessages = cloneMessages(output.messages)
            const receivedMessages = workingMessages.length
            const sessionId = resolvePayloadSessionId(workingMessages)

            // Fail open when the payload carries no identity: with a registry there
            // is no state object to safely attribute this request to.
            if (!sessionId && isSessionRegistry(source)) {
                return
            }

            const state = resolveSessionState(source, sessionId)
            if (!state) {
                return
            }

            // Every mutation for one session runs under that session's queue, so
            // concurrent requests for a session cannot interleave, while other
            // sessions stay independent.
            await runWithSession(source, sessionId, () =>
                transform(state, output, workingMessages, receivedMessages),
            )
        } catch (err) {
            logger.error("DCP chat transform failed; continuing without mutations", {
                error: err instanceof Error ? err.message : String(err),
            })
        }
    }
}

export function createCommandExecuteHandler(
    client: any,
    source: SessionSource,
    logger: Logger,
    config: PluginConfig,
    workingDirectory: string,
    hostPermissions: HostPermissionSnapshot,
) {
    return async (
        input: { command: string; sessionID: string; arguments: string },
        output: { parts: any[] },
    ) => {
        if (!config.commands.enabled) {
            return
        }

        if (input.command !== "dcp") {
            return
        }

        try {
            await runWithSession(source, input.sessionID, async () => {
                const state = resolveSessionState(source, input.sessionID)
                if (!state) {
                    return
                }

                const messagesResponse = await client.session.messages({
                    path: { id: input.sessionID },
                })
                const messages = filterMessages(messagesResponse.data || messagesResponse)

                await ensureSessionInitialized(
                    client,
                    state,
                    input.sessionID,
                    logger,
                    messages,
                    config.manualMode.enabled,
                )

                syncCompressPermissionState(state, config, hostPermissions, messages)

                const effectivePermission = compressPermission(state, config)
                if (effectivePermission === "deny") {
                    return
                }

                const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean)
                const subcommand = args[0]?.toLowerCase() || ""
                const subArgs = args.slice(1)

                const commandCtx = {
                    client,
                    state,
                    config,
                    logger,
                    sessionId: input.sessionID,
                    messages,
                    ...(isSessionRegistry(source) ? { registry: source } : {}),
                }

                if (subcommand === "context") {
                    await handleContextCommand(commandCtx)
                    throw new Error("__DCP_CONTEXT_HANDLED__")
                }

                if (subcommand === "stats") {
                    await handleStatsCommand(commandCtx)
                    throw new Error("__DCP_STATS_HANDLED__")
                }

                if (subcommand === "sweep") {
                    await handleSweepCommand({
                        ...commandCtx,
                        args: subArgs,
                        workingDirectory,
                    })
                    throw new Error("__DCP_SWEEP_HANDLED__")
                }

                if (subcommand === "manual") {
                    await handleManualToggleCommand(commandCtx, subArgs[0]?.toLowerCase())
                    throw new Error("__DCP_MANUAL_HANDLED__")
                }

                if (subcommand === "compress") {
                    const userFocus = subArgs.join(" ").trim()
                    const prompt = await handleManualTriggerCommand(
                        commandCtx,
                        "compress",
                        userFocus,
                    )
                    if (!prompt) {
                        throw new Error("__DCP_MANUAL_TRIGGER_BLOCKED__")
                    }

                    state.manualMode = "compress-pending"
                    state.pendingManualTrigger = {
                        sessionId: input.sessionID,
                        prompt,
                    }
                    const rawArgs = (input.arguments || "").trim()
                    output.parts.length = 0
                    output.parts.push({
                        type: "text",
                        text: rawArgs ? `/dcp ${rawArgs}` : `/dcp ${subcommand}`,
                    })
                    return
                }

                if (subcommand === "decompress") {
                    await handleDecompressCommand({
                        ...commandCtx,
                        args: subArgs,
                    })
                    throw new Error("__DCP_DECOMPRESS_HANDLED__")
                }

                if (subcommand === "recompress") {
                    await handleRecompressCommand({
                        ...commandCtx,
                        args: subArgs,
                    })
                    throw new Error("__DCP_RECOMPRESS_HANDLED__")
                }

                await handleHelpCommand(commandCtx)
                throw new Error("__DCP_HELP_HANDLED__")
            })
        } catch (err) {
            // Command handlers signal completion by throwing `__DCP_*` sentinels.
            if (err instanceof Error && err.message.startsWith("__DCP_")) {
                return
            }
            logger.error("DCP command failed", {
                error: err instanceof Error ? err.message : String(err),
            })
        }
    }
}

export function createTextCompleteHandler() {
    return async (
        _input: { sessionID: string; messageID: string; partID: string },
        output: { text: string },
    ) => {
        output.text = stripHallucinationsFromString(output.text)
    }
}

export function createEventHandler(source: SessionSource, logger: Logger) {
    return async (input: { event: any }) => {
        try {
            const event = input.event
            const sessionId =
                typeof event?.properties?.sessionID === "string"
                    ? event.properties.sessionID
                    : typeof event?.properties?.part?.sessionID === "string"
                      ? event.properties.part.sessionID
                      : null

            if (event?.type === "session.deleted") {
                const deletedSessionId =
                    event?.properties?.info?.id ??
                    event?.properties?.sessionID ??
                    event?.properties?.id
                if (typeof deletedSessionId === "string" && isSessionRegistry(source)) {
                    source.evict(deletedSessionId)
                    logger.debug("Evicted session state", { sessionId: deletedSessionId })
                }
                return
            }

            if (event?.type !== "message.part.updated") {
                return
            }

            const part = event.properties?.part
            if (part?.type !== "tool" || part.tool !== "compress") {
                return
            }

            const eventTime =
                typeof event.time === "number" && Number.isFinite(event.time)
                    ? event.time
                    : typeof event.properties?.time === "number" &&
                        Number.isFinite(event.properties.time)
                      ? event.properties.time
                      : undefined

            // Fail open on events without identity: with a registry there is no
            // state object that can be safely attributed to this event.
            const state = resolveSessionState(source, sessionId)
            if (!state) {
                return
            }

            if (part.state.status === "pending") {
                if (typeof part.callID !== "string" || typeof part.messageID !== "string") {
                    return
                }

                const startedAt = eventTime ?? Date.now()
                const key = buildCompressionTimingKey(part.messageID, part.callID)
                if (state.compressionTiming.startsByCallId.has(key)) {
                    return
                }
                state.compressionTiming.startsByCallId.set(key, startedAt)
                logger.debug("Recorded compression start", {
                    messageID: part.messageID,
                    callID: part.callID,
                    startedAt,
                })
                return
            }

            if (part.state.status === "completed") {
                if (typeof part.callID !== "string" || typeof part.messageID !== "string") {
                    return
                }

                const key = buildCompressionTimingKey(part.messageID, part.callID)
                const start = consumeCompressionStart(state, part.messageID, part.callID)
                const durationMs = resolveCompressionDuration(start, eventTime, part.state.time)
                if (typeof durationMs !== "number") {
                    return
                }

                // Mutating the block durations and saving them is one operation:
                // hold it under the session queue so it cannot interleave with a
                // concurrent transform or tool save for the same session.
                const operation = async () => {
                    state.compressionTiming.pendingByCallId.set(key, {
                        messageId: part.messageID,
                        callId: part.callID,
                        durationMs,
                    })

                    const updates = applyPendingCompressionDurations(state)
                    if (updates === 0) {
                        return 0
                    }

                    await saveSessionState(
                        state,
                        logger,
                        undefined,
                        isSessionRegistry(source) ? source : undefined,
                    )

                    logger.info("Attached compression time to blocks", {
                        messageID: part.messageID,
                        callID: part.callID,
                        blocks: updates,
                        durationMs,
                    })
                    return updates
                }

                if (isSessionRegistry(source) && sessionId) {
                    await source.run(sessionId, operation)
                } else {
                    await operation()
                }
                return
            }

            if (part.state.status === "running") {
                return
            }

            if (typeof part.callID === "string" && typeof part.messageID === "string") {
                state.compressionTiming.startsByCallId.delete(
                    buildCompressionTimingKey(part.messageID, part.callID),
                )
            }
        } catch (err) {
            logger.error("DCP event handling failed", {
                error: err instanceof Error ? err.message : String(err),
            })
        }
    }
}
