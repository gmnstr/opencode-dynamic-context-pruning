// Must come first: sets XDG_DATA_HOME/XDG_CONFIG_HOME before lib/state/persistence.ts
// captures them at import time. See tests/helpers/dcp-test-env.ts for why the order matters.
import "./helpers/dcp-test-env"

import assert from "node:assert/strict"
import test from "node:test"
import { formatIssues, resolveMessages } from "../lib/compress/message-utils"
import { buildSearchContext, resolveBoundaryIds } from "../lib/compress/search"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { assignMessageRefs, formatMessageRef } from "../lib/message-ids"
import { syncCompressionBlocks } from "../lib/messages/sync"
import {
    createSessionState,
    type CompressionBlock,
    type SessionState,
    type WithParts,
} from "../lib/state"

const QUIET = new Logger(false)
const SESSION_ID = "ses-not-in-context"
const COMPRESS_MESSAGE_ID = "msg-compress-tool"
const STALE_REF = "m0088"

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
            mode: "message",
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

function userMessage(id: string, created: number, ignored = false): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: SESSION_ID,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created },
        } as WithParts["info"],
        parts: [textPart(id, `user text ${id}`, ignored)] as WithParts["parts"],
    }
}

function assistantMessage(id: string, created: number): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: SESSION_ID,
            agent: "assistant",
            time: { created },
        } as WithParts["info"],
        parts: [textPart(id, `assistant text ${id}`)] as WithParts["parts"],
    }
}

function compressToolMessage(id: string, created: number): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: SESSION_ID,
            agent: "assistant",
            time: { created },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID: SESSION_ID,
                type: "tool",
                tool: "compress",
                callID: `${id}-call`,
                state: { status: "completed", input: { topic: "test" }, output: "compressed" },
            },
        ] as unknown as WithParts["parts"],
    }
}

function buildBlock(blockId: number, anchorMessageId: string): CompressionBlock {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 10,
        durationMs: 1,
        mode: "message",
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
        summary: `summary ${blockId}`,
    }
}

/** What the model actually reads: `lib/compress/message.ts` throws `formatIssues(...)`. */
function rejectionFor(state: SessionState, messages: WithParts[]) {
    const searchContext = buildSearchContext(state, messages)
    const result = resolveMessages(
        { topic: "topic", content: [{ messageId: STALE_REF, topic: "topic", summary: "summary" }] },
        searchContext,
        state,
        buildConfig(),
    )

    assert.equal(result.plans.length, 0, "a stale ref must not resolve")
    assert.equal(result.skippedCount, 1)
    assert.equal(result.skippedIssues.length, 1)
    assert.match(result.skippedIssues[0], /not available in the current conversation context/)

    return {
        issue: result.skippedIssues[0],
        formatted: formatIssues(result.skippedIssues, result.skippedCount),
    }
}

function refList(text: string): string {
    const match = text.match(/Valid refs right now: (.+)$/)
    assert.ok(match, `rejection names no valid refs:\n${text}`)
    return match[1]
}

test("(g) the rejection names the valid message-ref range and the valid block refs", () => {
    const messages = [
        userMessage("msg-user-1", 1),
        assistantMessage("msg-assistant-1", 2),
        compressToolMessage(COMPRESS_MESSAGE_ID, 3),
    ]
    const state = createSessionState()
    assignMessageRefs(state, messages)
    state.prune.messages.blocksById.set(1, buildBlock(1, "msg-assistant-1"))
    syncCompressionBlocks(state, QUIET, messages)

    const { issue, formatted } = rejectionFor(state, messages)

    assert.deepEqual([...state.messageIds.byRef.keys()], ["m0001", "m0002", "m0003"])
    assert.deepEqual([...state.prune.messages.resolvableBlockIds], [1])
    assert.equal(refList(issue), "m0001-m0003, b1.")
    assert.equal(refList(formatted), "m0001-m0003, b1.")
})

test("(h) an active block whose anchor is absent is not offered as valid", () => {
    const messages = [
        userMessage("msg-user-1", 1),
        assistantMessage("msg-assistant-1", 2),
        compressToolMessage(COMPRESS_MESSAGE_ID, 3),
    ]
    const state = createSessionState()
    assignMessageRefs(state, messages)
    state.prune.messages.blocksById.set(1, buildBlock(1, "msg-assistant-1"))
    state.prune.messages.blocksById.set(2, buildBlock(2, "msg-anchor-not-in-session"))
    state.prune.messages.blocksById.set(3, buildBlock(3, "msg-user-1"))
    syncCompressionBlocks(state, QUIET, messages)

    const { issue } = rejectionFor(state, messages)

    assert.equal(state.prune.messages.blocksById.get(2)?.active, true)
    assert.deepEqual([...state.prune.messages.resolvableBlockIds], [1, 3])
    assert.equal(refList(issue), "m0001-m0003, b1, b3.")
    assert.doesNotMatch(issue, /b2/)
})

