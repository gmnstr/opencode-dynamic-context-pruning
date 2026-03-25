import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { createTextCompleteHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import { assignMessageRefs } from "../lib/message-ids"
import { injectMessageIds } from "../lib/messages/inject/inject"
import { applyAnchoredNudges } from "../lib/messages/inject/utils"
import { prune } from "../lib/messages/prune"
import { buildPriorityMap } from "../lib/messages/priority"
import { stripHallucinationsFromString } from "../lib/messages/utils"
import { createSessionState, type WithParts } from "../lib/state"

function buildConfig(mode: "message" | "range" = "message"): PluginConfig {
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
            mode,
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
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

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function toolPart(
    messageID: string,
    sessionID: string,
    callID: string,
    toolName: string,
    output: string,
) {
    return {
        id: `${callID}-part`,
        messageID,
        sessionID,
        type: "tool" as const,
        tool: toolName,
        callID,
        state: {
            status: "completed" as const,
            input: { description: "demo" },
            output,
        },
    }
}

function buildMessage(
    id: string,
    role: "user" | "assistant",
    sessionID: string,
    text: string,
    created: number,
): WithParts {
    const info =
        role === "user"
            ? {
                  id,
                  role,
                  sessionID,
                  agent: "assistant",
                  model: {
                      providerID: "anthropic",
                      modelID: "claude-test",
                  },
                  time: { created },
              }
            : {
                  id,
                  role,
                  sessionID,
                  agent: "assistant",
                  time: { created },
              }

    return {
        info: info as WithParts["info"],
        parts: [textPart(id, sessionID, `${id}-part`, text)],
    }
}

function repeatedWord(word: string, count: number): string {
    return Array.from({ length: count }, () => word).join(" ")
}

test("injectMessageIds tags every text part and tool output in message mode", () => {
    const sessionID = "ses_message_priority_tags"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-1",
                    sessionID,
                    "msg-user-1-part-1",
                    repeatedWord("investigate", 6000),
                ),
                textPart("msg-user-1", sessionID, "msg-user-1-part-2", "Trailing note."),
            ],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-assistant-1",
                    sessionID,
                    "msg-assistant-1-part-1",
                    "Short follow-up note.",
                ),
                toolPart("msg-assistant-1", sessionID, "call-task-1", "task", "task output body"),
                textPart(
                    "msg-assistant-1",
                    sessionID,
                    "msg-assistant-1-part-2",
                    "Second text chunk.",
                ),
                toolPart(
                    "msg-assistant-1",
                    sessionID,
                    "call-task-2",
                    "bash",
                    "second tool output body",
                ),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig()

    assignMessageRefs(state, messages)
    const compressionPriorities = buildPriorityMap(config, state, messages)

    injectMessageIds(state, config, messages, compressionPriorities)

    assert.equal(messages[0]?.parts.length, 2)
    assert.equal(messages[1]?.parts.length, 4)

    const userTextOne = messages[0]?.parts[0]
    const userTextTwo = messages[0]?.parts[1]
    const assistantTextOne = messages[1]?.parts[0]
    const assistantToolOne = messages[1]?.parts[1]
    const assistantTextTwo = messages[1]?.parts[2]
    const assistantToolTwo = messages[1]?.parts[3]

    assert.equal(userTextOne?.type, "text")
    assert.equal(userTextTwo?.type, "text")
    assert.equal(assistantTextOne?.type, "text")
    assert.equal(assistantToolOne?.type, "tool")
    assert.equal(assistantTextTwo?.type, "text")
    assert.equal(assistantToolTwo?.type, "tool")
    assert.match(
        (userTextOne as any).text,
        /\n\n<dcp-message-id priority="high">m0001<\/dcp-message-id>/,
    )
    assert.match(
        (userTextTwo as any).text,
        /\n\n<dcp-message-id priority="high">m0001<\/dcp-message-id>/,
    )
    assert.match(
        (assistantTextOne as any).text,
        /\n\n<dcp-message-id priority="low">m0002<\/dcp-message-id>/,
    )
    assert.match(
        (assistantToolOne as any).state.output,
        /<dcp-message-id priority="low">m0002<\/dcp-message-id>/,
    )
    assert.match(
        (assistantTextTwo as any).text,
        /\n\n<dcp-message-id priority="low">m0002<\/dcp-message-id>/,
    )
    assert.match(
        (assistantToolTwo as any).state.output,
        /<dcp-message-id priority="low">m0002<\/dcp-message-id>/,
    )
})

