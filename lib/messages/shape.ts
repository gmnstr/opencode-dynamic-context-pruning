import type { WithParts } from "../state"

export function isMessageWithInfo(message: unknown): message is WithParts {
    if (!message || typeof message !== "object") {
        return false
    }

    const info = (message as any).info
    const parts = (message as any).parts
    if (!info || typeof info !== "object") {
        return false
    }

    return (
        typeof info.id === "string" &&
        info.id.length > 0 &&
        typeof info.sessionID === "string" &&
        info.sessionID.length > 0 &&
        (info.role === "user" || info.role === "assistant") &&
        info.time &&
        typeof info.time === "object" &&
        typeof info.time.created === "number" &&
        Array.isArray(parts)
    )
}

export function filterProcessableMessages(messages: unknown): WithParts[] {
    if (!Array.isArray(messages)) {
        return []
    }

    return messages.filter(isMessageWithInfo)
}