test("(i) an ignored user message is never offered as a valid ref", () => {
    const messages = [
        userMessage("msg-user-1", 1),
        userMessage("msg-user-ignored", 2, true),
        assistantMessage("msg-assistant-1", 3),
        compressToolMessage(COMPRESS_MESSAGE_ID, 4),
    ]
    const state = createSessionState()
    assignMessageRefs(state, messages)
    state.prune.messages.blocksById.set(1, buildBlock(1, "msg-user-ignored"))
    state.prune.messages.blocksById.set(2, buildBlock(2, "msg-assistant-1"))
    syncCompressionBlocks(state, QUIET, messages)

    // A ref the map happens to carry for an ignored user message is not resolvable
    // either - `buildBoundaryLookup` filters those out for the same reason.
    state.messageIds.byRawId.set("msg-user-ignored", "m0050")
    state.messageIds.byRef.set("m0050", "msg-user-ignored")

    const { issue } = rejectionFor(state, messages)

    assert.deepEqual([...state.prune.messages.resolvableBlockIds], [2])
    assert.equal(refList(issue), "m0001-m0003, b2.")
    assert.doesNotMatch(issue, /m0050/)
    assert.doesNotMatch(issue, /b1/)
})

test("(j) the rejection stays bounded and says so plainly when nothing is valid", () => {
    // 400 refs that are not a contiguous run: one run per ref, which is the worst
    // case for a message that has to name them without dumping thousands of them.
    const state = createSessionState()
    const messages = [compressToolMessage(COMPRESS_MESSAGE_ID, 1)]
    for (let index = 0; index < 400; index++) {
        const rawMessageId = `msg-${index}`
        messages.push(assistantMessage(rawMessageId, index + 2))
        const ref = formatMessageRef(2 * index + 1)
        state.messageIds.byRawId.set(rawMessageId, ref)
        state.messageIds.byRef.set(ref, rawMessageId)
    }

    const fragmented = rejectionFor(state, messages)
    assert.equal(refList(fragmented.issue), "m0001, m0003, m0005, m0007, +396 more.")
    assert.ok(
        fragmented.issue.length < 512,
        `rejection must stay bounded, got ${fragmented.issue.length} characters`,
    )

    // Nothing valid at all: every ref points at a message that is gone.
    const emptyState = createSessionState()
    emptyState.messageIds.byRawId.set("msg-gone", "m0001")
    emptyState.messageIds.byRef.set("m0001", "msg-gone")

    const empty = rejectionFor(emptyState, [userMessage("msg-new", 1)])
    assert.match(empty.issue, /No refs are valid right now\.$/)
    assert.doesNotMatch(empty.issue, /Valid refs right now/)
    assert.ok(empty.issue.length < 512, `got ${empty.issue.length} characters`)
})

test("(k) block refs come from the payload, so they are right without a sync", () => {
    const messages = [
        userMessage("msg-user-1", 1),
        assistantMessage("msg-assistant-1", 2),
        compressToolMessage(COMPRESS_MESSAGE_ID, 3),
    ]
    const state = createSessionState()
    assignMessageRefs(state, messages)
    state.prune.messages.blocksById.set(1, buildBlock(1, "msg-assistant-1"))
    state.prune.messages.blocksById.set(2, buildBlock(2, "msg-anchor-not-in-session"))
    state.prune.messages.blocksById.set(3, buildBlock(3, "msg-user-1"))

    // No syncCompressionBlocks on purpose: the compress tool pipeline and `/dcp compress`
    // both render this text without one, so the cache is empty here.
    assert.equal(state.prune.messages.resolvableBlockIds.size, 0)

    const { issue } = rejectionFor(state, messages)

    const context = buildSearchContext(state, messages)
    const accepted: string[] = []
    for (const blockId of [...state.prune.messages.blocksById.keys()].sort((a, b) => a - b)) {
        try {
            resolveBoundaryIds(context, state, `b${blockId}`, `b${blockId}`)
        } catch {
            continue
        }
        accepted.push(`b${blockId}`)
    }

    // Advertised == resolvable, both derived from this payload: b2's anchor is gone.
    assert.deepEqual(accepted, ["b1", "b3"])
    assert.equal(refList(issue), "m0001-m0003, b1, b3.")
})
