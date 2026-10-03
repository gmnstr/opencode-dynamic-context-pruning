// Must come first: sets XDG_DATA_HOME/XDG_CONFIG_HOME before lib/state/persistence.ts
// captures them at import time.
import "./helpers/dcp-test-env"

import assert from "node:assert/strict"
import test from "node:test"
import {
    applyPendingCompressionDurations,
    buildCompressionTimingKey,
    consumeCompressionStart,
} from "../lib/compress/timing"
import { createEventHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import {
    createSessionState,
    resetSessionState,
    type CompressionBlock,
    type SessionState,
} from "../lib/state"
import { resetOnCompaction } from "../lib/state/utils"

const QUIET = new Logger(false)

/**
 * `compressionTiming` is installed by `createSessionState` but was missing from
 * both reset paths, so a recorded start leaked across a session re-init and a
 * pending duration leaked across a compaction (where a fresh `prune.messages`
 * makes it unappliable forever - `applyPendingCompressionDurations` only deletes
 * an entry it actually applies, lib/compress/timing.ts:70-73).
 */
function seedTiming(state: SessionState, messageId = "message-1", callId = "call-1"): void {
    state.compressionTiming.startsByCallId.set(buildCompressionTimingKey(messageId, callId), 100)
    state.compressionTiming.pendingByCallId.set(buildCompressionTimingKey(messageId, callId), {
        messageId,
        callId,
        durationMs: 900,
    })
}

function buildBlock(
    blockId: number,
    compressMessageId: string,
    compressCallId: string,
): CompressionBlock {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: `block-${blockId}`,
        batchTopic: `block-${blockId}`,
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: `anchor-${blockId}`,
        compressMessageId,
        compressCallId,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [`anchor-${blockId}`],
        effectiveToolIds: [],
        createdAt: blockId,
        summary: `summary-${blockId}`,
    }
}

function pendingEvent(messageId: string, callId: string) {
    return {
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: callId,
                    messageID: messageId,
                    sessionID: "session-1",
                    state: { status: "pending", input: {}, raw: "" },
                },
            },
        },
    }
}

function completedEvent(messageId: string, callId: string, time: { start: number; end: number }) {
    return {
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: callId,
                    messageID: messageId,
                    sessionID: "session-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time,
                    },
                },
            },
        },
    }
}

test("resetSessionState drops recorded starts and keeps a queued pending duration", () => {
    const state = createSessionState()
    seedTiming(state)

    resetSessionState(state)

    // A start never survives a (re)initialization: it was recorded for the
    // conversation this state belonged to before the reset.
    assert.equal(state.compressionTiming.startsByCallId.size, 0)
    // A pending duration does survive it, on purpose: ensureSessionInitialized
    // resets the state and only then loads the session's blocks and applies what is
    // still pending (lib/state/state.ts), so this is the duration's route to its
    // block. See tests/hooks-permission.test.ts, "event hook queues duration
    // updates until the matching session is loaded".
    assert.equal(state.compressionTiming.pendingByCallId.size, 1)
})

test("resetOnCompaction clears recorded compression starts and pending durations", () => {
    const state = createSessionState()
    seedTiming(state)

    resetOnCompaction(state)

    assert.equal(state.compressionTiming.startsByCallId.size, 0)
    assert.equal(state.compressionTiming.pendingByCallId.size, 0)
})

test("a duration pending before compaction never reaches a post-compaction block", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, buildBlock(1, "message-1", "call-1"))
    seedTiming(state)

    resetOnCompaction(state)

    // A block that materialises after the compaction, matching the same ids by
    // coincidence: the pre-compaction duration is not evidence about it.
    state.prune.messages.blocksById.set(2, buildBlock(2, "message-1", "call-1"))

    const applied = applyPendingCompressionDurations(state)

    assert.equal(applied, 0)
    assert.equal(state.prune.messages.blocksById.get(2)?.durationMs, 0)
    assert.equal(state.compressionTiming.pendingByCallId.size, 0)
})

test("a compression start recorded before a reset is not consumable afterwards", () => {
    const state = createSessionState()
    state.compressionTiming.startsByCallId.set(
        buildCompressionTimingKey("message-1", "call-1"),
        100,
    )

    resetSessionState(state)

    assert.equal(consumeCompressionStart(state, "message-1", "call-1"), undefined)

    state.compressionTiming.startsByCallId.set(
        buildCompressionTimingKey("message-2", "call-2"),
        100,
    )

    resetOnCompaction(state)

    assert.equal(consumeCompressionStart(state, "message-2", "call-2"), undefined)
})

test("a completed event after a reset derives its duration from the event, not a stale start", async () => {
    const state = createSessionState()
    state.sessionId = "session-1"
    const handler = createEventHandler(state, QUIET)
    const originalNow = Date.now
    Date.now = () => 100

    try {
        await handler(pendingEvent("message-1", "call-1"))
        assert.equal(state.compressionTiming.startsByCallId.size, 1)
    } finally {
        Date.now = originalNow
    }

    // Compaction happened between the start and the completion of the same call.
    resetOnCompaction(state)

    await handler(completedEvent("message-1", "call-1", { start: 1000, end: 1400 }))

    const pending = state.compressionTiming.pendingByCallId.get(
        buildCompressionTimingKey("message-1", "call-1"),
    )
    // 1400 - 1000 (the tool's own runtime), not 1000 - 100 (the stale start).
    assert.equal(pending?.durationMs, 400)
})

test("both resets clear the timing maps in place so a holder observes the reset", () => {
    const state = createSessionState()
    const starts = state.compressionTiming.startsByCallId
    const pending = state.compressionTiming.pendingByCallId

    seedTiming(state)
    resetSessionState(state)

    // The maps are the same objects a holder captured before the reset, and the
    // holder sees the clear through them.
    assert.equal(state.compressionTiming.startsByCallId, starts)
    assert.equal(state.compressionTiming.pendingByCallId, pending)
    assert.equal(starts.size, 0)
    assert.equal(pending.size, 1)

    seedTiming(state)
    resetOnCompaction(state)

    assert.equal(state.compressionTiming.startsByCallId, starts)
    assert.equal(state.compressionTiming.pendingByCallId, pending)
    assert.equal(starts.size, 0)
    assert.equal(pending.size, 0)
})
