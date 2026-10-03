import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import { assignMessageRefs, MESSAGE_REF_MAX_INDEX, formatMessageRef } from "../lib/message-ids"
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

test("assignMessageRefs throws when alias capacity is exhausted", () => {
    const sessionID = `ses_message_ids_exhausted_${Date.now()}`
    const state = createSessionState()
    state.messageIds.nextRef = MESSAGE_REF_MAX_INDEX + 1

    const messages: WithParts[] = [
        {
            info: {
                id: "msg-a",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-a", sessionID, "msg-a-part", "A")],
        },
        {
            info: {
                id: "msg-b",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("msg-b", sessionID, "msg-b-part", "B")],
        },
    ]

    assert.throws(
        () => assignMessageRefs(state, messages),
        new RegExp(
            `Message ID alias capacity exceeded. Cannot allocate more than ${formatMessageRef(MESSAGE_REF_MAX_INDEX)} aliases in this session.`,
        ),
    )
    assert.equal(state.messageIds.byRawId.size, 0)
    assert.equal(state.messageIds.byRef.size, 0)
    assert.equal(state.messageIds.byRawId.get("msg-a"), undefined)
    assert.equal(state.messageIds.byRawId.get("msg-b"), undefined)
})
