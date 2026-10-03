import type { SessionState } from "../state/types"
import { attachCompressionDuration } from "./state"

export interface PendingCompressionDuration {
    messageId: string
    callId: string
    durationMs: number
}

export interface CompressionTimingState {
    startsByCallId: Map<string, number>
    pendingByCallId: Map<string, PendingCompressionDuration>
}

export function buildCompressionTimingKey(messageId: string, callId: string): string {
    return `${messageId}:${callId}`
}

export function consumeCompressionStart(
    state: SessionState,
    messageId: string,
    callId: string,
): number | undefined {
    const key = buildCompressionTimingKey(messageId, callId)
    const start = state.compressionTiming.startsByCallId.get(key)
    state.compressionTiming.startsByCallId.delete(key)
    return start
}

export function resolveCompressionDuration(
    startedAt: number | undefined,
    eventTime: number | undefined,
    partTime: { start?: unknown; end?: unknown } | undefined,
): number | undefined {
    const runningAt =
        typeof partTime?.start === "number" && Number.isFinite(partTime.start)
            ? partTime.start
            : eventTime
    const pendingToRunningMs =
        typeof startedAt === "number" && typeof runningAt === "number"
            ? Math.max(0, runningAt - startedAt)
            : undefined

    const toolStart = partTime?.start
    const toolEnd = partTime?.end
    const runtimeMs =
        typeof toolStart === "number" &&
        Number.isFinite(toolStart) &&
        typeof toolEnd === "number" &&
        Number.isFinite(toolEnd)
            ? Math.max(0, toolEnd - toolStart)
            : undefined

    return typeof pendingToRunningMs === "number" ? pendingToRunningMs : runtimeMs
}

/**
 * Drop every recorded compression start.
 *
 * A start describes a call that was in flight for the conversation this state was
 * bound to *before* the reset, so consuming it afterwards derives a duration from
 * no evidence at all: either from a start that no longer corresponds to the call
 * (session initialization) or from a block that no longer exists (compaction).
 * The completion event still produces a duration through its own fallback.
 *
 * Cleared in place, not reassigned: an in-flight operation can hold a direct
 * reference to this map (`createEventHandler` in lib/hooks.ts records starts), and
 * a reassignment would leave that holder writing into a map the state no longer
 * owns. Identity preservation here is deliberate.
 */
export function resetCompressionStarts(state: SessionState): void {
    state.compressionTiming.startsByCallId.clear()
}

/**
 * Drop every recorded start and every pending duration.
 *
 * Compaction is the reset where a pending duration has to go as well: it replaces
 * `prune.messages` wholesale (lib/state/utils.ts), so a duration still waiting for
 * its block can never be applied again - retained garbage that would otherwise be
 * attached to an unrelated block happening to reuse the same message/call ids
 * (`applyPendingCompressionDurations` below only deletes an entry it applies).
 *
 * `resetSessionState` deliberately does *not* call this: it drops the starts only,
 * because a pending duration is how a completion that arrived before the session
 * was loaded reaches its block. `ensureSessionInitialized` resets the state, then
 * loads the session's blocks, and only then applies what is still pending
 * (lib/state/state.ts), and a pending duration dropped at that reset would be lost
 * for good.
 */
export function resetCompressionTiming(state: SessionState): void {
    resetCompressionStarts(state)
    state.compressionTiming.pendingByCallId.clear()
}

export function applyPendingCompressionDurations(state: SessionState): number {
    if (state.compressionTiming.pendingByCallId.size === 0) {
        return 0
    }

    let updates = 0
    for (const [key, entry] of state.compressionTiming.pendingByCallId) {
        const applied = attachCompressionDuration(
            state.prune.messages,
            entry.messageId,
            entry.callId,
            entry.durationMs,
        )
        if (applied > 0) {
            updates += applied
            state.compressionTiming.pendingByCallId.delete(key)
        }
    }

    return updates
}
