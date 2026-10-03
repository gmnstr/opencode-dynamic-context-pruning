// Must come first: sets XDG_DATA_HOME/XDG_CONFIG_HOME before lib/state/persistence.ts
// captures them at import time. See tests/helpers/dcp-test-env.ts for why the order matters.
import "./helpers/dcp-test-env"

import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { buildSearchContext, resolveBoundaryIds } from "../lib/compress/search"
import { prune } from "../lib/messages/prune"
import { syncCompressionBlocks } from "../lib/messages/sync"
import { buildCompressedBlockGuidance } from "../lib/prompts/extensions/nudge"
import { handleManualTriggerCommand } from "../lib/commands/manual"
import {
    createSessionState,
    type CompressionBlock,
    type SessionState,
    type WithParts,
} from "../lib/state"
import {
    loadPruneMessagesState,
    resetOnCompaction,
    serializePruneMessagesState,
} from "../lib/state/utils"

const SESSION_ID = "ses_block_ref_parity"
const COMPRESS_MESSAGE_ID = "msg-compress-tool"

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: false,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

function textPart(messageID: string, text: string, ignored = false) {
    const part: Record<string, unknown> = {
        id: `${messageID}-part`,
        messageID,
        sessionID: SESSION_ID,
        type: "text",
        text,
    }
    if (ignored) {
        part.ignored = true
    }
    return part
}

function userMessage(
    id: string,
    created: number,
    options: { text?: string; ignored?: boolean; emptyParts?: boolean } = {},
): WithParts {
    const parts = options.emptyParts
        ? []
        : [textPart(id, options.text ?? `user text ${id}`, options.ignored === true)]

    return {
        info: {
            id,
            role: "user",
            sessionID: SESSION_ID,
            agent: "assistant",
            model: {
                providerID: "anthropic",
                modelID: "claude-test",
            },
            time: { created },
        } as WithParts["info"],
        parts: parts as WithParts["parts"],
    }
}

function assistantMessage(id: string, created: number, parts?: WithParts["parts"]): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: SESSION_ID,
            agent: "assistant",
            time: { created },
        } as WithParts["info"],
        parts: parts ?? ([textPart(id, `assistant text ${id}`)] as WithParts["parts"]),
    }
}

function compressToolMessage(id: string, created: number): WithParts {
    return assistantMessage(id, created, [
        {
            id: `${id}-part`,
            messageID: id,
            sessionID: SESSION_ID,
            type: "tool",
            tool: "compress",
            callID: `${id}-call`,
            state: {
                status: "completed",
                input: { topic: "test" },
                output: "compressed",
            },
        } as unknown as WithParts["parts"][number],
    ])
}

function buildBlock(
    blockId: number,
    anchorMessageId: string,
    overrides: Partial<CompressionBlock> = {},
): CompressionBlock {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 10,
        durationMs: 1,
        mode: "range",
        topic: `topic-${blockId}`,
        batchTopic: `topic-${blockId}`,
        startId: "m0001",
        endId: "m0001",
        anchorMessageId,
        compressMessageId: COMPRESS_MESSAGE_ID,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [anchorMessageId],
        directToolIds: [],
        effectiveMessageIds: [anchorMessageId],
        effectiveToolIds: [],
        createdAt: blockId,
        summary: `[Compressed conversation section]\nSummary ${blockId}\n\n<dcp-message-id>b${blockId}</dcp-message-id>`,
        ...overrides,
    }
}

function advertisedRefs(guidance: string): string[] {
    const match = guidance.match(/Active compressed blocks in this session: (\d+) \(([^)]*)\)/)
    assert.ok(match, `guidance has no compressed block list:\n${guidance}`)

    const list = (match[2] || "").trim()
    if (list === "none") {
        return []
    }
    return list.split(",").map((ref) => ref.trim())
}

function resolverAcceptedRefs(state: SessionState, rawMessages: WithParts[]): string[] {
    const context = buildSearchContext(state, rawMessages)
    const accepted: string[] = []

    for (const blockId of [...state.prune.messages.blocksById.keys()].sort((a, b) => a - b)) {
        try {
            resolveBoundaryIds(context, state, `b${blockId}`, `b${blockId}`)
        } catch {
            continue
        }
        accepted.push(`b${blockId}`)
    }

    return accepted
}

