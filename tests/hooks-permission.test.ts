import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import {
    createChatMessageHandler,
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
    createTextCompleteHandler,
} from "../lib/hooks"
import { Logger } from "../lib/logger"
import { createSessionState, type WithParts } from "../lib/state"

function buildConfig(permission: "allow" | "ask" | "deny" = "allow"): PluginConfig {
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
            permission,
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

function buildMessage(id: string, role: "user" | "assistant", text: string): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "session-1",
            agent: "assistant",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID: "session-1",
                type: "text",
                text,
            },
        ],
    }
}

test("chat message transform leaves messages untouched when compress is denied", async () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig("deny")
    const handler = createChatMessageTransformHandler(
        { session: { get: async () => ({}) } } as any,
        state,
        logger,
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
    )
    const output = {
        messages: [buildMessage("assistant-1", "assistant", "alpha <dcp>beta</dcp> omega")],
    }

    await handler({}, output)

    assert.equal(output.messages[0]?.parts[0]?.type, "text")
    assert.equal((output.messages[0]?.parts[0] as any).text, "alpha <dcp>beta</dcp> omega")
})

test("command execute exits after effective permission resolves to deny", async () => {
    let sessionMessagesCalls = 0
    const output = { parts: [] as any[] }
    const handler = createCommandExecuteHandler(
        {
            session: {
                messages: async () => {
                    sessionMessagesCalls += 1
                    return { data: [] }
                },
            },
        } as any,
        createSessionState(),
        new Logger(false),
        buildConfig("deny"),
        "/tmp",
        { global: undefined, agents: {} },
    )

    await handler({ command: "dcp", sessionID: "session-1", arguments: "context" }, output)

    assert.equal(sessionMessagesCalls, 1)
    assert.deepEqual(output.parts, [])
})

test("chat message hook caches variant even when effective permission is denied", async () => {
    const state = createSessionState()
    const handler = createChatMessageHandler(state, new Logger(false), buildConfig("allow"), {
        global: { "*": "deny" },
        agents: {},
    })

    await handler({ sessionID: "session-1", variant: "danger", agent: "assistant" }, {})

    assert.equal(state.variant, "danger")
})

test("text complete leaves output untouched when compress is denied", async () => {
    const output = { text: "alpha <dcp>beta</dcp> omega" }
    const handler = createTextCompleteHandler(createSessionState(), buildConfig("deny"))

    await handler({ sessionID: "session-1", messageID: "message-1", partID: "part-1" }, output)

    assert.equal(output.text, "alpha <dcp>beta</dcp> omega")
})
