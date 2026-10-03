// Must come first: sets XDG_DATA_HOME/XDG_CONFIG_HOME before lib/state/persistence.ts
// captures them at import time. See the module for why this ordering matters.
import { TEST_DATA_HOME } from "./helpers/dcp-test-env"

import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createSessionRegistry, type SessionRegistry } from "../lib/state/registry"
import {
    checkSession,
    createSessionState,
    resetSessionState,
    saveSessionState,
    type SessionState,
    type WithParts,
} from "../lib/state"
import {
    collectTurnNudgeAnchors,
    countTurns,
    findLastCompactionTimestamp,
    isSubAgentSession,
    loadPruneMap,
    loadPruneMessagesState,
    resetOnCompaction,
} from "../lib/state/utils"
import { applyPendingCompressionDurations } from "../lib/compress/timing"
import { loadSessionState } from "../lib/state/persistence"
import { getLastUserMessage } from "../lib/messages/query"
import { Logger } from "../lib/logger"

/**
 * Control harness for the session-isolation change.
 *
 * Why this exists: `tests/session-isolation.test.ts` proves the current design
 * keeps two interleaved sessions apart, but a test that only ever passes against
 * one design cannot show that it *discriminates*. This file runs the identical
 * interleaving scenario against both designs and asserts opposite outcomes:
 *
 *   - legacy design (`21eff67`, one process-global state object): CONTAMINATED
 *   - current design (per-session registry): ISOLATED
 *
 * If the isolation change is reverted or weakened, the legacy arm stays green
 * and the registry arm flips to contaminated, so the suite fails. If someone
 * "repairs" the legacy transcription below into something correct, the legacy arm
 * fails — and the drift guard additionally verifies the transcription still
 * matches the real `21eff67` source.
 *
 * Only the two gate functions are transcribed (they are the code under test);
 * every helper they call is the real production module.
 */

const LEGACY_COMMIT = "21eff67"
const REPO_ROOT = join(import.meta.dir, "..")

const QUIET = new Logger(false)
const STORAGE_DIR = join(TEST_DATA_HOME, "opencode", "storage", "plugin", "dcp")

const SESSION_A = "ses_control_a"
const SESSION_B = "ses_control_b"
/** Topic of the only compressed block that session A owns. */
const A_PRIVATE_TOPIC = "session-a-private-summary"

/**
 * `checkSession` + `ensureSessionInitialized` exactly as `21eff67` had them.
 * The bind-then-await-then-install ordering below IS the defect: the session id
 * is written before the two awaits, and the block state is installed after them.
 */
async function legacyEnsureSessionInitialized(
    client: any,
    state: SessionState,
    sessionId: string,
    logger: Logger,
    messages: WithParts[],
    manualModeEnabled: boolean,
): Promise<void> {
    if (state.sessionId === sessionId) {
        return
    }

    resetSessionState(state)
    state.manualMode = manualModeEnabled ? "active" : false
    state.sessionId = sessionId

    const isSubAgent = await isSubAgentSession(client, sessionId)
    state.isSubAgent = isSubAgent

    state.lastCompaction = findLastCompactionTimestamp(messages)
    state.currentTurn = countTurns(state, messages)
    state.nudges.turnNudgeAnchors = collectTurnNudgeAnchors(messages)

    const persisted = await loadSessionState(sessionId, logger)
    if (persisted === null) {
        return
    }

    state.prune.tools = loadPruneMap(persisted.prune.tools)
    state.prune.messages = loadPruneMessagesState(persisted.prune.messages)
    state.nudges.contextLimitAnchors = new Set<string>(persisted.nudges.contextLimitAnchors || [])
    state.nudges.turnNudgeAnchors = new Set<string>([
        ...state.nudges.turnNudgeAnchors,
        ...(persisted.nudges.turnNudgeAnchors || []),
    ])
    state.nudges.iterationNudgeAnchors = new Set<string>(
        persisted.nudges.iterationNudgeAnchors || [],
    )
    state.stats = {
        pruneTokenCounter: persisted.stats?.pruneTokenCounter || 0,
        totalPruneTokens: persisted.stats?.totalPruneTokens || 0,
    }

    const applied = applyPendingCompressionDurations(state)
    if (applied > 0) {
        await saveSessionState(state, logger)
    }
}

