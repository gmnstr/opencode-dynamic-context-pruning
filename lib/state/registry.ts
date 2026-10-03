import { AsyncLocalStorage } from "node:async_hooks"
import type { SessionState } from "./types"
import { createSessionState } from "./state"

/**
 * Per-session state registry.
 *
 * A single mutable state object shared by every session loses identity when two
 * sessions interleave across the `await`s inside `ensureSessionInitialized`
 * (the session id is installed before those awaits, the remaining fields after
 * them). The registry removes the ambiguity structurally: each session owns a
 * distinct state object, so interleaving cannot cross-contaminate, no matter
 * the arrival order of requests.
 *
 * Per-session serialization: every entry owns its own promise chain, so
 * conflicting operations for one session never interleave, while different
 * sessions still proceed independently (no global serialization).
 *
 * Re-entrancy: an operation running in a session's queue slot may call `run` for
 * that same session again (a routed save does exactly this, e.g.
 * `finalizeSession` -> `saveSessionState`). Such a nested call must not join the
 * chain: the chain's next link is released only by the very operation that is
 * awaiting the nested call, so joining it waits on itself and the queue never
 * drains. Nested calls therefore run inline in the slot the caller already
 * holds. Ownership is identified by a token carried through the async context
 * (`activeOperation`) and recorded on the entry while a slot is held; a
 * genuinely independent caller arriving while an operation runs carries no such
 * token, so it still queues behind that operation.
 */

export interface SessionRegistry {
    /** Existing entry, or null when the session was never resolved or was evicted. */
    get(sessionId: string): SessionState | null
    /** Existing entry, or a fresh per-session state object. */
    resolve(sessionId: string): SessionState
    /**
     * Run an operation held under this session's serialization chain. A call made
     * from inside this session's own running operation runs inline in that slot
     * (re-entrant) instead of joining the chain behind itself.
     */
    run<T>(sessionId: string, operation: () => Promise<T> | T): Promise<T>
    /** Append work to this session's serialization chain without joining it. */
    enqueue(sessionId: string, operation: () => Promise<void>): void
    /** Drop the session's state (session.deleted) so memory stays bounded. */
    evict(sessionId: string): boolean
    /** Number of live sessions (test/diagnostic helper). */
    size(): number
}

/**
 * The queue slot the current async context is executing inside, if any. Set only
 * while an owned operation runs, and inherited by everything that operation
 * starts (nested calls included).
 */
interface ActiveOperation {
    sessionId: string
    token: symbol
}

const activeOperation = new AsyncLocalStorage<ActiveOperation>()

interface RegistryEntry {
    state: SessionState
    /** Tail of this session's serialization chain. */
    tail: Promise<void>
    /** Token of the operation currently holding the slot, or null when free. */
    ownerToken: symbol | null
    /** Work started inline in the current slot; the slot waits for it to settle. */
    inline: Set<Promise<unknown>>
}

class SessionRegistryImpl implements SessionRegistry {
    private readonly entries = new Map<string, RegistryEntry>()

    get(sessionId: string): SessionState | null {
        return this.entries.get(sessionId)?.state ?? null
    }

    resolve(sessionId: string): SessionState {
        const existing = this.entries.get(sessionId)
        if (existing) {
            return existing.state
        }

        const entry: RegistryEntry = {
            state: createSessionState(),
            tail: Promise.resolve(),
            ownerToken: null,
            inline: new Set(),
        }
        this.entries.set(sessionId, entry)
        return entry.state
    }

    async run<T>(sessionId: string, operation: () => Promise<T> | T): Promise<T> {
        const entry = this.entryFor(sessionId)

        // Re-entrant call: this caller descends from the operation that owns this
        // session's slot and that slot is still the one it holds, so the caller is
        // already serialized. Run inline - chaining onto the tail here would await
        // the outer operation's own release, which it can only reach after this
        // call resolves.
        const active = activeOperation.getStore()
        if (active && active.sessionId === sessionId && active.token === entry.ownerToken) {
            return this.runInline(entry, operation)
        }

        // Independent caller: take a place in the chain and wait for the slot.
        const previous = entry.tail

        let release: () => void = () => {}
        entry.tail = new Promise<void>((resolve) => {
            release = resolve
        })

        await previous
        try {
            return await this.runOwned(entry, sessionId, operation)
        } finally {
            release()
        }
    }

    enqueue(sessionId: string, operation: () => Promise<void>): void {
        const entry = this.entryFor(sessionId)
        const owned = () => this.runOwned(entry, sessionId, operation)
        const next = entry.tail.then(owned, owned)
        entry.tail = next.then(
            () => undefined,
            () => undefined,
        )
    }

    evict(sessionId: string): boolean {
        return this.entries.delete(sessionId)
    }

    size(): number {
        return this.entries.size
    }

    /**
     * Run an operation as the owner of this session's slot: mark the slot owned so
     * nested calls are recognized as re-entrant, publish that ownership to the
     * async context, then wait for inline nested work before giving the slot up.
     */
    private async runOwned<T>(
        entry: RegistryEntry,
        sessionId: string,
        operation: () => Promise<T> | T,
    ): Promise<T> {
        const token = Symbol(sessionId)
        entry.ownerToken = token
        try {
            return await activeOperation.run({ sessionId, token }, () =>
                this.runInline(entry, operation),
            )
        } finally {
            // A nested call its caller does not await (fire-and-forget) must still
            // finish before the slot is released, or it would overlap the next
            // queued operation for this session.
            await this.settleInline(entry)
            if (entry.ownerToken === token) {
                entry.ownerToken = null
            }
        }
    }

    /** Start an operation inline in the slot the caller already holds. */
    private runInline<T>(entry: RegistryEntry, operation: () => Promise<T> | T): Promise<T> {
        const work = new Promise<T>((resolve, reject) => {
            try {
                resolve(operation())
            } catch (error) {
                reject(error)
            }
        })

        // Track the work so the slot can wait for it. `tracked` resolves in every
        // case, so a fire-and-forget failure cannot surface as an unhandled
        // rejection here (the caller's own promise keeps its rejection).
        const tracked = work.then(
            () => {
                entry.inline.delete(tracked)
            },
            () => {
                entry.inline.delete(tracked)
            },
        )
        entry.inline.add(tracked)

        return work
    }

    private async settleInline(entry: RegistryEntry): Promise<void> {
        while (entry.inline.size > 0) {
            await Promise.allSettled([...entry.inline])
        }
    }

    private entryFor(sessionId: string): RegistryEntry {
        this.resolve(sessionId)
        return this.entries.get(sessionId)!
    }
}

export function createSessionRegistry(): SessionRegistry {
    return new SessionRegistryImpl()
}

/**
 * Routing source accepted by every handler: the production per-session registry,
 * or (tests and direct callers) a single explicit state object.
 */
export type SessionSource = SessionRegistry | SessionState

export function isSessionRegistry(source: SessionSource): source is SessionRegistry {
    return (
        typeof (source as SessionRegistry)?.run === "function" &&
        typeof (source as SessionRegistry)?.evict === "function" &&
        typeof (source as SessionRegistry)?.resolve === "function"
    )
}

/**
 * Resolve the state for a routing source.
 * - registry: requires `sessionId`; returns null when identity is unavailable
 *   (fail open - callers then mutate nothing).
 * - explicit state: returned as-is (no session identity required).
 */
export function resolveSessionState(
    source: SessionSource,
    sessionId: string | null | undefined,
): SessionState | null {
    if (isSessionRegistry(source)) {
        if (!sessionId) {
            return null
        }
        return source.resolve(sessionId)
    }
    return source
}
