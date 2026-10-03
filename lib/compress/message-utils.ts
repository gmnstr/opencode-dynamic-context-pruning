import type { PluginConfig } from "../config"
import type { SessionState } from "../state"
import { formatBlockRef, formatMessageRef, parseBoundaryId, parseMessageRef } from "../message-ids"
import { isIgnoredUserMessage, isProtectedUserMessage } from "../messages/query"
import { resolveAnchorMessageId, resolveBoundaryIds, resolveSelection } from "./search"
import { COMPRESSED_BLOCK_HEADER } from "./state"
import type {
    CompressMessageEntry,
    CompressMessageToolArgs,
    ResolvedMessageCompression,
    ResolvedMessageCompressionsResult,
    SearchContext,
} from "./types"

interface SkippedIssue {
    kind: string
    messageId: string
    detail?: string
}

class SoftIssue extends Error {
    constructor(
        public readonly kind: string,
        public readonly messageId: string,
        message: string,
        public readonly detail?: string,
    ) {
        super(message)
    }
}

export function validateArgs(args: CompressMessageToolArgs): void {
    if (typeof args.topic !== "string" || args.topic.trim().length === 0) {
        throw new Error("topic is required and must be a non-empty string")
    }

    if (!Array.isArray(args.content) || args.content.length === 0) {
        throw new Error("content is required and must be a non-empty array")
    }

    for (let index = 0; index < args.content.length; index++) {
        const entry = args.content[index]
        const prefix = `content[${index}]`

        if (typeof entry?.messageId !== "string" || entry.messageId.trim().length === 0) {
            throw new Error(`${prefix}.messageId is required and must be a non-empty string`)
        }

        if (typeof entry?.topic !== "string" || entry.topic.trim().length === 0) {
            throw new Error(`${prefix}.topic is required and must be a non-empty string`)
        }

        if (typeof entry?.summary !== "string" || entry.summary.trim().length === 0) {
            throw new Error(`${prefix}.summary is required and must be a non-empty string`)
        }
    }
}

export function formatResult(
    processedCount: number,
    skippedIssues: string[],
    skippedCount: number,
): string {
    const messageNoun = processedCount === 1 ? "message" : "messages"
    const processedText =
        processedCount > 0
            ? `Compressed ${processedCount} ${messageNoun} into ${COMPRESSED_BLOCK_HEADER}.`
            : "Compressed 0 messages."

    if (skippedCount === 0) {
        return processedText
    }

    const issueNoun = skippedCount === 1 ? "issue" : "issues"
    const issueLines = skippedIssues.map((issue) => `- ${issue}`).join("\n")
    return `${processedText}\nSkipped ${skippedCount} ${issueNoun}:\n${issueLines}`
}

export function formatIssues(skippedIssues: string[], skippedCount: number): string {
    const issueNoun = skippedCount === 1 ? "issue" : "issues"
    const issueLines = skippedIssues.map((issue) => `- ${issue}`).join("\n")
    return `Unable to compress any messages. Found ${skippedCount} ${issueNoun}:\n${issueLines}`
}

const ISSUE_TEMPLATES: Record<string, [singular: string, plural: string]> = {
    blocked: [
        "refers to a protected message and cannot be compressed.",
        "refer to protected messages and cannot be compressed.",
    ],
    "invalid-format": [
        "is invalid. Use an injected raw message ID of the form mNNNN.",
        "are invalid. Use injected raw message IDs of the form mNNNN.",
    ],
    "block-id": [
        "is invalid here. Block IDs like bN are not allowed; use an mNNNN message ID instead.",
        "are invalid here. Block IDs like bN are not allowed; use mNNNN message IDs instead.",
    ],
    "not-in-context": [
        "is not available in the current conversation context. Choose an injected mNNNN ID visible in context.",
        "are not available in the current conversation context. Choose injected mNNNN IDs visible in context.",
    ],
    protected: [
        "refers to a protected message and cannot be compressed.",
        "refer to protected messages and cannot be compressed.",
    ],
    "already-compressed": [
        "is already part of an active compression.",
        "are already part of active compressions.",
    ],
    duplicate: [
        "was selected more than once in this batch.",
        "were each selected more than once in this batch.",
    ],
}

