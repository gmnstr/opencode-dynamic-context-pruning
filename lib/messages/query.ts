import type { PluginConfig } from "../config"
import type { CompressionBlock, WithParts } from "../state"
import { isMessageWithInfo } from "./shape"

export const getLastUserMessage = (
    messages: WithParts[],
    startIndex?: number,
): WithParts | null => {
    const start = startIndex ?? messages.length - 1
    for (let i = start; i >= 0; i--) {
        const msg = messages[i]
        if (!isMessageWithInfo(msg)) {
            continue
        }
        if (msg.info.role === "user" && !isIgnoredUserMessage(msg)) {
            return msg
        }
    }
    return null
}

export const messageHasCompress = (message: WithParts): boolean => {
    if (!isMessageWithInfo(message)) {
        return false
    }

    if (message.info.role !== "assistant") {
        return false
    }

    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts.some(
        (part) =>
            part.type === "tool" && part.tool === "compress" && part.state?.status === "completed",
    )
}

export const isIgnoredUserMessage = (message: WithParts): boolean => {
    if (!isMessageWithInfo(message)) {
        return false
    }

    if (message.info.role !== "user") {
        return false
    }

    const parts = Array.isArray(message.parts) ? message.parts : []
    if (parts.length === 0) {
        return true
    }

    for (const part of parts) {
        if (!(part as any).ignored) {
            return false
        }
    }

    return true
}

export function isProtectedUserMessage(config: PluginConfig, message: WithParts): boolean {
    if (!isMessageWithInfo(message)) {
        return false
    }

    return (
        config.compress.mode === "message" &&
        config.compress.protectUserMessages &&
        message.info.role === "user" &&
        !isIgnoredUserMessage(message)
    )
}

/**
 * The block ids `buildBoundaryLookup` (lib/compress/search.ts) will actually resolve
 * against `rawMessages` right now: the block is active, its anchor message is present in
 * that array, and the anchor is not an ignored user message. This mirrors the resolver's
 * summary loop guard for guard. Its separate raw-index check is deliberately not copied:
 * every message that survives `filterMessages` (lib/messages/shape.ts) is indexed, so a
 * present anchor always has an index and the extra check can never reject a block this
 * helper accepts.
 *
 * Single source of truth for that predicate. It lives here rather than in
 * lib/compress/search.ts because the guidance renderers (lib/prompts/extensions/nudge.ts,
 * reachable from lib/state.ts via the commands/inject paths) must not import the
 * compress module: lib/state/state.ts already imports lib/compress/timing, so a
 * compress-side helper would close an import cycle. This module is the neutral home -
 * it owns `isIgnoredUserMessage`, the helper's only dependency, and is already imported
 * by the resolver, by both guidance renderers, and by tests, with no new coupling.
 *
 * Pure: it derives from the array it is handed and never reads `resolvableBlockIds`.
 * When the array passed in is the pruned payload the anchor is already gone, so callers
 * on that path deliberately keep using the cache instead - see `syncCompressionBlocks`
 * (lib/messages/sync.ts) for why the pre-prune capture still exists.
 */
export const collectResolvableBlockIds = (
    blocksById: Map<number, CompressionBlock>,
    rawMessages: WithParts[],
): Set<number> => {
    const rawMessagesById = new Map<string, WithParts>()
    for (const message of rawMessages) {
        rawMessagesById.set(message.info.id, message)
    }

    const resolvable = new Set<number>()
    for (const block of blocksById.values()) {
        if (!block.active) {
            continue
        }
        const anchorMessage = rawMessagesById.get(block.anchorMessageId)
        if (!anchorMessage) {
            continue
        }
        if (isIgnoredUserMessage(anchorMessage)) {
            continue
        }
        resolvable.add(block.blockId)
    }

    return resolvable
}
