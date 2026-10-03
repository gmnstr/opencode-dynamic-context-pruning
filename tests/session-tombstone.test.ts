// Must come first: sets XDG_DATA_HOME/XDG_CONFIG_HOME before lib/state/persistence.ts
// captures them at import time.
import "./helpers/dcp-test-env"

import assert from "node:assert/strict"
import { existsSync, readFileSync, rmSync } from "node:fs"
import test from "node:test"
import { createEventHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import {
    createSessionState,
    saveSessionState,
    type CompressionBlock,
    type SessionState,
} from "../lib/state"
import { getSessionFilePath } from "../lib/state/persistence"
import { resetOnCompaction } from "../lib/state/utils"
import {
    createSessionRegistry,
    resolveSessionState,
    type SessionRegistry,
} from "../lib/state/registry"

const QUIET = new Logger(false)

/** Resolve a session state object bound to its own session id. */
function sessionStateFor(registry: SessionRegistry, sessionId: string): SessionState {
    const state = registry.resolve(sessionId)
    state.sessionId = sessionId
    state.initialized = true
    return state
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

function toolEvent(
    sessionId: string,
    messageId: string,
    callId: string,
    state: Record<string, unknown>,
) {
    return {
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: callId,
                    messageID: messageId,
                    sessionID: sessionId,
                    state,
                },
            },
        },
    }
}

/**
 * `SessionRegistryImpl.evict` used to be a bare `entries.delete(sessionId)`, so an
 * in-flight operation holding the evicted state could re-enter
 * `saveSessionState` -> `registry.run` -> `resolve`, which minted a brand-new
 * entry and rewrote `{sessionId}.json` for a session the host had already
 * deleted. Eviction is now a tombstone: no new entry, no save.
 */
test("a save issued after evict does not recreate the deleted session's file", async () => {
    const registry = createSessionRegistry()
    const sessionId = "ses-tombstone-save"
    const state = sessionStateFor(registry, sessionId)
    state.prune.tools.set("read", 5)

    // The session is live: it owns a file.
    await saveSessionState(state, QUIET, undefined, registry)
    const filePath = getSessionFilePath(sessionId)
    assert.equal(existsSync(filePath), true)

    // session.deleted: the entry goes and the session's file is gone with it.
    rmSync(filePath)
    assert.equal(registry.evict(sessionId), true)

    // An in-flight operation that captured this state still holds it. A routed
    // save re-enters the registry; an unrouted save (lib/state/state.ts
    // checkSession, lib/messages/inject/inject.ts) never sees the registry at
    // all. Neither may bring the deleted session back.
    await saveSessionState(state, QUIET, undefined, registry)
    assert.equal(existsSync(filePath), false)

    await saveSessionState(state, QUIET)
    assert.equal(existsSync(filePath), false)
})

test("after evict, resolve mints no entry and a new operation gets no state", async () => {
    const registry = createSessionRegistry()
    const sessionId = "ses-tombstone-resolve"
    registry.resolve(sessionId)
    assert.equal(registry.size(), 1)

    assert.equal(registry.evict(sessionId), true)

    assert.equal(registry.size(), 0)
    assert.equal(registry.get(sessionId), null)

    // The layer every operation caller goes through: a deleted session behaves as
    // "no entry", so the caller mutates nothing (fail open).
    assert.equal(resolveSessionState(registry, sessionId), null)

    // A queued operation for the deleted session must not register an entry
    // either (this is the path that used to mint the second queue slot).
    assert.equal(await registry.run(sessionId, () => "ran"), "ran")
    assert.equal(registry.size(), 0)
    assert.equal(registry.get(sessionId), null)

    // Raw resolve still hands back a usable object for direct callers, but it is
    // never registered and never persisted.
    const resurrected = registry.resolve(sessionId)
    assert.equal(resurrected.sessionId, null)
    assert.equal(registry.size(), 0)
    assert.equal(registry.get(sessionId), null)
})

