// Must come first: sets XDG_DATA_HOME/XDG_CONFIG_HOME before lib/state/persistence.ts
// captures them at import time. See tests/helpers/dcp-test-env.ts for why the order matters.
import "./helpers/dcp-test-env"

import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import test from "node:test"
import { Logger } from "../lib/logger"
import { assignMessageRefs } from "../lib/message-ids"
import {
    createSessionState,
    ensureSessionInitialized,
    saveSessionState,
    type SessionState,
    type WithParts,
} from "../lib/state"
import { getSessionFilePath } from "../lib/state/persistence"
import { resetOnCompaction } from "../lib/state/utils"

const QUIET = new Logger(false)
const SESSION_ID = "ses-message-id-persistence"

function textPart(messageID: string, text: string) {
    return {
        id: `${messageID}-part`,
        messageID,
        sessionID: SESSION_ID,
        type: "text" as const,
        text,
    }
}

function userMessage(id: string, created: number): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: SESSION_ID,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created },
        } as WithParts["info"],
        parts: [textPart(id, `user text ${id}`)] as WithParts["parts"],
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

/** A host that fails every call. `ensureSessionInitialized` only needs it to fail open. */
const OFFLINE_CLIENT = {
    session: {
        get: async () => {
            throw new Error("no host in tests")
        },
    },
} as any

/** The disk shape `loadSessionState` accepts, with `messageIds` spliced in. */
function sessionDocument(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        prune: {
            tools: {},
            messages: {
                byMessageId: {},
                blocksById: {},
                activeBlockIds: [],
                activeByAnchorMessageId: {},
                nextBlockId: 1,
                nextRunId: 1,
            },
        },
        nudges: { contextLimitAnchors: [] },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        lastUpdated: new Date().toISOString(),
        ...extra,
    }
}

function writeSessionFile(sessionId: string, document: Record<string, unknown>): void {
    const filePath = getSessionFilePath(sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(document, null, 2), "utf-8")
}

/** The real load path: reset, read the file, restore. */
async function loadIntoFreshState(sessionId: string, messages: WithParts[]): Promise<SessionState> {
    const state = createSessionState()
    await ensureSessionInitialized(OFFLINE_CLIENT, state, sessionId, QUIET, messages, false)
    return state
}

test("(a) message refs and nextRef survive a save/load round-trip", async () => {
    const sessionId = `${SESSION_ID}-round-trip`
    const state = createSessionState()
    state.sessionId = sessionId
    state.messageIds.byRawId.set("msg-issued", "m0004")
    state.messageIds.byRef.set("m0004", "msg-issued")
    state.messageIds.nextRef = 5

    await saveSessionState(state, QUIET)

    const document = JSON.parse(readFileSync(getSessionFilePath(sessionId), "utf-8"))
    assert.deepEqual(
        document.messageIds,
        { byRawId: { "msg-issued": "m0004" }, byRef: { m0004: "msg-issued" }, nextRef: 5 },
        "messageIds must be part of the serialised session document",
    )

    const reloaded = await loadIntoFreshState(sessionId, [userMessage("msg-1", 1)])
    assert.equal(reloaded.messageIds.byRawId.get("msg-issued"), "m0004")
    assert.equal(reloaded.messageIds.byRef.get("m0004"), "msg-issued")
    assert.equal(reloaded.messageIds.nextRef, 5)
})

test("(b) resetOnCompaction keeps nextRef monotonic so a burned ref is never reissued", () => {
    const state = createSessionState()
    assignMessageRefs(state, [userMessage("msg-before-1", 1), assistantMessage("msg-before-2", 2)])

    const issued = [...state.messageIds.byRawId.values()]
    assert.deepEqual(issued, ["m0001", "m0002"])
    const nextRefBefore = state.messageIds.nextRef
    assert.equal(nextRefBefore, 3)

    resetOnCompaction(state)

    assert.equal(state.messageIds.nextRef, nextRefBefore)
    assert.equal(state.messageIds.byRawId.get("msg-before-1"), "m0001")
    assert.equal(state.messageIds.byRef.get("m0001"), "msg-before-1")

    // Native compaction replaces the conversation. The refs of the replaced
    // messages are gone from the payload, but they were already shown to the
    // model, so nothing may hand them out again.
    assignMessageRefs(state, [assistantMessage("msg-summary", 3), userMessage("msg-after", 4)])

    const reissued = [...state.messageIds.byRawId.values()].sort()
    assert.deepEqual(reissued, ["m0003", "m0004"])
    for (const ref of reissued) {
        assert.equal(issued.includes(ref), false, `${ref} was already handed to the model`)
    }
})

