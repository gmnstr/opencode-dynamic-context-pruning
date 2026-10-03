import type { SessionState } from "../../state"

export function buildCompressedBlockGuidance(state: SessionState): string {
    const refs = Array.from(state.prune.messages.resolvableBlockIds)
        .filter((id) => Number.isInteger(id) && id > 0)
        .sort((a, b) => a - b)
        .map((id) => `b${id}`)
    const blockCount = refs.length
    const blockList = blockCount > 0 ? refs.join(", ") : "none"

    return [
        "Compressed block context:",
        `- Active compressed blocks in this session: ${blockCount} (${blockList})`,
        "- If your selected compression range includes any listed block, include each required placeholder exactly once in the summary using `(bN)`.",
    ].join("\n")
}

export function renderMessagePriorityGuidance(priorityLabel: string, refs: string[]): string {
    const refList = refs.length > 0 ? refs.join(", ") : "none"

    return [
        "Message priority context:",
        "- Higher-priority older messages consume more context and should be compressed right away if it is safe to do so.",
        `- ${priorityLabel}-priority message IDs before this point: ${refList}`,
    ].join("\n")
}

export function appendGuidanceToDcpTag(nudgeText: string, guidance: string): string {
    if (!guidance.trim()) {
        return nudgeText
    }

    const closeTag = "</dcp-system-reminder>"
    const closeTagIndex = nudgeText.lastIndexOf(closeTag)

    if (closeTagIndex === -1) {
        return nudgeText
    }

    const beforeClose = nudgeText.slice(0, closeTagIndex).trimEnd()
    const afterClose = nudgeText.slice(closeTagIndex)
    return `${beforeClose}\n\n${guidance}\n${afterClose}`
}

const DCP_NUDGE_BLOCK_PATTERN = /<dcp-system-reminder>[\s\S]*?<\/dcp-system-reminder>\n?/g

/**
 * Make nudge injection idempotent: strip any prior DCP nudge blocks from a message
 * text part before the latest nudge is appended. Prior nudges carry the volatile
 * `Compressed block context` / `Message priority context` guidance that reflects
 * live block-state; as blocks get compressed that guidance changes, so without
 * stripping it, stale guidance accumulates in anchored (historical) messages
 * across nudge passes. That both corrupts the model's block map and mutates prior
 * message bytes on every turn, fragmenting provider prefix-cache reuse.
 *
 * The whole `<dcp-system-reminder>...</dcp-system-reminder>` block is removed
 * (not just the guidance lines) so the static base-nudge template cannot
 * accumulate either. This tag is DCP's own synthetic wrapper and never appears
 * in user/assistant content or opencode's `<system-reminder>` tags.
 */
export function stripPriorDcpNudges(text: string): string {
    if (typeof text !== "string" || !text) {
        return text
    }

    return text
        .replace(DCP_NUDGE_BLOCK_PATTERN, "")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/^\n+/, "")
        .replace(/\n+$/, "")
}
