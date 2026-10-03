// Must come first: sets XDG_DATA_HOME/XDG_CONFIG_HOME before lib/state/persistence.ts
// captures them at import time. Without this the suite writes into the live DCP state dir.
import "./helpers/dcp-test-env"

import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { createSessionRegistry, type SessionRegistry } from "../lib/state/registry"
import {
    checkSession,
    createSessionState,
    saveSessionState,
    type SessionState,
    type WithParts,
} from "../lib/state"
import { createSystemPromptHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"

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

/** User message shaped the way OpenCode delivers it (non-ignored => has parts). */
function buildUserMessage(id: string, sessionID: string): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                sessionID,
                messageID: id,
                type: "text",
                text: "hello",
            } as any,
        ],
    }
}

function buildMessages(sessionID: string): WithParts[] {
    return [buildUserMessage(`${sessionID}-user-1`, sessionID)]
}

interface Deferred<T> {
    promise: Promise<T>
    resolve: (value: T) => void
}

function defer<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((res) => {
        resolve = res
    })
    return { promise, resolve }
}

/** `session.get` that returns `parentID` so `isSubAgentSession` resolves deterministically. */
function clientWithParent(
    parentID: string | null,
    gate?: Promise<unknown>,
): { session: { get: (input: any) => Promise<any> } } {
    return {
        session: {
            get: async () => {
                if (gate) {
                    await gate
                }
                return { data: { parentID } }
            },
        },
    }
}

const QUIET = new Logger(false)

test("interleaved initializations keep each session's own identity and subagent flag", async () => {
    const registry = createSessionRegistry()
    const sessionA = "ses-iso-a"
    const sessionB = "ses-iso-b"

    // A's identity lookup blocks: without per-session objects it would resume into
    // whichever session finished last.
    const gate = defer<void>()
    const clientA = clientWithParent("ses-parent", gate.promise)
    const clientB = clientWithParent(null)

    const stateA = registry.resolve(sessionA)

    const initA = checkSession(clientA as any, stateA, QUIET, buildMessages(sessionA), false)
    const initB = checkSession(
        clientB as any,
        registry.resolve(sessionB),
        QUIET,
        buildMessages(sessionB),
        false,
    )

    await initB
    gate.resolve()
    await initA

    const resolvedA = registry.get(sessionA)
    const resolvedB = registry.get(sessionB)

    assert.notEqual(resolvedA, resolvedB, "each session must own a distinct state object")
    assert.equal(resolvedA?.sessionId, sessionA)
    assert.equal(resolvedA?.isSubAgent, true, "A keeps its own subagent identity")
    assert.equal(resolvedB?.sessionId, sessionB)
    assert.equal(resolvedB?.isSubAgent, false, "B must not inherit A's subagent flag")

    // A's late write must not have retargeted B's state either.
    assert.equal(registry.get(sessionB)?.sessionId, sessionB)
})

test("different sessions initialize independently (no global serialization)", async () => {
    const registry = createSessionRegistry()
    const gate = defer<void>()
    const slowClient = clientWithParent(null, gate.promise)

    let aFinished = false
    const initA = checkSession(
        slowClient as any,
        registry.resolve("ses-slow"),
        QUIET,
        buildMessages("ses-slow"),
        false,
    ).then(() => {
        aFinished = true
    })

    let bFinished = false
    await checkSession(
        clientWithParent(null) as any,
        registry.resolve("ses-fast"),
        QUIET,
        buildMessages("ses-fast"),
        false,
    ).then(() => {
        bFinished = true
    })

    // B completed while A is still blocked: the queue is per session, not global.
    assert.equal(bFinished, true)
    assert.equal(aFinished, false)

    gate.resolve()
    await initA
    assert.equal(aFinished, true)
})

test("operations for one session serialize instead of interleaving", async () => {
    const registry = createSessionRegistry()
    const sessionId = "ses-serialized"
    registry.resolve(sessionId)

    const gate = defer<void>()
    const events: string[] = []
    let inFlight = 0
    let maxInFlight = 0

    const slow = registry.run(sessionId, async () => {
        events.push("slow:start")
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await gate.promise
        inFlight--
        events.push("slow:end")
    })

    const fast = registry.run(sessionId, async () => {
        events.push("fast:start")
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        inFlight--
        events.push("fast:end")
    })

    // Let the second operation reach the queue before releasing the first.
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(events, ["slow:start"])

    gate.resolve()
    await Promise.all([slow, fast])

    assert.deepEqual(events, ["slow:start", "slow:end", "fast:start", "fast:end"])
    assert.equal(maxInFlight, 1, "same-session operations must never overlap")
})