test("injectMessageIds marks every protected user text part as BLOCKED in message mode", () => {
    const sessionID = "ses_message_blocked_user_tags"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-1",
                    sessionID,
                    "msg-user-1-part-1",
                    repeatedWord("investigate", 6000),
                ),
                textPart("msg-user-1", sessionID, "msg-user-1-part-2", "Trailing note."),
            ],
        },
        buildMessage("msg-assistant-1", "assistant", sessionID, "Short follow-up note.", 2),
    ]
    const state = createSessionState()
    const config = buildConfig()
    config.compress.protectUserMessages = true

    assignMessageRefs(state, messages)
    const compressionPriorities = buildPriorityMap(config, state, messages)

    injectMessageIds(state, config, messages, compressionPriorities)

    const userTextOne = messages[0]?.parts[0]
    const userTextTwo = messages[0]?.parts[1]
    const assistantText = messages[1]?.parts[0]

    assert.equal(userTextOne?.type, "text")
    assert.equal(userTextTwo?.type, "text")
    assert.equal(assistantText?.type, "text")
    assert.match((userTextOne as any).text, /\n\n<dcp-message-id>BLOCKED<\/dcp-message-id>/)
    assert.match((userTextTwo as any).text, /\n\n<dcp-message-id>BLOCKED<\/dcp-message-id>/)
    assert.doesNotMatch((userTextOne as any).text, /priority=/)
    assert.doesNotMatch((userTextTwo as any).text, /priority=/)
    assert.match(
        (assistantText as any).text,
        /\n\n<dcp-message-id priority="low">m0002<\/dcp-message-id>/,
    )
})

test("injectMessageIds tags every text part and tool output in range mode", () => {
    const sessionID = "ses_range_message_id_tags"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, repeatedWord("investigate", 6000), 1),
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "msg-assistant-1-part-1", "First chunk."),
                toolPart("msg-assistant-1", sessionID, "call-task-range-1", "task", "first output"),
                textPart("msg-assistant-1", sessionID, "msg-assistant-1-part-2", "Second chunk."),
                toolPart(
                    "msg-assistant-1",
                    sessionID,
                    "call-task-range-2",
                    "bash",
                    "second output",
                ),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    injectMessageIds(state, config, messages)

    const assistantTextOne = messages[1]?.parts[0]
    const assistantToolOne = messages[1]?.parts[1]
    const assistantTextTwo = messages[1]?.parts[2]
    const assistantToolTwo = messages[1]?.parts[3]

    assert.match((assistantTextOne as any).text, /\n\n<dcp-message-id>m0002<\/dcp-message-id>/)
    assert.match((assistantToolOne as any).state.output, /<dcp-message-id>m0002<\/dcp-message-id>/)
    assert.match((assistantTextTwo as any).text, /\n\n<dcp-message-id>m0002<\/dcp-message-id>/)
    assert.match((assistantToolTwo as any).state.output, /<dcp-message-id>m0002<\/dcp-message-id>/)
})

test("message mode marks compress tool messages as high priority even when short", () => {
    const sessionID = "ses_message_compress_high_priority"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Please compress this chunk.", 1),
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "msg-assistant-1-part-1", "Done."),
                toolPart(
                    "msg-assistant-1",
                    sessionID,
                    "call-compress-1",
                    "compress",
                    "[Compressed conversation section]",
                ),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig()

    assignMessageRefs(state, messages)
    const compressionPriorities = buildPriorityMap(config, state, messages)

    assert.equal(compressionPriorities.get("msg-assistant-1")?.priority, "high")

    injectMessageIds(state, config, messages, compressionPriorities)

    const assistantText = messages[1]?.parts[0]
    const assistantTool = messages[1]?.parts[1]

    assert.match(
        (assistantText as any).text,
        /\n\n<dcp-message-id priority="high">m0002<\/dcp-message-id>/,
    )
    assert.match(
        (assistantTool as any).state.output,
        /<dcp-message-id priority="high">m0002<\/dcp-message-id>/,
    )
})

