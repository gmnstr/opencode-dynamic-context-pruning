import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import { isIgnoredUserMessage } from "./query"

function sortBlocksByCreation(
    a: { createdAt: number; blockId: number },
    b: { createdAt: number; blockId: number },
): number {
    const createdAtDiff = a.createdAt - b.createdAt
    if (createdAtDiff !== 0) {
        return createdAtDiff
    }
    return a.blockId - b.blockId
}

export const syncCompressionBlocks = (
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): void => {
    const messagesState = state.prune.messages
    if (!messagesState?.blocksById?.size) {
        // Cleared before the early return, not after it: with no block left there is
        // nothing a `bN` can resolve to, and the stale set would keep advertising a ref
        // the resolver rejects - the over-advertisement this sync exists to close. The
        // set is state, not a value derived on read, so "no blocks" has to be written
        // into it rather than merely skipped.
        messagesState?.resolvableBlockIds.clear()
        return
    }

    const messageIds = new Set(messages.map((msg) => msg.info.id))
    const messagesById = new Map(messages.map((msg) => [msg.info.id, msg] as const))
    const previousActiveBlockIds = new Set<number>(
        Array.from(messagesState.blocksById.values())
            .filter((block) => block.active)
            .map((block) => block.blockId),
    )

    messagesState.activeBlockIds.clear()
    messagesState.resolvableBlockIds.clear()
    messagesState.activeByAnchorMessageId.clear()

    const now = Date.now()
    const orderedBlocks = Array.from(messagesState.blocksById.values()).sort(sortBlocksByCreation)

    for (const block of orderedBlocks) {
        // NOTE: compressMessageId presence check removed intentionally.
        // OpenCode compacts old assistant messages including the compress tool-call
        // message, which would cause the block's origin message to disappear from
        // the current message list. Deactivating the block on that basis causes
        // silent summary loss — compressed context silently uncompresses.
        // The persisted byMessageId index is the authoritative source of truth.
        // See PR #523 Bug #3 / Issue #537.

        if (block.deactivatedByUser) {
            block.active = false
            if (block.deactivatedAt === undefined) {
                block.deactivatedAt = now
            }
            block.deactivatedByBlockId = undefined
            continue
        }

        for (const consumedBlockId of block.consumedBlockIds) {
            if (!messagesState.activeBlockIds.has(consumedBlockId)) {
                continue
            }

            const consumedBlock = messagesState.blocksById.get(consumedBlockId)
            if (consumedBlock) {
                consumedBlock.active = false
                consumedBlock.deactivatedAt = now
                consumedBlock.deactivatedByBlockId = block.blockId

                const mappedBlockId = messagesState.activeByAnchorMessageId.get(
                    consumedBlock.anchorMessageId,
                )
                if (mappedBlockId === consumedBlock.blockId) {
                    messagesState.activeByAnchorMessageId.delete(consumedBlock.anchorMessageId)
                }
            }

            messagesState.activeBlockIds.delete(consumedBlockId)
            messagesState.resolvableBlockIds.delete(consumedBlockId)
        }

        block.active = true
        block.deactivatedAt = undefined
        block.deactivatedByBlockId = undefined
        messagesState.activeBlockIds.add(block.blockId)
        if (messageIds.has(block.anchorMessageId)) {
            messagesState.activeByAnchorMessageId.set(block.anchorMessageId, block.blockId)

            // Captures resolvability for the transform payload: a `bN` ref only resolves
            // while the anchor message is present in the raw array the resolver will look at
            // and is not an ignored user message. This has to be recorded here because the
            // transform is the last point at which the raw anchor is visible - prune rewrites
            // the payload immediately afterwards, dropping that anchor, so a guidance
            // renderer reading the post-prune array could no longer see it.
            //
            // This set is the *fallback* source for buildCompressedBlockGuidance, not the
            // only one. Read paths that hold an array the resolver will itself use pass it in
            // (`/dcp compress` in lib/commands/manual.ts, whose fresh `client.session.messages`
            // fetch never reaches this sync), and the guidance then derives the list live from
            // that array with the same predicate - `collectResolvableBlockIds`
            // (lib/messages/query.ts), shared with buildBoundaryLookup and
            // `describeValidRefs`. Callers with no array to hand over still read this set.
            // The tool-time resolver re-fetches client.session.messages, so cross-path
            // agreement is a property of the array each path describes, not of this cache.
            const anchorMessage = messagesById.get(block.anchorMessageId)
            if (anchorMessage && !isIgnoredUserMessage(anchorMessage)) {
                messagesState.resolvableBlockIds.add(block.blockId)
            }
        }
    }

    for (const entry of messagesState.byMessageId.values()) {
        const allBlockIds = Array.isArray(entry.allBlockIds)
            ? [...new Set(entry.allBlockIds.filter((id) => Number.isInteger(id) && id > 0))]
            : []

        entry.allBlockIds = allBlockIds
        entry.activeBlockIds = allBlockIds.filter((id) => messagesState.activeBlockIds.has(id))
    }

    const nextActiveBlockIds = messagesState.activeBlockIds
    let deactivatedCount = 0
    let reactivatedCount = 0

    for (const blockId of previousActiveBlockIds) {
        if (!nextActiveBlockIds.has(blockId)) {
            deactivatedCount++
        }
    }
    for (const blockId of nextActiveBlockIds) {
        if (!previousActiveBlockIds.has(blockId)) {
            reactivatedCount++
        }
    }

    if (deactivatedCount > 0 || reactivatedCount > 0) {
        logger.info("Synced compress block state", {
            deactivatedCount,
            reactivatedCount,
        })
    }
}