test("concurrent saves for one session serialize", async () => {
    const registry = createSessionRegistry()
    const sessionId = "ses-concurrent-saves"
    const state = registry.resolve(sessionId)
    state.sessionId = sessionId
    state.initialized = true

    // Hold the session queue so both save calls are pending at the same time.
    const gate = defer<void>()
    const holder = registry.run(sessionId, () => gate.promise)

    const order: string[] = []
    state.stats.totalPruneTokens = 1
    const first = saveSessionState(state, QUIET, undefined, registry).then(() => {
        order.push("first")
    })
    state.stats.totalPruneTokens = 2
    const second = saveSessionState(state, QUIET, undefined, registry).then(() => {
        order.push("second")
    })

    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(order, [], "saves wait for the session queue")

    gate.resolve()
    await holder
    await Promise.all([first, second])

    // Queueing makes the write order deterministic; interleaved saves could write
    // a stale snapshot last.
    assert.deepEqual(order, ["first", "second"])
})

test("fail-open: a payload without a user message mutates no registry entry", async () => {
    const registry = createSessionRegistry()
    const state = registry.resolve("ses-no-user")
    state.sessionId = "ses-no-user"
    state.initialized = true

    const before = {
        sessionId: state.sessionId,
        isSubAgent: state.isSubAgent,
        currentTurn: state.currentTurn,
    }

    await checkSession(
        clientWithParent("ses-parent") as any,
        state,
        QUIET,
        [
            {
                info: {
                    id: "msg-assistant-1",
                    role: "assistant",
                    sessionID: "ses-no-user",
                    agent: "assistant",
                    time: { created: 1 },
                } as WithParts["info"],
                parts: [],
            },
        ],
        false,
    )

    assert.equal(state.sessionId, before.sessionId)
    assert.equal(state.isSubAgent, before.isSubAgent)
    assert.equal(state.currentTurn, before.currentTurn)
})

test("fail-open: an empty message list mutates no registry entry", async () => {
    const registry = createSessionRegistry()
    const state = registry.resolve("ses-empty")
    state.sessionId = "ses-empty"
    state.initialized = true

    await checkSession(clientWithParent("ses-parent") as any, state, QUIET, [], false)

    assert.equal(state.sessionId, "ses-empty")
    assert.equal(state.isSubAgent, false)
})

test("fail-open: a payload whose session id does not match mutates nothing", async () => {
    const registry = createSessionRegistry()
    const state = registry.resolve("ses-owner")
    state.sessionId = "ses-owner"
    state.initialized = true
    state.isSubAgent = false

    // Same payload identity but a state object owned by another session: the guard
    // must refuse rather than attribute this request to `ses-owner`.
    await checkSession(
        clientWithParent("ses-parent") as any,
        state,
        QUIET,
        buildMessages("ses-foreign"),
        false,
    )

    assert.equal(state.sessionId, "ses-owner")
    assert.equal(state.isSubAgent, false)
})

test("identity-less system transform does not mutate session state", async () => {
    const registry = createSessionRegistry()
    const sessionId = "ses-system"
    const state = registry.resolve(sessionId)
    state.sessionId = sessionId
    state.initialized = true

    const handler = createSystemPromptHandler(registry, QUIET, buildConfig(), {
        reload() {},
        getRuntimePrompts() {
            return { system: "", manualExtension: "", subagentExtension: "" } as any
        },
    } as any)

    const output = { system: ["base system"] }
    await handler({ model: { limit: { context: 200000 } } } as any, output)

    assert.equal(state.modelContextLimit, undefined, "no session id => no mutation")
    assert.equal(output.system.length, 1)
})

test("system transform mutates only the resolved session's state", async () => {
    const registry = createSessionRegistry()
    const sessionId = "ses-system-owned"
    const state = registry.resolve(sessionId)
    state.sessionId = sessionId
    state.initialized = true

    const handler = createSystemPromptHandler(registry, QUIET, buildConfig(), {
        reload() {},
        getRuntimePrompts() {
            return { system: "", manualExtension: "", subagentExtension: "" } as any
        },
    } as any)

    await handler({ sessionID: sessionId, model: { limit: { context: 123456 } } } as any, {
        system: ["base system"],
    })

    assert.equal(state.modelContextLimit, 123456)
    const other = registry.resolve("ses-system-other")
    assert.equal(other.modelContextLimit, undefined)
})

test("session.deleted evicts the registry entry so memory stays bounded", async () => {
    const registry = createSessionRegistry()
    registry.resolve("ses-keep")
    registry.resolve("ses-drop")
    assert.equal(registry.size(), 2)

    assert.equal(registry.evict("ses-drop"), true)
    assert.equal(registry.get("ses-drop"), null)
    assert.equal(registry.size(), 1)

    // Unknown sessions are a no-op.
    assert.equal(registry.evict("ses-unknown"), false)
    assert.equal(registry.size(), 1)

    // A later request for the evicted session starts from a fresh state object.
    const fresh = registry.resolve("ses-drop")
    assert.equal(fresh.sessionId, null)
})

/** Reject instead of hanging the suite when a wedged queue never settles. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
    })
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

/** Resolve a session state object bound to its own session id. */
function sessionStateFor(registry: SessionRegistry, sessionId: string): SessionState {
    const state = registry.resolve(sessionId)
    state.sessionId = sessionId
    state.initialized = true
    return state
}