test("a completed-duration event after session.deleted mutates no block and mints no entry", async () => {
    const registry = createSessionRegistry()
    const sessionId = "ses-tombstone-event"
    const state = sessionStateFor(registry, sessionId)
    const handler = createEventHandler(registry, QUIET)
    const originalNow = Date.now
    Date.now = () => 100

    try {
        await handler(
            toolEvent(sessionId, "message-1", "call-remote", {
                status: "pending",
                input: {},
                raw: "",
            }),
        )
    } finally {
        Date.now = originalNow
    }
    assert.equal(state.compressionTiming.startsByCallId.size, 1)

    // Cross-cutting case. The session compacts first, which drops the timing
    // entries that described the pre-compaction conversation (checkSession calls
    // this from lib/state/state.ts) ...
    resetOnCompaction(state)

    // ... and a block materialises for the post-compaction state, reusing the ids
    // of the call that was already in flight.
    state.prune.messages.blocksById.set(2, buildBlock(2, "message-1", "call-remote"))

    // ... and then the session is deleted.
    await handler({
        event: { type: "session.deleted", properties: { info: { id: sessionId } } },
    })
    const sizeAfterDelete = registry.size()
    assert.equal(sizeAfterDelete, 0)

    // The tool call completes after both.
    await handler(
        toolEvent(sessionId, "message-1", "call-remote", {
            status: "completed",
            input: {},
            output: "done",
            title: "",
            metadata: {},
            time: { start: 1000, end: 1400 },
        }),
    )

    assert.equal(registry.size(), sizeAfterDelete)
    assert.equal(registry.get(sessionId), null)
    assert.equal(resolveSessionState(registry, sessionId), null)
    assert.equal(state.prune.messages.blocksById.get(2)?.durationMs, 0)
    assert.equal(state.compressionTiming.startsByCallId.size, 0)
    assert.equal(state.compressionTiming.pendingByCallId.size, 0)
})

test("the tombstone store stays bounded, so deletions cannot grow memory forever", async () => {
    // Imported inside the test on purpose: the bound is part of the contract, and
    // the module is loaded by every other test in this file too.
    const { MAX_SESSION_TOMBSTONES } = await import("../lib/state/registry")
    assert.equal(typeof MAX_SESSION_TOMBSTONES, "number")

    const registry = createSessionRegistry()
    const total = MAX_SESSION_TOMBSTONES + 8

    for (let index = 0; index < total; index++) {
        const sessionId = `ses-bounded-${index}`
        registry.resolve(sessionId)
        assert.equal(registry.evict(sessionId), true)
    }

    assert.equal(registry.size(), 0)
    const newest = `ses-bounded-${total - 1}`
    assert.equal(registry.get(newest), null)
    assert.equal(resolveSessionState(registry, newest), null)

    // Tombstones beyond the bound are forgotten (graceful degradation), so the
    // oldest ids can be resolved again instead of being poisoned forever.
    const oldest = "ses-bounded-0"
    const reResolved = resolveSessionState(registry, oldest)
    assert.notEqual(reResolved, null)
    assert.equal(registry.size(), 1)
})

test("CONTROL: a session that was never evicted still round-trips through disk", async () => {
    const registry = createSessionRegistry()
    const sessionId = "ses-tombstone-control"
    const state = sessionStateFor(registry, sessionId)
    state.prune.tools.set("read", 5)

    registry.resolve("ses-tombstone-control-other")
    assert.equal(registry.evict("ses-tombstone-control-other"), true)

    await saveSessionState(state, QUIET, undefined, registry)

    const filePath = getSessionFilePath(sessionId)
    assert.equal(existsSync(filePath), true)
    const written = JSON.parse(readFileSync(filePath, "utf-8"))
    assert.equal(written.prune.tools.read, 5)

    assert.equal(resolveSessionState(registry, sessionId), state)
})

test("evict reports whether a live entry was removed", () => {
    const registry = createSessionRegistry()
    const sessionId = "ses-tombstone-return"
    registry.resolve(sessionId)

    assert.equal(registry.evict(sessionId), true)
    assert.equal(registry.evict(sessionId), false)
    assert.equal(registry.evict("ses-tombstone-never-resolved"), false)

    // An unknown id deleted nothing, so it is not poisoned: a later request for
    // it still gets a live entry.
    assert.notEqual(resolveSessionState(registry, "ses-tombstone-never-resolved"), null)
    assert.equal(registry.size(), 1)
})