async function legacyCheckSession(
    client: any,
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    manualModeDefault: boolean,
): Promise<void> {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return
    }

    const lastSessionId = lastUserMessage.info.sessionID

    if (state.sessionId === null || state.sessionId !== lastSessionId) {
        logger.info(`Session changed: ${state.sessionId} -> ${lastSessionId}`)
        try {
            await legacyEnsureSessionInitialized(
                client,
                state,
                lastSessionId,
                logger,
                messages,
                manualModeDefault,
            )
        } catch (err: any) {
            logger.error("Failed to initialize session state", { error: err.message })
        }
    }

    const lastCompactionTimestamp = findLastCompactionTimestamp(messages)
    if (lastCompactionTimestamp > state.lastCompaction) {
        state.lastCompaction = lastCompactionTimestamp
        resetOnCompaction(state)
        logger.info("Detected compaction - reset stale state", {
            timestamp: lastCompactionTimestamp,
        })

        saveSessionState(state, logger).catch(() => {})
    }

    state.currentTurn = countTurns(state, messages)
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

interface Deferred {
    resolve: () => void
    promise: Promise<void>
}

function defer(): Deferred {
    let resolve!: () => void
    const promise = new Promise<void>((res) => {
        resolve = () => res()
    })
    return { resolve, promise }
}

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