function formatSkippedGroup(kind: string, messageIds: string[], detail?: string): string {
    const templates = ISSUE_TEMPLATES[kind]
    const ids = messageIds.join(", ")
    const single = messageIds.length === 1
    const prefix = single ? "messageId" : "messageIds"

    if (!templates) {
        return `${prefix} ${ids}: unknown issue.`
    }

    const suffix = detail ? ` ${detail}` : ""
    return `${prefix} ${ids} ${single ? templates[0] : templates[1]}${suffix}`
}

function groupSkippedIssues(issues: SkippedIssue[]): string[] {
    const groups = new Map<string, string[]>()
    const details = new Map<string, string>()
    const order: string[] = []

    for (const issue of issues) {
        let ids = groups.get(issue.kind)
        if (!ids) {
            ids = []
            groups.set(issue.kind, ids)
            order.push(issue.kind)
        }
        ids.push(issue.messageId)
        // Spelled out once per group, not once per message id: every entry of a group
        // was judged against the same state, so its valid-ref list is identical.
        if (issue.detail && !details.has(issue.kind)) {
            details.set(issue.kind, issue.detail)
        }
    }

    return order.map((kind) => {
        const ids = groups.get(kind)!
        return formatSkippedGroup(kind, ids, details.get(kind))
    })
}

/** At most this many ref runs and block refs are spelled out; the rest is a count. */
const MAX_VALID_MESSAGE_REF_RUNS = 4
const MAX_VALID_BLOCK_REFS = 8

function renderMessageRefRuns(indices: number[]): string {
    const refs = [...new Set(indices)].sort((left, right) => left - right)
    if (refs.length === 0) {
        return ""
    }

    const runs: Array<{ text: string; count: number }> = []
    const flush = (start: number, end: number) => {
        runs.push({
            text:
                start === end
                    ? formatMessageRef(start)
                    : `${formatMessageRef(start)}-${formatMessageRef(end)}`,
            count: end - start + 1,
        })
    }

    let start = refs[0]
    let end = start
    for (const index of refs.slice(1)) {
        if (index === end + 1) {
            end = index
            continue
        }
        flush(start, end)
        start = index
        end = index
    }
    flush(start, end)

    const kept = runs.slice(0, MAX_VALID_MESSAGE_REF_RUNS)
    const omitted = runs
        .slice(MAX_VALID_MESSAGE_REF_RUNS)
        .reduce((total, run) => total + run.count, 0)
    const rendered = kept.map((run) => run.text).join(", ")

    return omitted === 0 ? rendered : `${rendered}, +${omitted} more`
}

function renderBlockRefs(blockIds: number[]): string {
    const refs = [...new Set(blockIds)]
        .filter((blockId) => Number.isInteger(blockId) && blockId > 0)
        .sort((left, right) => left - right)
        .map((blockId) => formatBlockRef(blockId))

    const kept = refs.slice(0, MAX_VALID_BLOCK_REFS)
    const omitted = refs.length - kept.length

    return omitted === 0 ? kept.join(", ") : `${kept.join(", ")}, +${omitted} more`
}

/**
 * The refs the model can actually use right now, so a stale-ref rejection points at a
 * live id instead of leaving the model to retry the dead one.
 *
 * The message rule mirrors `buildBoundaryLookup` (lib/compress/search.ts): a ref
 * resolves while its raw message is in the live payload and is not an ignored user
 * message. Block refs come from `resolvableBlockIds`, which
 * `syncCompressionBlocks` (lib/messages/sync.ts) keeps in step with that resolver.
 *
 * Bounded on purpose. This text is embedded in a tool response the model reads, and a
 * long-lived session can carry thousands of refs: message refs collapse into
 * contiguous runs (`m0003-m0011`) and only the first few runs are spelled out.
 */
