import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import {
    assignMessageRefs,
    MESSAGE_REF_ALIAS_EXHAUSTION_LOG,
    MESSAGE_REF_MAX_INDEX,
} from "../lib/message-ids"
import { buildSearchContext, resolveBoundaryIds } from "../lib/compress/search"
import { checkSession, createSessionState, type WithParts } from "../lib/state"

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function buildCompactedMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-assistant-summary",
                role: "assistant",
                sessionID,
                agent: "assistant",
                summary: true,
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-assistant-summary",
                    sessionID,
                    "msg-assistant-summary-part",
                    "Compaction summary",
                ),
            ],
        },
        {
            info: {
                id: "msg-user-follow-up",
                role: "user",
                sessionID,
                agent: "assistant",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-follow-up",
                    sessionID,
                    "msg-user-follow-up-part",
                    "Continue after compaction",
                ),
            ],
        },
    ]
}

test("checkSession keeps message id aliases across native compaction", async () => {
    const sessionID = `ses_message_ids_after_compaction_${Date.now()}`
    const messages = buildCompactedMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)

    state.sessionId = sessionID
    // The session was initialized by an earlier request, so `ensureSessionInitialized`
    // returns immediately and leaves these refs in place: this is the second request of
    // a live session, arriving after a native compaction.
    state.initialized = true
    // `msg-user-follow-up` is in the post-compaction payload, so it has to keep the
    // alias the model already knows. `old-message-0998` was replaced by the
    // compaction summary: its alias is unreachable now but stays burned, so the
    // summary has to be given one the model has never seen.
    state.messageIds.byRawId.set("old-message-0998", "m0998")
    state.messageIds.byRawId.set("msg-user-follow-up", "m0999")
    state.messageIds.byRef.set("m0998", "old-message-0998")
    state.messageIds.byRef.set("m0999", "msg-user-follow-up")
    state.messageIds.nextRef = 1000

    await checkSession({} as any, state, logger, messages, false)

    assert.equal(state.lastCompaction, 2)
    assert.equal(state.messageIds.byRawId.get("msg-user-follow-up"), "m0999")
    assert.equal(state.messageIds.byRef.get("m0999"), "msg-user-follow-up")
    assert.equal(state.messageIds.nextRef, 1000)

    const assigned = assignMessageRefs(state, messages)

    assert.equal(assigned, 1)
    assert.equal(state.messageIds.byRawId.get("msg-user-follow-up"), "m0999")
    assert.equal(state.messageIds.byRawId.get("msg-assistant-summary"), "m1000")
    assert.equal(state.messageIds.byRef.has("m0998"), false)
    assert.equal(state.messageIds.nextRef, 1001)
})

function assistantMessage(sessionID: string, id: string, created: number): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created },
        } as WithParts["info"],
        parts: [textPart(id, sessionID, `${id}-part`, id)],
    }
}

test("assignMessageRefs degrades gracefully when alias capacity is exhausted", () => {
    const sessionID = `ses_message_ids_exhausted_${Date.now()}`
    const state = createSessionState()
    // One alias was handed out before the space ran out and it is still in the
    // payload, so reconciliation keeps it.
    state.messageIds.byRawId.set("msg-issued", "m0001")
    state.messageIds.byRef.set("m0001", "msg-issued")
    state.messageIds.nextRef = MESSAGE_REF_MAX_INDEX + 1

    const logged: Array<{ message: string; data?: Record<string, unknown> }> = []
    const logger = {
        error: (message: string, data?: Record<string, unknown>) => {
            logged.push({ message, data })
            return Promise.resolve()
        },
    } as unknown as Logger

    const messages = [
        assistantMessage(sessionID, "msg-issued", 1),
        assistantMessage(sessionID, "msg-a", 2),
        assistantMessage(sessionID, "msg-b", 3),
    ]

    // Pre-fix this threw `Message ID alias capacity exceeded`, which aborted the whole
    // chat transform through the fail-open guard in lib/hooks.ts (no prune, no
    // deduplication, no nudges, output.messages unmodified).
    const assigned = assignMessageRefs(state, messages, logger)

    assert.equal(assigned, 0)
    assert.equal(state.messageIds.byRawId.get("msg-a"), undefined)
    assert.equal(state.messageIds.byRawId.get("msg-b"), undefined)
    assert.equal(state.messageIds.byRef.has("m0002"), false)
    assert.equal(state.messageIds.nextRef, MESSAGE_REF_MAX_INDEX + 1)

    // The alias issued before exhaustion is untouched: the model keeps what it saw.
    assert.equal(state.messageIds.byRawId.get("msg-issued"), "m0001")
    assert.equal(state.messageIds.byRef.get("m0001"), "msg-issued")

    // Logged once for the payload, under a marker an operator can grep for.
    assert.equal(logged.length, 1)
    assert.equal(logged[0]?.message, MESSAGE_REF_ALIAS_EXHAUSTION_LOG)
    assert.equal(logged[0]?.data?.capacity, MESSAGE_REF_MAX_INDEX)
    assert.equal(logged[0]?.data?.issuedRefs, 1)
    assert.equal(logged[0]?.data?.firstRefusedMessageId, "msg-a")
})

test("aliases issued before exhaustion still resolve through the boundary lookup", () => {
    const sessionID = `ses_message_ids_exhausted_resolve_${Date.now()}`
    const state = createSessionState()
    state.messageIds.nextRef = MESSAGE_REF_MAX_INDEX

    const logger = { error: () => Promise.resolve() } as unknown as Logger
    const messages = [
        assistantMessage(sessionID, "msg-last-alias", 1),
        assistantMessage(sessionID, "msg-refused", 2),
    ]

    const assigned = assignMessageRefs(state, messages, logger)

    assert.equal(assigned, 1)
    assert.equal(state.messageIds.byRawId.get("msg-last-alias"), "m9999")
    assert.equal(state.messageIds.byRawId.has("msg-refused"), false)

    // Observation path: the alias the model was already shown still resolves through
    // the same lookup the compress tool builds.
    const context = buildSearchContext(state, messages)
    const { startReference } = resolveBoundaryIds(context, state, "m9999", "m9999")
    assert.equal(startReference.messageId, "msg-last-alias")

    // And a later payload cannot take the burned alias away from it either.
    assert.equal(assignMessageRefs(state, messages, logger), 0)
    assert.equal(state.messageIds.byRawId.get("msg-last-alias"), "m9999")
})