/**
 * The point of the whole change: every ref the nudge advertises must be a ref
 * `buildSearchContext` + the boundary lookup actually accepts, and vice versa.
 */
function assertGuidanceMatchesResolver(state: SessionState, rawMessages: WithParts[]): string[] {
    const advertised = advertisedRefs(buildCompressedBlockGuidance(state))
    const accepted = resolverAcceptedRefs(state, rawMessages)

    assert.deepEqual(
        advertised,
        accepted,
        `advertised refs (${advertised.join(", ") || "none"}) must match the refs the resolver accepts (${accepted.join(", ") || "none"})`,
    )

    return advertised
}

test("guidance does not advertise a block whose anchor message is absent from the live session", () => {
    const messages = [
        userMessage("msg-user-1", 1, { text: "Investigate the issue" }),
        assistantMessage("msg-assistant-1", 2),
        compressToolMessage(COMPRESS_MESSAGE_ID, 3),
    ]
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, buildBlock(1, "msg-anchor-not-in-session"))

    syncCompressionBlocks(state, new Logger(false), messages)

    const guidance = buildCompressedBlockGuidance(state)
    assert.deepEqual(advertisedRefs(guidance), [])
    assert.doesNotMatch(guidance, /b1/)
    assert.deepEqual(resolverAcceptedRefs(state, messages), [])
    assertGuidanceMatchesResolver(state, messages)
})

test("guidance keeps advertising a block whose anchor was replaced by a synthetic prune summary", () => {
    const logger = new Logger(false)
    const config = buildConfig()
    const rawSessionMessages = [
        userMessage("msg-user-1", 1, { text: "Original request" }),
        assistantMessage("msg-assistant-1", 2),
        userMessage("msg-user-2", 3, { text: "Please compress the investigation" }),
        compressToolMessage(COMPRESS_MESSAGE_ID, 4),
    ]
    const messages = structuredClone(rawSessionMessages)
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, buildBlock(1, "msg-assistant-1"))
    state.prune.messages.byMessageId.set("msg-assistant-1", {
        tokenCount: 20,
        allBlockIds: [1],
        activeBlockIds: [1],
    })

    syncCompressionBlocks(state, logger, messages)
    assert.deepEqual(advertisedRefs(buildCompressedBlockGuidance(state)), ["b1"])

    prune(state, logger, config, messages)

    // prune swapped the raw anchor for a synthetic summary in the outgoing payload...
    assert.equal(
        messages.some((msg) => msg.info.id === "msg-assistant-1"),
        false,
        "anchor message should be gone from the pruned payload",
    )
    assert.equal(
        messages.some((msg) => msg.info.id.startsWith("msg_dcp_summary_")),
        true,
        "prune should have injected a synthetic summary message",
    )

    // ...so a post-prune payload filter could no longer see the anchor...
    assert.throws(() => resolveBoundaryIds(buildSearchContext(state, messages), state, "b1", "b1"))

    // ...but the block must stay advertised: the resolver fetches fresh session messages.
    assert.deepEqual(advertisedRefs(buildCompressedBlockGuidance(state)), ["b1"])
    assertGuidanceMatchesResolver(state, rawSessionMessages)
})

test("guidance excludes a block consumed by a later block", () => {
    const messages = [
        userMessage("msg-user-1", 1),
        assistantMessage("msg-assistant-1", 2),
        userMessage("msg-user-2", 3),
        compressToolMessage(COMPRESS_MESSAGE_ID, 4),
    ]
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, buildBlock(1, "msg-user-1", { createdAt: 1 }))
    state.prune.messages.blocksById.set(
        2,
        buildBlock(2, "msg-assistant-1", { createdAt: 2, consumedBlockIds: [1] }),
    )

    syncCompressionBlocks(state, new Logger(false), messages)

    assert.equal(state.prune.messages.blocksById.get(1)?.active, false)
    assert.deepEqual(advertisedRefs(buildCompressedBlockGuidance(state)), ["b2"])
    assertGuidanceMatchesResolver(state, messages)
})