function describeValidRefs(state: SessionState, searchContext: SearchContext): string {
    const indices: number[] = []
    for (const [ref, rawMessageId] of state.messageIds.byRef) {
        const rawMessage = searchContext.rawMessagesById.get(rawMessageId)
        if (!rawMessage || !searchContext.rawIndexById.has(rawMessageId)) {
            continue
        }
        if (isIgnoredUserMessage(rawMessage)) {
            continue
        }
        const index = parseMessageRef(ref)
        if (index === null) {
            continue
        }
        indices.push(index)
    }

    const sections = [
        renderMessageRefRuns(indices),
        renderBlockRefs(Array.from(state.prune.messages.resolvableBlockIds)),
    ].filter((section) => section.length > 0)

    if (sections.length === 0) {
        return "No refs are valid right now."
    }

    return `Valid refs right now: ${sections.join(", ")}.`
}

export function resolveMessages(
    args: CompressMessageToolArgs,
    searchContext: SearchContext,
    state: SessionState,
    config: PluginConfig,
): ResolvedMessageCompressionsResult {
    const issues: SkippedIssue[] = []
    const plans: ResolvedMessageCompression[] = []
    const seenMessageIds = new Set<string>()

    for (const entry of args.content) {
        const normalizedMessageId = entry.messageId.trim()
        if (seenMessageIds.has(normalizedMessageId)) {
            issues.push({ kind: "duplicate", messageId: normalizedMessageId })
            continue
        }

        try {
            const plan = resolveMessage(
                {
                    ...entry,
                    messageId: normalizedMessageId,
                },
                searchContext,
                state,
                config,
            )
            seenMessageIds.add(plan.entry.messageId)
            plans.push(plan)
        } catch (error: any) {
            if (error instanceof SoftIssue) {
                issues.push({
                    kind: error.kind,
                    messageId: error.messageId,
                    detail: error.detail,
                })
                continue
            }

            throw error
        }
    }

    return {
        plans,
        skippedIssues: groupSkippedIssues(issues),
        skippedCount: issues.length,
    }
}

function resolveMessage(
    entry: CompressMessageEntry,
    searchContext: SearchContext,
    state: SessionState,
    config: PluginConfig,
): ResolvedMessageCompression {
    if (entry.messageId.toUpperCase() === "BLOCKED") {
        throw new SoftIssue("blocked", "BLOCKED", "protected message")
    }

    const parsed = parseBoundaryId(entry.messageId)

    if (!parsed) {
        throw new SoftIssue("invalid-format", entry.messageId, "invalid format")
    }

    if (parsed.kind === "compressed-block") {
        throw new SoftIssue("block-id", entry.messageId, "block ID used")
    }

    const messageId = state.messageIds.byRef.get(parsed.ref)
    const rawMessage = messageId ? searchContext.rawMessagesById.get(messageId) : undefined
    if (
        !messageId ||
        !rawMessage ||
        !searchContext.rawIndexById.has(messageId) ||
        isIgnoredUserMessage(rawMessage)
    ) {
        throw new SoftIssue(
            "not-in-context",
            parsed.ref,
            "not in context",
            describeValidRefs(state, searchContext),
        )
    }

    const { startReference, endReference } = resolveBoundaryIds(
        searchContext,
        state,
        parsed.ref,
        parsed.ref,
    )
    const selection = resolveSelection(searchContext, startReference, endReference)

    if (isProtectedUserMessage(config, rawMessage)) {
        throw new SoftIssue("protected", parsed.ref, "protected message")
    }

    const pruneEntry = state.prune.messages.byMessageId.get(messageId)
    if (pruneEntry && pruneEntry.activeBlockIds.length > 0) {
        throw new SoftIssue("already-compressed", parsed.ref, "already compressed")
    }

    return {
        entry: {
            messageId: parsed.ref,
            topic: entry.topic,
            summary: entry.summary,
        },
        selection,
        anchorMessageId: resolveAnchorMessageId(startReference),
    }
}