test("(c) a legacy file with no messageIds loads with the empty default", async () => {
    const sessionId = `${SESSION_ID}-legacy`
    writeSessionFile(sessionId, sessionDocument())

    const state = await loadIntoFreshState(sessionId, [userMessage("msg-1", 1)])

    assert.equal(state.messageIds.byRawId.size, 0)
    assert.equal(state.messageIds.byRef.size, 0)
    assert.equal(state.messageIds.nextRef, 1)
})

test("(d) malformed persisted messageIds degrades without throwing", async () => {
    const malformed: Array<[string, unknown]> = [
        ["string", "junk"],
        ["number", 42],
        ["array", []],
        ["null", null],
        ["wrong-map-types", { byRawId: "nope", byRef: null, nextRef: -3 }],
        ["wrong-next-ref", { byRawId: {}, byRef: {}, nextRef: "5" }],
        ["float-next-ref", { byRawId: {}, byRef: {}, nextRef: 1.5 }],
    ]

    for (const [label, messageIds] of malformed) {
        const sessionId = `${SESSION_ID}-malformed-${label}`
        writeSessionFile(sessionId, sessionDocument({ messageIds }))

        const state = await loadIntoFreshState(sessionId, [userMessage("msg-1", 1)])

        assert.equal(state.messageIds.byRawId.size, 0, `${label}: byRawId`)
        assert.equal(state.messageIds.byRef.size, 0, `${label}: byRef`)
        assert.equal(state.messageIds.nextRef, 1, `${label}: nextRef`)
    }

    // Partially malformed: well-formed entries survive, junk entries are dropped.
    const sessionId = `${SESSION_ID}-malformed-partial`
    writeSessionFile(
        sessionId,
        sessionDocument({
            messageIds: {
                byRawId: { "msg-live": "m0004", "junk-value": 7, "": "m0008" },
                byRef: { m0004: "msg-live", m0009: 12 },
                nextRef: "5",
            },
        }),
    )

    const state = await loadIntoFreshState(sessionId, [userMessage("msg-live", 1)])

    assert.equal(state.messageIds.byRawId.get("msg-live"), "m0004")
    assert.equal(state.messageIds.byRef.get("m0004"), "msg-live")
    assert.equal(state.messageIds.byRawId.has("junk-value"), false)
    assert.equal(state.messageIds.byRawId.has(""), false)
    assert.equal(state.messageIds.byRef.has("m0009"), false)
    assert.equal(state.messageIds.nextRef, 1)
})

test("(e) reconciliation drops dead refs, keeps live ones, and never lowers nextRef", () => {
    const state = createSessionState()
    state.messageIds.byRawId.set("msg-live", "m0005")
    state.messageIds.byRawId.set("msg-dead", "m0004")
    state.messageIds.byRef.set("m0005", "msg-live")
    state.messageIds.byRef.set("m0004", "msg-dead")
    state.messageIds.nextRef = 6

    const assigned = assignMessageRefs(state, [userMessage("msg-live", 1)])

    assert.equal(assigned, 0)
    assert.deepEqual([...state.messageIds.byRawId], [["msg-live", "m0005"]])
    assert.deepEqual([...state.messageIds.byRef], [["m0005", "msg-live"]])
    assert.equal(state.messageIds.byRawId.has("msg-dead"), false)
    assert.equal(state.messageIds.byRef.has("m0004"), false)
    assert.equal(state.messageIds.nextRef, 6)
})