test("guidance does not advertise blocks anchored on ignored user messages", () => {
    const messages = [
        userMessage("msg-user-1", 1, { text: "visible" }),
        userMessage("msg-user-ignored", 2, { text: "ignored", ignored: true }),
        userMessage("msg-user-empty", 3, { emptyParts: true }),
        compressToolMessage(COMPRESS_MESSAGE_ID, 4),
    ]
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, buildBlock(1, "msg-user-ignored"))
    state.prune.messages.blocksById.set(2, buildBlock(2, "msg-user-empty"))

    syncCompressionBlocks(state, new Logger(false), messages)

    assert.deepEqual(advertisedRefs(buildCompressedBlockGuidance(state)), [])
    assert.deepEqual(resolverAcceptedRefs(state, messages), [])
    assertGuidanceMatchesResolver(state, messages)
})

test("guidance after a compaction reset and state reload stays consistent with the live blocks", () => {
    const messages = [
        userMessage("msg-user-1", 1),
        assistantMessage("msg-assistant-1", 2),
        compressToolMessage(COMPRESS_MESSAGE_ID, 3),
    ]
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, buildBlock(1, "msg-user-1"))
    state.prune.messages.blocksById.set(2, buildBlock(2, "msg-anchor-not-in-session"))

    syncCompressionBlocks(state, new Logger(false), messages)
    assert.deepEqual(advertisedRefs(buildCompressedBlockGuidance(state)), ["b1"])
    assertGuidanceMatchesResolver(state, messages)

    const persisted = serializePruneMessagesState(state.prune.messages)
    assert.deepEqual(
        [...persisted.activeBlockIds].sort((a, b) => a - b),
        [1, 2],
    )

    resetOnCompaction(state)
    assert.deepEqual(advertisedRefs(buildCompressedBlockGuidance(state)), [])

    state.prune.messages = loadPruneMessagesState(persisted)

    // Not stale: block 2's anchor is not in the live session, so it must not come back.
    assert.deepEqual(advertisedRefs(buildCompressedBlockGuidance(state)), ["b1"])
    assertGuidanceMatchesResolver(state, messages)
})

test("guidance tolerates malformed summary content and still matches the resolver", () => {
    const logger = new Logger(false)
    const config = buildConfig()
    const messages = [
        userMessage("msg-user-1", 1),
        assistantMessage("msg-assistant-1", 2),
        compressToolMessage(COMPRESS_MESSAGE_ID, 3),
    ]
    const state = createSessionState()
    state.prune.messages.blocksById.set(
        1,
        buildBlock(1, "msg-user-1", { summary: undefined as unknown as string }),
    )
    state.prune.messages.blocksById.set(
        2,
        buildBlock(2, "msg-anchor-not-in-session", { summary: 12345 as unknown as string }),
    )

    syncCompressionBlocks(state, logger, messages)

    let guidance = ""
    assert.doesNotThrow(() => {
        guidance = buildCompressedBlockGuidance(state)
    })
    assert.deepEqual(advertisedRefs(guidance), ["b1"])
    assertGuidanceMatchesResolver(state, messages)

    // prune.ts logs "Skipping malformed compress summary" and injects nothing; the
    // guidance builder must stay just as tolerant.
    assert.doesNotThrow(() => prune(state, logger, config, messages))
    assert.equal(
        messages.some((msg) => msg.info.id.startsWith("msg_dcp_summary_")),
        false,
    )
    assert.deepEqual(advertisedRefs(buildCompressedBlockGuidance(state)), ["b1"])
})

