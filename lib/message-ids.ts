import type { SessionState, WithParts } from "./state"
import { isIgnoredUserMessage } from "./messages/query"

const MESSAGE_REF_REGEX = /^m(\d{4})$/
const BLOCK_REF_REGEX = /^b([1-9]\d*)$/
const MESSAGE_ID_TAG_NAME = "dcp-message-id"

const MESSAGE_REF_WIDTH = 4
const MESSAGE_REF_MIN_INDEX = 1
export const MESSAGE_REF_MAX_INDEX = 9999

export type ParsedBoundaryId =
    | {
          kind: "message"
          ref: string
          index: number
      }
    | {
          kind: "compressed-block"
          ref: string
          blockId: number
      }

export function formatMessageRef(index: number): string {
    if (
        !Number.isInteger(index) ||
        index < MESSAGE_REF_MIN_INDEX ||
        index > MESSAGE_REF_MAX_INDEX
    ) {
        throw new Error(
            `Message ID index out of bounds: ${index}. Supported range is 0-${MESSAGE_REF_MAX_INDEX}.`,
        )
    }
    return `m${index.toString().padStart(MESSAGE_REF_WIDTH, "0")}`
}

export function formatBlockRef(blockId: number): string {
    if (!Number.isInteger(blockId) || blockId < 1) {
        throw new Error(`Invalid block ID: ${blockId}`)
    }
    return `b${blockId}`
}

export function parseMessageRef(ref: string): number | null {
    const normalized = ref.trim().toLowerCase()
    const match = normalized.match(MESSAGE_REF_REGEX)
    if (!match) {
        return null
    }
    const index = Number.parseInt(match[1], 10)
    if (!Number.isInteger(index)) {
        return null
    }
    if (index < MESSAGE_REF_MIN_INDEX || index > MESSAGE_REF_MAX_INDEX) {
        return null
    }
    return index
}

export function parseBlockRef(ref: string): number | null {
    const normalized = ref.trim().toLowerCase()
    const match = normalized.match(BLOCK_REF_REGEX)
    if (!match) {
        return null
    }
    const id = Number.parseInt(match[1], 10)
    return Number.isInteger(id) ? id : null
}

export function parseBoundaryId(id: string): ParsedBoundaryId | null {
    const normalized = id.trim().toLowerCase()
    const messageIndex = parseMessageRef(normalized)
    if (messageIndex !== null) {
        return {
            kind: "message",
            ref: formatMessageRef(messageIndex),
            index: messageIndex,
        }
    }

    const blockId = parseBlockRef(normalized)
    if (blockId !== null) {
        return {
            kind: "compressed-block",
            ref: formatBlockRef(blockId),
            blockId,
        }
    }

    return null
}

function escapeXmlAttribute(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
}

export function formatMessageIdTag(
    ref: string,
    attributes?: Record<string, string | undefined>,
): string {
    const serializedAttributes = Object.entries(attributes || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => {
            if (name.trim().length === 0 || typeof value !== "string" || value.length === 0) {
                return ""
            }

            return ` ${name}="${escapeXmlAttribute(value)}"`
        })
        .join("")

    return `\n<${MESSAGE_ID_TAG_NAME}${serializedAttributes}>${ref}</${MESSAGE_ID_TAG_NAME}>`
}

export function assignMessageRefs(state: SessionState, messages: WithParts[]): number {
    reconcileMessageRefs(state, messages)

    let assigned = 0
    let skippedSubAgentPrompt = false

    for (const message of messages) {
        if (isIgnoredUserMessage(message)) {
            continue
        }

        if (state.isSubAgent && !skippedSubAgentPrompt && message.info.role === "user") {
            skippedSubAgentPrompt = true
            continue
        }

        const rawMessageId = message.info.id
        if (typeof rawMessageId !== "string" || rawMessageId.length === 0) {
            continue
        }

        const existingRef = state.messageIds.byRawId.get(rawMessageId)
        if (existingRef !== undefined) {
            if (state.messageIds.byRef.get(existingRef) !== rawMessageId) {
                state.messageIds.byRef.set(existingRef, rawMessageId)
            }
            continue
        }

        const ref = allocateNextMessageRef(state)
        state.messageIds.byRawId.set(rawMessageId, ref)
        state.messageIds.byRef.set(ref, rawMessageId)
        assigned++
    }

    return assigned
}