test("message-mode nudges append to existing text parts and list only earlier visible high-priority message IDs", () => {
    const sessionID = "ses_message_priority_nudges"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, repeatedWord("alpha", 6000), 1),
        buildMessage("msg-assistant-1", "assistant", sessionID, repeatedWord("beta", 6000), 2),
        buildMessage("msg-user-2", "user", sessionID, repeatedWord("gamma", 6000), 3),
        buildMessage("msg-assistant-2", "assistant", sessionID, repeatedWord("delta", 6000), 4),
    ]
    const state = createSessionState()
    const config = buildConfig()

    assignMessageRefs(state, messages)
    state.prune.messages.byMessageId.set("msg-assistant-1", {
        tokenCount: 999,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    state.nudges.contextLimitAnchors.add("msg-user-2")

    const compressionPriorities = buildPriorityMap(config, state, messages)

    applyAnchoredNudges(
        state,
        config,
        messages,
        {
            system: "",
            compressRange: "",
            compressMessage: "",
            contextLimitNudge: "<dcp-system-reminder>Base context nudge</dcp-system-reminder>",
            turnNudge: "<dcp-system-reminder>Base turn nudge</dcp-system-reminder>",
            iterationNudge: "<dcp-system-reminder>Base iteration nudge</dcp-system-reminder>",
        },
        compressionPriorities,
    )

    assert.equal(messages[2]?.parts.length, 1)

    const injectedNudge = messages[2]?.parts[0]
    assert.equal(injectedNudge?.type, "text")
    assert.match((injectedNudge as any).text, /\n\n<dcp-system-reminder>Base context nudge/)
    assert.match((injectedNudge as any).text, /Message priority context:/)
    assert.match((injectedNudge as any).text, /High-priority message IDs before this point: m0001/)
    assert.doesNotMatch((injectedNudge as any).text, /m0002/)
    assert.doesNotMatch((injectedNudge as any).text, /m0003/)
    assert.doesNotMatch((injectedNudge as any).text, /m0004/)
})

test("message-mode nudges exclude protected user messages from priority guidance", () => {
    const sessionID = "ses_message_blocked_priority_nudges"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, repeatedWord("alpha", 6000), 1),
        buildMessage("msg-assistant-1", "assistant", sessionID, repeatedWord("beta", 6000), 2),
        buildMessage("msg-user-2", "user", sessionID, repeatedWord("gamma", 6000), 3),
    ]
    const state = createSessionState()
    const config = buildConfig()
    config.compress.protectUserMessages = true

    assignMessageRefs(state, messages)
    state.nudges.contextLimitAnchors.add("msg-user-2")

    const compressionPriorities = buildPriorityMap(config, state, messages)

    applyAnchoredNudges(
        state,
        config,
        messages,
        {
            system: "",
            compressRange: "",
            compressMessage: "",
            contextLimitNudge: "<dcp-system-reminder>Base context nudge</dcp-system-reminder>",
            turnNudge: "<dcp-system-reminder>Base turn nudge</dcp-system-reminder>",
            iterationNudge: "<dcp-system-reminder>Base iteration nudge</dcp-system-reminder>",
        },
        compressionPriorities,
    )

    const injectedNudge = messages[2]?.parts[0]
    assert.equal(injectedNudge?.type, "text")
    assert.match((injectedNudge as any).text, /High-priority message IDs before this point: m0002/)
    assert.doesNotMatch((injectedNudge as any).text, /m0001/)
})

test("range-mode nudges append to existing text parts before tool outputs", () => {
    const sessionID = "ses_range_nudge_injection"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, repeatedWord("alpha", 6000), 1),
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "msg-assistant-1-part", "Working summary."),
                toolPart("msg-assistant-1", sessionID, "call-task-2", "task", "task output body"),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    state.prune.messages.activeBlockIds.add(7)
    state.nudges.contextLimitAnchors.add("msg-assistant-1")

    applyAnchoredNudges(state, config, messages, {
        system: "",
        compressRange: "",
        compressMessage: "",
        contextLimitNudge: "<dcp-system-reminder>Base context nudge</dcp-system-reminder>",
        turnNudge: "<dcp-system-reminder>Base turn nudge</dcp-system-reminder>",
        iterationNudge: "<dcp-system-reminder>Base iteration nudge</dcp-system-reminder>",
    })

    assert.equal(messages[1]?.parts.length, 2)

    const injectedNudge = messages[1]?.parts[0]
    const toolOutput = messages[1]?.parts[1]
    assert.equal(injectedNudge?.type, "text")
    assert.equal(toolOutput?.type, "tool")
    assert.match((injectedNudge as any).text, /\n\n<dcp-system-reminder>Base context nudge/)
    assert.match((injectedNudge as any).text, /Compressed block context:/)
    assert.match((injectedNudge as any).text, /Active compressed blocks in this session: 1 \(b7\)/)
    assert.equal((toolOutput as any).state.output, "task output body")
})