test("every advertised block ref resolves through the boundary lookup", () => {
    const messages = [
        userMessage("msg-user-1", 1),
        assistantMessage("msg-assistant-1", 2),
        userMessage("msg-user-ignored", 3, { text: "ignored", ignored: true }),
        userMessage("msg-user-empty", 4, { emptyParts: true }),
        compressToolMessage(COMPRESS_MESSAGE_ID, 5),
    ]
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, buildBlock(1, "msg-user-1", { createdAt: 1 }))
    state.prune.messages.blocksById.set(2, buildBlock(2, "msg-assistant-1", { createdAt: 2 }))
    state.prune.messages.blocksById.set(
        3,
        buildBlock(3, "msg-anchor-not-in-session", { createdAt: 3 }),
    )
    state.prune.messages.blocksById.set(4, buildBlock(4, "msg-user-ignored", { createdAt: 4 }))
    state.prune.messages.blocksById.set(5, buildBlock(5, "msg-user-empty", { createdAt: 5 }))
    state.prune.messages.blocksById.set(6, buildBlock(6, "msg-user-1", { createdAt: 6 }))
    state.prune.messages.blocksById.set(
        7,
        buildBlock(7, "msg-assistant-1", { createdAt: 7, consumedBlockIds: [6] }),
    )

    syncCompressionBlocks(state, new Logger(false), messages)

    const advertised = assertGuidanceMatchesResolver(state, messages)
    assert.deepEqual(advertised, ["b1", "b2", "b7"])
})

test("the manual compress trigger advertises only resolvable blocks", async () => {
    const messages = [
        userMessage("msg-user-1", 1),
        assistantMessage("msg-assistant-1", 2),
        compressToolMessage(COMPRESS_MESSAGE_ID, 3),
    ]
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, buildBlock(1, "msg-anchor-not-in-session"))
    state.prune.messages.blocksById.set(2, buildBlock(2, "msg-assistant-1"))

    syncCompressionBlocks(state, new Logger(false), messages)

    const prompt = await handleManualTriggerCommand(
        {
            client: {},
            state,
            config: buildConfig(),
            logger: new Logger(false),
            sessionId: SESSION_ID,
            messages,
        },
        "compress",
    )

    assert.ok(prompt, "manual trigger should build a prompt")
    assert.match(prompt, /Active compressed blocks in this session: 1 \(b2\)/)
    assert.doesNotMatch(prompt, /b1/)
})

test("a stale resolvable block id is cleared once no block is left to resolve", () => {
    const messages = [
        userMessage("msg-user-1", 1),
        assistantMessage("msg-assistant-1", 2),
        compressToolMessage(COMPRESS_MESSAGE_ID, 3),
    ]
    const state = createSessionState()
    // No blocks at all, but a persisted set that still names b3. The set is the only
    // source of the advertisement, so it must not survive the sync that discovers there
    // is nothing left to resolve.
    state.prune.messages.resolvableBlockIds.add(3)

    assert.deepEqual(advertisedRefs(buildCompressedBlockGuidance(state)), ["b3"])

    syncCompressionBlocks(state, new Logger(false), messages)

    assert.equal(state.prune.messages.resolvableBlockIds.size, 0)
    const guidance = buildCompressedBlockGuidance(state)
    assert.deepEqual(advertisedRefs(guidance), [])
    assert.doesNotMatch(guidance, /b3/)
    assert.deepEqual(resolverAcceptedRefs(state, messages), [])
    assertGuidanceMatchesResolver(state, messages)
})

test("a reloaded state drops resolvable block ids whose block did not come back", () => {
    const messages = [
        userMessage("msg-user-1", 1),
        assistantMessage("msg-assistant-1", 2),
        compressToolMessage(COMPRESS_MESSAGE_ID, 3),
    ]
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, buildBlock(1, "msg-assistant-1"))

    syncCompressionBlocks(state, new Logger(false), messages)
    assert.deepEqual([...state.prune.messages.resolvableBlockIds], [1])

    const persisted = serializePruneMessagesState(state.prune.messages)
    // b3 has no block in the document. Trusting the persisted set verbatim would
    // advertise a ref the resolver rejects for the whole life of the reloaded state.
    persisted.resolvableBlockIds = [1, 3]

    const reloaded = loadPruneMessagesState(persisted)

    assert.deepEqual([...reloaded.resolvableBlockIds], [1])
    assert.deepEqual([...reloaded.blocksById.keys()], [1])
})
