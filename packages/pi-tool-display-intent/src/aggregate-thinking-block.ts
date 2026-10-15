import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AggregateClickRegion } from "./aggregate-interaction.js";
import { toggleAggregateViewportRun, type AggregateViewportRun } from "./aggregate-viewport.js";

/** Thinking of one assistant turn inside a Run segment, with the calls it led to. */
export interface AggregateThinkingPart {
	turnId: string;
	/** The assistant message; its text is joined only when the part is expanded. */
	source: unknown;
	calls: string[];
	/** Each part of a multi-part block folds on its own; refreshed on every block read. */
	status: AggregateThinkingStatus;
	expanded: boolean;
	run: AggregateViewportRun;
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

function callsText(part: AggregateThinkingPart): string {
	if (!part.calls.length) return "";
	const more = part.calls.length > 3 ? ` · +${part.calls.length - 3}` : "";
	return `→ ${part.calls.slice(0, 3).join(" · ")}${more}`;
}

function statusDot(theme: Theme, status: AggregateThinkingStatus): string {
	return paint(theme, STATUS_COLOR[status], "●");
}

/** `● Part N · → calls · interrupted ▸`: calls shrink first so the fold marker stays visible. */
function partTitle(part: AggregateThinkingPart, index: number, width: number, theme: Theme): string {
	const head = `${statusDot(theme, part.status)} ${paint(theme, "toolTitle", `Part ${index + 1}`)}`;
	const suffix = STATUS_SUFFIX[part.status] ? paint(theme, STATUS_COLOR[part.status], STATUS_SUFFIX[part.status]) : "";
	const tail = `${suffix} ${paint(theme, "muted", part.expanded ? "▾" : "▸")}`;
	const calls = callsText(part);
	const room = width - visibleWidth(head) - visibleWidth(tail) - 3;
	const middle = calls && room > 1 ? paint(theme, "muted", ` · ${truncateToWidth(calls, room, "…")}`) : "";
	return truncateToWidth(`${head}${middle}${tail}`, width, "…");
}

export interface RenderedThinkingBlock {
	lines: string[];
	/** Rows of clickable part titles, relative to `lines`; `end` is exclusive. */
	parts: Array<{ part: AggregateThinkingPart; row: number; end: number }>;
}

/**
 * Static status dots; no timer. A folded block or part never lays out its body.
 * Multi-part blocks list part titles that fold independently; one part opens directly.
 */
export function renderAggregateThinkingBlock(block: AggregateThinkingBlock, width: number, theme: Theme): RenderedThinkingBlock {
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	if (safeWidth === 0) return { lines: [], parts: [] };
	const count = block.parts.length > 1 ? paint(theme, "muted", ` · ${block.parts.length} parts`) : "";
	const suffix = STATUS_SUFFIX[block.status] ? paint(theme, STATUS_COLOR[block.status], STATUS_SUFFIX[block.status]) : "";
	const title = `${statusDot(theme, block.status)} ${paint(theme, "toolTitle", "Thinking")}${count}${suffix} ${paint(theme, "muted", block.expanded ? "▾" : "▸")}`;
	const lines = [truncateToWidth(title, safeWidth, "…")];
	const parts: RenderedThinkingBlock["parts"] = [];
	if (!block.expanded) return { lines, parts };
	const rail = paint(theme, "muted", "│");
	const row = (text: string) => lines.push(truncateToWidth(`${rail} ${text}`, safeWidth, "…"));
	const single = block.parts.length === 1 ? block.parts[0] : undefined;
	if (single) {
		for (const line of renderPartBody(single, Math.max(1, safeWidth - 2), theme)) row(line);
		const calls = callsText(single);
		if (calls) row(paint(theme, "muted", calls));
	} else {
		const innerWidth = Math.max(1, safeWidth - 2);
		block.parts.forEach((part, index) => {
			const start = lines.length;
			row(partTitle(part, index, innerWidth, theme));
			if (part.expanded) for (const line of renderPartBody(part, Math.max(1, safeWidth - 4), theme)) row(`${rail} ${line}`);
			parts.push({ part, row: start, end: lines.length });
		});
	}
	lines.push(truncateToWidth(paint(theme, "muted", "└"), safeWidth, "…"));
	return { lines, parts };
}

export interface ThinkingTargets {
	regions: AggregateClickRegion[];
	viewports: Array<{ run: AggregateViewportRun; titleRow: number; endRow: number }>;
}

/** Click targets and viewport anchors for a block painted at `top` within `component`. */
export function thinkingTargets(block: AggregateThinkingBlock, rendered: RenderedThinkingBlock, top: number, component: object): ThinkingTargets {
	const end = top + rendered.lines.length;
	const regions: AggregateClickRegion[] = [{ startRow: top, endRow: top + 1, onClick: () => toggleAggregateViewportRun(component, block.run) }];
	const viewports: ThinkingTargets["viewports"] = [{ run: block.run, titleRow: top, endRow: end }];
	for (const { part, row, end: partEnd } of rendered.parts) {
		regions.push({ startRow: top + row, endRow: top + row + 1, onClick: () => toggleAggregateViewportRun(component, part.run) });
		viewports.push({ run: part.run, titleRow: top + row, endRow: top + partEnd });
	}
	return { regions, viewports };
}

/** Insert below a rendered Run block, keeping exactly one trailing blank. Returns the title row. */
export function appendThinkingBlock(lines: string[], block: readonly string[]): number {
	const isBlank = (line: string | undefined) => line !== undefined && !line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
	while (lines.length && isBlank(lines.at(-1))) lines.pop();
	const titleRow = lines.length;
	lines.push(...block, "");
	return titleRow;
}
