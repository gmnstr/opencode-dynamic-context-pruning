// Must come first: sets XDG_DATA_HOME/XDG_CONFIG_HOME before lib/state/persistence.ts
// captures them at import time. See tests/helpers/dcp-test-env.ts for why the order matters.
import "./helpers/dcp-test-env"

import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { buildSearchContext, resolveBoundaryIds } from "../lib/compress/search"
import { buildCompressedBlockGuidance } from "../lib/prompts/extensions/nudge"
import { handleManualTriggerCommand } from "../lib/commands/manual"
import { collectResolvableBlockIds } from "../lib/messages/query"
import {
    createSessionState,
    type CompressionBlock,
    type SessionState,
    type WithParts,
} from "../lib/state"

const SESSION_ID = "ses_block_ref_live"
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

/**
 * The refs `buildBoundaryLookup` would actually resolve for this array, computed by
 * driving the real resolver - the ground truth the guidance has to agree with.
 */
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

function resolverAcceptedBlockIds(state: SessionState, rawMessages: WithParts[]): number[] {
    return resolverAcceptedRefs(state, rawMessages).map((ref) => Number(ref.slice(1)))
}

/** Populate the persisted cache the way the loader does after a state reload. */
function seedStaleCache(state: SessionState, blockIds: number[]): void {
    state.prune.messages.resolvableBlockIds.clear()
    for (const blockId of blockIds) {
        state.prune.messages.resolvableBlockIds.add(blockId)
    }
}

// (a) The gap itself. This path never calls `syncCompressionBlocks`; the cache was
// carried over from an earlier transform (or a reload) against a *different* array. The
// block's anchor is not in the array the resolver will fetch, so `b1` must not appear.
test("guidance given rawMessages does not advertise a block whose anchor is absent from that array", () => {
    const messages = [
        userMessage("msg-user-1", 1, { text: "Investigate the issue" }),
        assistantMessage("msg-assistant-1", 2),
        compressToolMessage(COMPRESS_MESSAGE_ID, 3),
    ]
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, buildBlock(1, "msg-anchor-not-in-session"))
    seedStaleCache(state, [1])

    const guidance = buildCompressedBlockGuidance(state, messages)
    const advertised = advertisedRefs(guidance)

    assert.deepEqual(resolverAcceptedRefs(state, messages), [], "resolver must reject b1")
    assert.deepEqual(advertised, [], "stale b1 must not be advertised")
    assert.doesNotMatch(guidance, /b1/)
})

// (b) The live-derivation must not over-correct: a resolvable block is still advertised
// even though no sync ran for this array.
test("guidance given rawMessages advertises an active block whose anchor is present and not ignored", () => {
    const messages = [
        userMessage("msg-user-1", 1),
        assistantMessage("msg-assistant-1", 2),
        compressToolMessage(COMPRESS_MESSAGE_ID, 3),
    ]
    const state = createSessionState()
    state.prune.messages.blocksById.set(2, buildBlock(2, "msg-assistant-1"))
    // Deliberately empty cache: the advertisement must come from the array, not the set.
    seedStaleCache(state, [])

    const advertised = advertisedRefs(buildCompressedBlockGuidance(state, messages))

    assert.deepEqual(advertised, ["b2"])
    assert.deepEqual(advertised, resolverAcceptedRefs(state, messages))
})

// (c) Ignored-user anchors are not resolvable, so they are not advertised.
test("guidance given rawMessages does not advertise a block anchored on an ignored user message", () => {
    const messages = [
        userMessage("msg-user-1", 1, { text: "visible" }),
        userMessage("msg-user-ignored", 2, { text: "ignored", ignored: true }),
        userMessage("msg-user-empty", 3, { emptyParts: true }),
        compressToolMessage(COMPRESS_MESSAGE_ID, 4),
    ]
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, buildBlock(1, "msg-user-ignored"))
    state.prune.messages.blocksById.set(2, buildBlock(2, "msg-user-empty"))
    seedStaleCache(state, [1, 2])

    const advertised = advertisedRefs(buildCompressedBlockGuidance(state, messages))

    assert.deepEqual(resolverAcceptedRefs(state, messages), [])
    assert.deepEqual(advertised, [])
})

// (d) An inactive block is not resolvable regardless of its anchor.
test("guidance given rawMessages does not advertise an inactive block", () => {
    const messages = [
        userMessage("msg-user-1", 1),
        assistantMessage("msg-assistant-1", 2),
        compressToolMessage(COMPRESS_MESSAGE_ID, 3),
    ]
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, buildBlock(1, "msg-assistant-1", { active: false }))
    seedStaleCache(state, [1])

    const advertised = advertisedRefs(buildCompressedBlockGuidance(state, messages))

    assert.deepEqual(resolverAcceptedRefs(state, messages), [])
    assert.deepEqual(advertised, [])
})

// (e) No array supplied -> cached fallback, exactly as before.
test("guidance without rawMessages still falls back to resolvableBlockIds", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, buildBlock(1, "msg-anchor-not-in-session"))
    seedStaleCache(state, [1])

    assert.deepEqual(advertisedRefs(buildCompressedBlockGuidance(state)), ["b1"])

    // ...and with no blocks at all the cached set is still the only source.
    const empty = createSessionState()
    empty.prune.messages.resolvableBlockIds.add(3)
    assert.deepEqual(advertisedRefs(buildCompressedBlockGuidance(empty)), ["b3"])
})

// (f) The real command path. `/dcp compress` loads state and fetches fresh session
// messages without ever calling `syncCompressionBlocks`, so a persisted cache naming a
// block whose anchor is gone used to be advertised verbatim.
test("the manual compress trigger advertises exactly what the resolver accepts", async () => {
    const messages = [
        userMessage("msg-user-1", 1),
        assistantMessage("msg-assistant-1", 2),
        compressToolMessage(COMPRESS_MESSAGE_ID, 3),
    ]
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, buildBlock(1, "msg-anchor-not-in-session"))
    state.prune.messages.blocksById.set(2, buildBlock(2, "msg-assistant-1"))
    seedStaleCache(state, [1, 2])

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
    const advertised = advertisedRefs(prompt)
    assert.deepEqual(resolverAcceptedRefs(state, messages), ["b2"])
    assert.deepEqual(advertised, ["b2"])
    assert.doesNotMatch(prompt, /b1/)
})

// (g) The shared helper is the single source of truth: it must agree with the real
// resolver across active/inactive, present/absent anchor, ignored-user anchor and a
// present block state, on one mixed array.
test("the shared resolvable-block helper agrees with buildBoundaryLookup", () => {
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
    state.prune.messages.blocksById.set(
        6,
        buildBlock(6, "msg-user-1", { createdAt: 6, active: false }),
    )
    state.prune.messages.blocksById.set(
        7,
        buildBlock(7, "msg-assistant-1", { createdAt: 7, consumedBlockIds: [9] }),
    )

    const fromHelper = [
        ...collectResolvableBlockIds(state.prune.messages.blocksById, messages),
    ].sort((a, b) => a - b)
    const fromResolver = resolverAcceptedBlockIds(state, messages)

    assert.deepEqual(fromHelper, fromResolver)
    assert.deepEqual(fromResolver, [1, 2, 7])
    // The rendered guidance must name exactly those blocks.
    assert.deepEqual(advertisedRefs(buildCompressedBlockGuidance(state, messages)), [
        "b1",
        "b2",
        "b7",
    ])
})