test("a registry-routed save awaited inside a queued operation completes (no self-deadlock)", async () => {
    const registry = createSessionRegistry()
    const sessionId = "ses-nested-save"
    const state = sessionStateFor(registry, sessionId)

    // Shape of the production path: `finalizeSession` (lib/compress/pipeline.ts)
    // and the compression-timing handler (lib/hooks.ts) both await a
    // registry-routed save from inside an operation the registry is running.
    const result = await withTimeout(
        registry.run(sessionId, async () => {
            await saveSessionState(state, QUIET, undefined, registry)
            return "completed"
        }),
        2000,
        "nested save deadlocked: the session queue never drained",
    )

    assert.equal(result, "completed")
})

test("a queued operation awaiting a registry-routed save does not wedge the queue", async () => {
    const registry = createSessionRegistry()
    const sessionId = "ses-nested-save-then-independent"
    const state = sessionStateFor(registry, sessionId)

    const first = registry.run(sessionId, async () => {
        await saveSessionState(state, QUIET, undefined, registry)
        return "first"
    })
    const second = registry.run(sessionId, () => "second")

    const results = await withTimeout(
        Promise.all([first, second]),
        2000,
        "the session queue stayed wedged after a nested save",
    )

    assert.deepEqual(results, ["first", "second"])
})

test("independent operations stay strictly serialized while a nested save is in flight", async () => {
    const registry = createSessionRegistry()
    const sessionId = "ses-serialized-around-nested-save"
    const state = sessionStateFor(registry, sessionId)

    const gate = defer<void>()
    const events: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const enter = (label: string) => {
        events.push(`${label}:start`)
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
    }
    const exit = (label: string) => {
        inFlight--
        events.push(`${label}:end`)
    }

    const outer = registry.run(sessionId, async () => {
        enter("outer")
        await saveSessionState(state, QUIET, undefined, registry)
        await gate.promise
        exit("outer")
    })

    // Let the outer operation reach its nested save before the independent caller arrives.
    await new Promise((resolve) => setImmediate(resolve))

    const independent = registry.run(sessionId, () => {
        enter("independent")
        exit("independent")
    })

    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(
        events,
        ["outer:start"],
        "an independent operation must join the queue, never run inline",
    )

    gate.resolve()
    await withTimeout(Promise.all([outer, independent]), 2000, "queue never drained")

    assert.deepEqual(events, ["outer:start", "outer:end", "independent:start", "independent:end"])
    assert.equal(maxInFlight, 1, "same-session operations must never overlap")
})

test("queued operations for different sessions still run concurrently", async () => {
    const registry = createSessionRegistry()
    const gateA = defer<void>()
    const gateB = defer<void>()
    const events: string[] = []

    const a = registry.run("ses-parallel-a", async () => {
        events.push("a:start")
        await gateA.promise
        events.push("a:end")
    })
    const b = registry.run("ses-parallel-b", async () => {
        events.push("b:start")
        await gateB.promise
        events.push("b:end")
    })

    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(
        [...events].sort(),
        ["a:start", "b:start"],
        "a blocked session must not hold up another session",
    )

    gateA.resolve()
    await a
    gateB.resolve()
    await b

    assert.deepEqual([...events].sort(), ["a:end", "a:start", "b:end", "b:start"])
})

test("work started inside a queued operation keeps the session slot until it settles", async () => {
    const registry = createSessionRegistry()
    const sessionId = "ses-fire-and-forget"
    registry.resolve(sessionId)

    const gate = defer<void>()
    const events: string[] = []

    const queued = registry.run(sessionId, () => {
        // Fire-and-forget nested work, the shape of a save issued without `await`
        // (lib/messages/inject/inject.ts): it must not outlive the slot that owns it.
        void registry.run(sessionId, async () => {
            await gate.promise
            events.push("nested:end")
        })
        events.push("queued:end")
        return "queued"
    })

    const later = registry.run(sessionId, () => {
        events.push("later:start")
        return "later"
    })

    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(
        events,
        ["queued:end"],
        "a later operation must not start while nested work is still in flight",
    )

    gate.resolve()
    await withTimeout(Promise.all([queued, later]), 2000, "queue never drained")

    assert.deepEqual(events, ["queued:end", "nested:end", "later:start"])
})

test("an enqueued operation may await a registry-routed save without wedging the queue", async () => {
    const registry = createSessionRegistry()
    const sessionId = "ses-enqueued-save"
    const state = sessionStateFor(registry, sessionId)

    registry.enqueue(sessionId, async () => {
        await saveSessionState(state, QUIET, undefined, registry)
    })

    const after = await withTimeout(
        registry.run(sessionId, () => "after"),
        2000,
        "an enqueued operation deadlocked the session queue",
    )

    assert.equal(after, "after")
})
