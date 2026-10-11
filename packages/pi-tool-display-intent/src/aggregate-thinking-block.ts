import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth } from "@earendil-works/pi-tui";
import type { AggregateViewportRun } from "./aggregate-viewport.js";

/** Thinking of one assistant turn inside a Run segment, with the calls it led to. */
export interface AggregateThinkingPart {
	turnId: string;
	/** The assistant message; its text is joined only when the block is expanded. */
	source: unknown;
	calls: string[];
	/** Layout cache: rebuilt only when this turn's thinking size or the width changes. */
	cache?: { size: number; width: number; lines: string[] };
}

function thinkingBlocks(message: unknown): { thinking: string }[] {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return [];
	return content.filter((block): block is { thinking: string } => {
		const record = block as { type?: unknown; thinking?: unknown } | undefined;
		return record?.type === "thinking" && typeof record.thinking === "string" && /\S/.test(record.thinking);
	});
}

/** Content-type detection, never text matching. O(blocks), not O(characters). */
export function hasThinkingText(message: unknown): boolean {
	return thinkingBlocks(message).length > 0;
}

export function thinkingSize(message: unknown): number {
	return thinkingBlocks(message).reduce((total, block) => total + block.thinking.length, 0);
}

export function thinkingTextOf(message: unknown): string {
	return thinkingBlocks(message).map((block) => block.thinking.trim()).join("\n\n");
}

export type AggregateThinkingStatus = "active" | "done" | "interrupted" | "failed";

/** One folded block per Run segment: below the Run, above the answer. */
export interface AggregateThinkingBlock {
	segmentId: string;
	parts: AggregateThinkingPart[];
	status: AggregateThinkingStatus;
	expanded: boolean;
	run: AggregateViewportRun;
	toggle(): void;
}

interface Theme {
	fg(color: string, text: string): string;
}

const STATUS_COLOR: Record<AggregateThinkingStatus, string> = {
	active: "warning", done: "success", interrupted: "muted", failed: "error",
};
const STATUS_SUFFIX: Record<AggregateThinkingStatus, string> = {
	active: "", done: "", interrupted: " · interrupted", failed: " · failed",
};

function paint(theme: Theme, color: string, text: string): string {
	try { return theme.fg(color, text); } catch { return text; }
}

function renderPartBody(part: AggregateThinkingPart, width: number, theme: Theme): string[] {
	const size = thinkingSize(part.source);
	// Streaming only appends; equal size means an unchanged body, so cache hits never join text.
	if (part.cache?.size === size && part.cache.width === width) return part.cache.lines;
	const text = thinkingTextOf(part.source);
	let lines: string[];
	try {
		lines = new Markdown(text, 0, 0, getMarkdownTheme(), {
			color: (value: string) => paint(theme, "thinkingText", value),
			italic: true,
		}).render(width);
	} catch {
		lines = text.split("\n");
	}
	while (lines.length && !lines[0]!.trim()) lines.shift();
	while (lines.length && !lines.at(-1)!.trim()) lines.pop();
	part.cache = { size, width, lines };
	return lines;
}

/** Static status dot; no timer. Folded blocks never lay out their body. */
export function renderAggregateThinkingBlock(block: AggregateThinkingBlock, width: number, theme: Theme): string[] {
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	if (safeWidth === 0) return [];
	const count = block.parts.length > 1 ? paint(theme, "muted", ` · ${block.parts.length} parts`) : "";
	const suffix = STATUS_SUFFIX[block.status] ? paint(theme, STATUS_COLOR[block.status], STATUS_SUFFIX[block.status]) : "";
	const title = `${paint(theme, STATUS_COLOR[block.status], "●")} ${paint(theme, "toolTitle", "Thinking")}${count}${suffix} ${paint(theme, "muted", block.expanded ? "▾" : "▸")}`;
	const lines = [truncateToWidth(title, safeWidth, "…")];
	if (!block.expanded) return lines;
	const rail = paint(theme, "muted", "│");
	const bodyWidth = Math.max(1, safeWidth - 2);
	block.parts.forEach((part, index) => {
		if (index > 0) lines.push(truncateToWidth(`${rail} ${paint(theme, "muted", "┄".repeat(Math.min(12, bodyWidth)))}`, safeWidth, "…"));
		for (const line of renderPartBody(part, bodyWidth, theme)) lines.push(truncateToWidth(`${rail} ${line}`, safeWidth, "…"));
		if (part.calls.length) {
			const shown = part.calls.slice(0, 3).join(" · ");
			const more = part.calls.length > 3 ? ` · +${part.calls.length - 3}` : "";
			lines.push(truncateToWidth(`${rail} ${paint(theme, "muted", `→ ${shown}${more}`)}`, safeWidth, "…"));
		}
	});
	lines.push(truncateToWidth(paint(theme, "muted", "└"), safeWidth, "…"));
	return lines;
}

/** Insert below a rendered Run block, keeping exactly one trailing blank. Returns the title row. */
export function appendThinkingBlock(lines: string[], block: readonly string[]): number {
	const isBlank = (line: string | undefined) => line !== undefined && !line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
	while (lines.length && isBlank(lines.at(-1))) lines.pop();
	const titleRow = lines.length;
	lines.push(...block, "");
	return titleRow;
}
