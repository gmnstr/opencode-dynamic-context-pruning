import type { RuntimePrompts } from "./store"
export type { PromptStore, RuntimePrompts } from "./store"

function stripLegacyInlineComments(content: string): string {
    return content.replace(/^[ \t]*\/\/.*?\/\/[ \t]*$/gm, "")
}

function appendSystemOverlays(systemPrompt: string, overlays: string[]): string {
    return [systemPrompt, ...overlays].filter(Boolean).join("\n\n")
}

export function renderSystemPrompt(
    prompts: RuntimePrompts,
    manual?: boolean,
    subagent?: boolean,
): string {
    const overlays: string[] = []
    if (manual) {
        overlays.push(prompts.manualOverlay.trim())
    }

    if (subagent) {
        overlays.push(prompts.subagentOverlay.trim())
    }

    const strippedSystem = stripLegacyInlineComments(prompts.system).trim()
    const withOverlays = appendSystemOverlays(strippedSystem, overlays)
    return withOverlays.replace(/\n([ \t]*\n)+/g, "\n\n").trim()
}