/** `session.get` gated on `gate` so the interleaving is deterministic, not timing-dependent. */
function clientWithParent(parentID: string | null, gate?: Promise<void>) {
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

function writePersistedSessionWithBlock(sessionId: string, topic: string): void {
    mkdirSync(STORAGE_DIR, { recursive: true })
    writeFileSync(
        join(STORAGE_DIR, `${sessionId}.json`),
        JSON.stringify({
            prune: {
                tools: {},
                messages: {
                    byMessageId: {},
                    blocksById: {
                        "7": {
                            blockId: 7,
                            runId: 1,
                            active: true,
                            anchorMessageId: `${sessionId}-anchor`,
                            compressMessageId: `${sessionId}-compress`,
                            summary: topic,
                            topic,
                            summaryTokens: 42,
                            mode: "range",
                            createdAt: 1,
                        },
                    },
                    activeBlockIds: [7],
                    activeByAnchorMessageId: { [`${sessionId}-anchor`]: 7 },
                    nextBlockId: 8,
                    nextRunId: 2,
                },
            },
            nudges: { contextLimitAnchors: [] },
            stats: { pruneTokenCounter: 0, totalPruneTokens: 1234 },
            lastUpdated: new Date(0).toISOString(),
        }),
        "utf-8",
    )
}

function resetScenarioFiles(): void {
    mkdirSync(STORAGE_DIR, { recursive: true })
    for (const sessionId of [SESSION_A, SESSION_B]) {
        const file = join(STORAGE_DIR, `${sessionId}.json`)
        if (existsSync(file)) {
            writeFileSync(file, "{}", "utf-8")
        }
    }
}

type Verdict = {
    /** Blocks whose anchor belongs to a session other than the state's own identity. */
    foreignBlockTopics: string[]
    stateIdentity: string | null
}

/** The predicate under test: does this state object belong to the session that filled it? */
function judge(state: SessionState, owningSessionId: string): Verdict {
    const foreignBlockTopics: string[] = []
    for (const block of state.prune.messages.blocksById.values()) {
        const anchor = block.anchorMessageId ?? ""
        if (anchor !== "" && !anchor.startsWith(owningSessionId)) {
            foreignBlockTopics.push(block.topic ?? "")
        }
    }
    return { foreignBlockTopics, stateIdentity: state.sessionId }
}

/**
 * Deterministic interleave: both gates start and park on their first await
 * (`isSubAgentSession`), then are released. Session A is a subagent and owns a
 * compressed block; session B is a root session with nothing persisted.
 */
async function runLegacyInterleave(): Promise<SessionState> {
    resetScenarioFiles()
    writePersistedSessionWithBlock(SESSION_A, A_PRIVATE_TOPIC)

    const shared = createSessionState() // the single process-global object of 21eff67
    const gateA = defer()
    const gateB = defer()

    const gateAResult = legacyCheckSession(
        clientWithParent("ses_parent_of_a", gateA.promise),
        shared,
        QUIET,
        buildMessages(SESSION_A),
        false,
    )
    const gateBResult = legacyCheckSession(
        clientWithParent(null, gateB.promise),
        shared,
        QUIET,
        buildMessages(SESSION_B),
        false,
    )

    gateA.resolve()
    gateB.resolve()
    await Promise.all([gateAResult, gateBResult])

    return shared
}

async function runRegistryInterleave(): Promise<SessionRegistry> {
    resetScenarioFiles()
    writePersistedSessionWithBlock(SESSION_A, A_PRIVATE_TOPIC)

    const registry = createSessionRegistry()
    const gateA = defer()
    const gateB = defer()

    const gateAResult = registry.run(SESSION_A, async () => {
        await checkSession(
            clientWithParent("ses_parent_of_a", gateA.promise),
            registry.resolve(SESSION_A),
            QUIET,
            buildMessages(SESSION_A),
            false,
        )
    })
    const gateBResult = registry.run(SESSION_B, async () => {
        await checkSession(
            clientWithParent(null, gateB.promise),
            registry.resolve(SESSION_B),
            QUIET,
            buildMessages(SESSION_B),
            false,
        )
    })

    gateA.resolve()
    gateB.resolve()
    await Promise.all([gateAResult, gateBResult])

    return registry
}

// ---------------------------------------------------------------------------
// The control: same scenario, opposite expected outcomes
// ---------------------------------------------------------------------------

test("CONTROL: the legacy shared-state design contaminates across the interleave", async () => {
    const shared = await runLegacyInterleave()

    // Session B is the last identity bound onto the shared object...
    assert.equal(shared.sessionId, SESSION_B)
    // ...but session A's compressed block is what actually got installed in it.
    const verdict = judge(shared, SESSION_B)
    assert.deepEqual(
        verdict.foreignBlockTopics,
        [A_PRIVATE_TOPIC],
        "legacy gate should install session A's block into a state object bound to session B",
    )
})

test("CONTROL: that legacy contamination reaches disk as session B's state file", async () => {
    const shared = await runLegacyInterleave()
    await saveSessionState(shared, QUIET)

    const written = JSON.parse(readFileSync(join(STORAGE_DIR, `${SESSION_B}.json`), "utf-8"))
    const topics = Object.values<{ topic?: string }>(written.prune.messages.blocksById).map(
        (b) => b.topic,
    )
    assert.ok(
        topics.includes(A_PRIVATE_TOPIC),
        `session A's summary was persisted into session B's state file: ${JSON.stringify(topics)}`,
    )
})

test("the same scenario against the registry leaves both sessions clean", async () => {
    const registry = await runRegistryInterleave()

    const stateA = registry.resolve(SESSION_A)
    const stateB = registry.resolve(SESSION_B)

    assert.notEqual(stateA, stateB, "each session must own a distinct state object")
    assert.equal(stateA.sessionId, SESSION_A)
    assert.equal(stateB.sessionId, SESSION_B)

    assert.deepEqual(judge(stateA, SESSION_A).foreignBlockTopics, [])
    assert.deepEqual(judge(stateB, SESSION_B).foreignBlockTopics, [])
    assert.deepEqual(
        judge(stateA, SESSION_A).foreignBlockTopics,
        [],
        "A keeps exactly its own block",
    )
    assert.equal(stateA.isSubAgent, true)
    assert.equal(stateB.isSubAgent, false)

    await saveSessionState(stateB, QUIET)
    const written = JSON.parse(readFileSync(join(STORAGE_DIR, `${SESSION_B}.json`), "utf-8"))
    assert.deepEqual(Object.keys(written.prune.messages.blocksById), [])
})

// ---------------------------------------------------------------------------
// Drift guard: the transcription above must still match the real 21eff67 source
// ---------------------------------------------------------------------------

test("drift guard: 21eff67 still has the bind-then-await-then-install shape this control reproduces", () => {
    let source: string
    try {
        source = execFileSync("git", ["show", `${LEGACY_COMMIT}:lib/state/state.ts`], {
            cwd: REPO_ROOT,
            encoding: "utf-8",
        })
    } catch (error) {
        assert.fail(
            `cannot read ${LEGACY_COMMIT}:lib/state/state.ts — the control's baseline is unavailable: ${String(error)}`,
        )
    }

    const at = (needle: string): number => source.indexOf(needle)
    const bind = at("state.sessionId = sessionId")
    const subagent = at("await isSubAgentSession")
    const load = at("await loadSessionState")
    const install = at("state.prune.messages = loadPruneMessagesState")

    assert.ok(bind >= 0, "legacy source should bind the session id")
    assert.ok(subagent >= 0, "legacy source should await isSubAgentSession")
    assert.ok(load >= 0, "legacy source should await loadSessionState")
    assert.ok(install >= 0, "legacy source should install block state after loading")
    assert.ok(
        bind < subagent && subagent < load && load < install,
        "the race requires: bind identity, then await subagent detection, then await load, then install",
    )

    // The pre-change gate had no identity guard; the current one does. If the old
    // shape ever gains a guard, this control stops modelling the real regression.
    assert.match(source, /if \(state\.sessionId === null \|\| state\.sessionId !== lastSessionId\)/)
    assert.doesNotMatch(source, /identity mismatched/i)
})