/**
 * Drop aliases whose raw message is no longer in the payload, so both maps stay
 * proportional to the conversation instead of growing for the lifetime of the
 * session. This is the one place that holds the live message set and the issued refs
 * at the same time.
 *
 * `nextRef` is never lowered by this - it is raised to one past the highest ref about
 * to be dropped. A ref shown to the model is burned, and `allocateNextMessageRef`
 * only refuses a ref that is still present in `byRef`, so dropping an entry while
 * `nextRef` still points below it would put that ref back into circulation. That can
 * only happen for a persisted document whose `nextRef` disagrees with its maps (a
 * missing or malformed `nextRef` degrades to 1, see `loadMessageIdsState`); the
 * floor is what makes "never reissue" unconditional instead of contingent on the
 * file being well formed.
 *
 * Trade-off, stated on purpose: monotonic refs with no reuse spend the finite
 * 9999-ref space (`MESSAGE_REF_MAX_INDEX`) at one ref per message ever assigned in
 * the session, so `allocateNextMessageRef` eventually throws. See that function.
 */
function reconcileMessageRefs(state: SessionState, messages: WithParts[]): void {
    const liveRawIds = new Set<string>()
    for (const message of messages) {
        const rawMessageId = message.info.id
        if (typeof rawMessageId === "string" && rawMessageId.length > 0) {
            liveRawIds.add(rawMessageId)
        }
    }

    const { byRawId, byRef } = state.messageIds

    let highestIssued = MESSAGE_REF_MIN_INDEX - 1
    for (const ref of byRef.keys()) {
        const index = parseMessageRef(ref)
        if (index !== null && index > highestIssued) {
            highestIssued = index
        }
    }

    for (const rawMessageId of byRawId.keys()) {
        if (!liveRawIds.has(rawMessageId)) {
            byRawId.delete(rawMessageId)
        }
    }
    for (const [ref, rawMessageId] of byRef) {
        if (byRawId.get(rawMessageId) !== ref) {
            byRef.delete(ref)
        }
    }

    const floor = highestIssued + 1
    if (state.messageIds.nextRef < floor) {
        state.messageIds.nextRef = floor
    }
}

/**
 * The alias space is finite (`MESSAGE_REF_MAX_INDEX` = 9999) and no ref is ever
 * recycled, so a session can hand out at most 9999 refs over its whole lifetime -
 * about 5000 user/assistant turn pairs, because a native compaction burns the refs of
 * the messages it replaces instead of returning them. Past that this throws, and the
 * chat transform fails open without ids for that request. Recycling a burned ref is
 * the bug this design exists to prevent, so the ceiling is a deliberate trade rather
 * than an oversight: lifting it means widening `mNNNN` (and every prompt that
 * documents it), not relaxing monotonicity.
 */
function allocateNextMessageRef(state: SessionState): string {
    let candidate = Number.isInteger(state.messageIds.nextRef)
        ? Math.max(MESSAGE_REF_MIN_INDEX, state.messageIds.nextRef)
        : MESSAGE_REF_MIN_INDEX

    while (candidate <= MESSAGE_REF_MAX_INDEX) {
        const ref = formatMessageRef(candidate)
        if (!state.messageIds.byRef.has(ref)) {
            state.messageIds.nextRef = candidate + 1
            return ref
        }
        candidate++
    }

    throw new Error(
        `Message ID alias capacity exceeded. Cannot allocate more than ${formatMessageRef(MESSAGE_REF_MAX_INDEX)} aliases in this session.`,
    )
}