test("(f) two compaction cycles keep nextRef monotonic and never reissue a burned ref", () => {
    const state = createSessionState()

    const cycle = (index: number) => {
        const messages = [
            userMessage(`msg-user-${index}`, index * 10),
            assistantMessage(`msg-assistant-${index}`, index * 10 + 1),
        ]
        assignMessageRefs(state, messages)
        return [...state.messageIds.byRef.keys()].sort()
    }

    assert.deepEqual(cycle(0), ["m0001", "m0002"])
    assert.equal(state.messageIds.nextRef, 3)

    resetOnCompaction(state)
    assert.equal(state.messageIds.nextRef, 3)
    assert.deepEqual(cycle(1), ["m0003", "m0004"])
    assert.equal(state.messageIds.nextRef, 5)

    resetOnCompaction(state)
    assert.equal(state.messageIds.nextRef, 5)
    assert.deepEqual(cycle(2), ["m0005", "m0006"])
    assert.equal(state.messageIds.nextRef, 7)
})

test("(k) reconciliation raises nextRef above every ref it drops", () => {
    // A persisted nextRef that is inconsistent with the refs it accompanies (see the
    // "wrong-next-ref" case in (d)): m0004 was issued while nextRef says 1. Issuing
    // from 1 walks up to the occupied m0004 and skips it - so the occupancy of the
    // map is the only thing keeping m0004 out of circulation. Once the raw message
    // leaves the payload and reconciliation drops that entry, the ref would be
    // reachable again unless nextRef is raised past it here.
    const state = createSessionState()
    state.messageIds.byRawId.set("msg-old", "m0004")
    state.messageIds.byRef.set("m0004", "msg-old")
    state.messageIds.nextRef = 1

    assignMessageRefs(state, [assistantMessage("msg-new", 5)])

    assert.equal(state.messageIds.byRef.has("m0004"), false)
    // Not m0001: the floor carried nextRef past the ref reconciliation dropped.
    assert.equal(state.messageIds.byRawId.get("msg-new"), "m0005")
    assert.equal(state.messageIds.nextRef, 6)

    // ...and the dropped ref stays out of reach on the next call too.
    assignMessageRefs(state, [assistantMessage("msg-new-2", 6)])
    assert.equal(state.messageIds.byRawId.get("msg-new-2"), "m0006")
})

test("(l) a session reloaded from disk does not reissue refs after compaction", async () => {
    // The production path of this defect: the plugin holds a fresh state object for a
    // session it has seen before (a restart, or the reset at the top of
    // ensureSessionInitialized), the conversation was compacted meanwhile, and the
    // aliases the model is holding come back from disk.
    const sessionId = `${SESSION_ID}-reloaded`
    const phaseOne = [
        userMessage("msg-a", 1),
        assistantMessage("msg-b", 2),
        assistantMessage("msg-c", 3),
    ]

    const issued = createSessionState()
    issued.sessionId = sessionId
    assignMessageRefs(issued, phaseOne)
    const phaseOneRefs = [...issued.messageIds.byRef.keys()]
    assert.deepEqual(phaseOneRefs, ["m0001", "m0002", "m0003"])
    await saveSessionState(issued, QUIET)

    const phaseTwo = [assistantMessage("msg-summary", 4), assistantMessage("msg-c", 3)]
    const reloaded = await loadIntoFreshState(sessionId, phaseTwo)
    assignMessageRefs(reloaded, phaseTwo)

    // The survivor keeps the alias the model already has for it...
    assert.equal(reloaded.messageIds.byRawId.get("msg-c"), "m0003")

    // ...and the message compaction introduced gets an alias that has never been
    // handed out. Reissuing one of `phaseOneRefs` here is the defect.
    const summaryRef = reloaded.messageIds.byRawId.get("msg-summary")
    assert.equal(
        phaseOneRefs.includes(summaryRef as string),
        false,
        `${summaryRef} was already issued for a different message before compaction`,
    )
    assert.equal(summaryRef, "m0004")
    assert.equal(reloaded.messageIds.nextRef, 5)
})