test("message-mode rendered compressed summaries mark block IDs as BLOCKED", () => {
    const sessionID = "ses_message_blocked_blocks"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Original request", 1),
        buildMessage("msg-assistant-1", "assistant", sessionID, "Follow-up", 2),
    ]
    const state = createSessionState()
    const config = buildConfig("message")
    const logger = new Logger(false)

    state.prune.messages.byMessageId.set("msg-user-1", {
        tokenCount: 20,
        allBlockIds: [7],
        activeBlockIds: [7],
    })
    state.prune.messages.blocksById.set(7, {
        blockId: 7,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        mode: "range",
        topic: "Earlier notes",
        batchTopic: "Earlier notes",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-user-1",
        compressMessageId: "msg-origin",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["msg-user-1"],
        directToolIds: [],
        effectiveMessageIds: ["msg-user-1"],
        effectiveToolIds: [],
        createdAt: 1,
        summary:
            "[Compressed conversation section]\nEarlier summary\n\n<dcp-message-id>b7</dcp-message-id>",
    })
    state.prune.messages.activeBlockIds.add(7)
    state.prune.messages.activeByAnchorMessageId.set("msg-user-1", 7)

    prune(state, logger, config, messages)

    const summaryText = (messages[0]?.parts[0] as any)?.text || ""
    assert.match(summaryText, /<dcp-message-id>BLOCKED<\/dcp-message-id>/)
    assert.doesNotMatch(summaryText, /<dcp-message-id>b7<\/dcp-message-id>/)
})

test("range-mode rendered compressed summaries keep block IDs", () => {
    const sessionID = "ses_range_visible_blocks"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Original request", 1),
        buildMessage("msg-assistant-1", "assistant", sessionID, "Follow-up", 2),
    ]
    const state = createSessionState()
    const config = buildConfig("range")
    const logger = new Logger(false)

    state.prune.messages.byMessageId.set("msg-user-1", {
        tokenCount: 20,
        allBlockIds: [7],
        activeBlockIds: [7],
    })
    state.prune.messages.blocksById.set(7, {
        blockId: 7,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        mode: "range",
        topic: "Earlier notes",
        batchTopic: "Earlier notes",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-user-1",
        compressMessageId: "msg-origin",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["msg-user-1"],
        directToolIds: [],
        effectiveMessageIds: ["msg-user-1"],
        effectiveToolIds: [],
        createdAt: 1,
        summary:
            "[Compressed conversation section]\nEarlier summary\n\n<dcp-message-id>b7</dcp-message-id>",
    })
    state.prune.messages.activeBlockIds.add(7)
    state.prune.messages.activeByAnchorMessageId.set("msg-user-1", 7)

    prune(state, logger, config, messages)

    const summaryText = (messages[0]?.parts[0] as any)?.text || ""
    assert.match(summaryText, /<dcp-message-id>b7<\/dcp-message-id>/)
    assert.doesNotMatch(summaryText, /<dcp-message-id>BLOCKED<\/dcp-message-id>/)
})

test("hallucination stripping removes all dcp-prefixed XML tags including variants", async () => {
    const text =
        "alpha" +
        '<dcp-message-id priority="low">m0008</dcp-message-id>' +
        '<dcp-message-id-extra priority="high">m0008</dcp-message-id-extra>' +
        "<dcp-system-reminder>strip this</dcp-system-reminder>" +
        "<dcp-system-reminder-extra>strip this too</dcp-system-reminder-extra>" +
        "omega"

    assert.equal(stripHallucinationsFromString(text), "alphaomega")

    const handler = createTextCompleteHandler()
    const output = { text }
    await handler({ sessionID: "session", messageID: "message", partID: "part" }, output)
    assert.equal(output.text, "alphaomega")
})

test("hallucination stripping removes colon and underscore dcp tag variants", async () => {
    assert.equal(
        stripHallucinationsFromString("before<dcp:message_id>m0074</dcp:message_id>after"),
        "beforeafter",
    )
    assert.equal(
        stripHallucinationsFromString(
            'start<dcp-function_calls><invoke name="Bash"></invoke></dcp-function_calls>end',
        ),
        "startend",
    )
})
