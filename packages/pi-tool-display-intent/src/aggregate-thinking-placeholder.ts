import {
	AssistantMessageComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	AGGREGATE_ASSISTANT_MARK,
	aggregateAssistantFrameId,
	applyAggregateGroupFrame,
	attachExpandedAggregateSummary,
	attachRunThinking,
	framePrefixForEdge,
	renderExpandedAggregateSummary,
	resolveAggregateProjection,
	resolveAggregateRenderTheme,
	type AggregateProjection,
} from "./aggregate-activity.js";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { patchAggregateMouseHandling, recordAggregateClickRegions, recordAggregateNativeRegion, releaseAggregateClickRegions, restoreAggregateMouseHandling, type AggregateClickRegion } from "./aggregate-interaction.js";
import { hasPromptZoneStart, markPromptZone, stripPromptZone } from "./prompt-zone-markers.js";
import { renderAggregateThinkingBlock, type AggregateThinkingBlock } from "./aggregate-thinking-block.js";
import { toggleAggregateViewportRun } from "./aggregate-viewport.js";

interface PatchableAssistantMessage {
	render(width: number): string[];
	setExpanded?(expanded: boolean): void;
	updateContent?(message: unknown, isStreaming?: boolean): void;
	invalidate?: () => void;
	hideThinkingBlock?: unknown;
	hiddenThinkingLabel?: unknown;
	lastMessage?: unknown;
	[AGGREGATE_ASSISTANT_EXPANDED_KEY]?: boolean;
	[AGGREGATE_ASSISTANT_FRAME_ID_KEY]?: string;
}

interface PatchableAssistantPrototype {
	render(width: number): string[];
	setExpanded?(expanded: boolean): void;
	updateContent?: PatchableAssistantMessage["updateContent"];
	invalidate?: () => void;
	[AGGREGATE_THINKING_PATCH_KEY]?: AggregateThinkingPatchState;
	[LEGACY_THINKING_PATCH_KEY]?: AggregateThinkingPatchState;
}

interface AggregateThinkingPatchState {
	owner: typeof THINKING_MODULE;
	releaseOwner(): void;
	renderImpl: (this: PatchableAssistantMessage, width: number) => string[];
	onExpanded?: (this: PatchableAssistantMessage, expanded: boolean) => void;
	onContentChanged?: (this: PatchableAssistantMessage) => void;
	originalUpdateContent?: PatchableAssistantMessage["updateContent"];
	patchedUpdateContent: NonNullable<PatchableAssistantMessage["updateContent"]>;
	originalInvalidate?: () => void;
	patchedInvalidate: () => void;
	originalRender: (this: PatchableAssistantMessage, width: number) => string[];
	patchedRender: (this: PatchableAssistantMessage, width: number) => string[];
	originalSetExpanded?: (this: PatchableAssistantMessage, expanded: boolean) => void;
	patchedSetExpanded: (this: PatchableAssistantMessage, expanded: boolean) => void;
	isAggregateEnabled: () => boolean;
}

const AGGREGATE_THINKING_PATCH_KEY = Symbol.for(
	"pi-tool-display-intent.aggregate-thinking-placeholder.v2",
);
const LEGACY_THINKING_PATCH_KEY = Symbol.for("pi-tool-display-intent.aggregate-thinking-placeholder.v1");
const THINKING_MODULE = { retired: false };
const AGGREGATE_ASSISTANT_EXPANDED_KEY = Symbol.for(
	"pi-tool-display-intent.aggregate-assistant-expanded.v1",
);
const AGGREGATE_ASSISTANT_FRAME_ID_KEY = Symbol.for(
	"pi-tool-display-intent.aggregate-assistant-frame-id.v1",
);
const DEFAULT_HIDDEN_THINKING_LABEL = "Thinking...";
const OSC_SEQUENCE_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_SEQUENCE_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;
const registeredApis = new WeakSet<ExtensionAPI>();
let thinkingOwner: ExtensionAPI | undefined;

// One layout per component; no transcript-sized string keys or retained components.
let bodyLayouts = new WeakMap<PatchableAssistantMessage, {
	width: number;
	stripThinking: boolean;
	label: string;
	hostMarkedPromptZone: boolean;
	lines: string[];
}>();

function invalidateDecoration(component: PatchableAssistantMessage): void {
	const body = bodyLayouts.get(component);
	try { component.invalidate?.(); } catch { /* Disposed transcript component. */ }
	finally {
		// Context/frames changed, not the message, theme or Markdown layout.
		if (body) bodyLayouts.set(component, body);
	}
}

function toRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function visibleText(line: string): string {
	return line
		.replace(OSC_SEQUENCE_PATTERN, "")
		.replace(ANSI_SEQUENCE_PATTERN, "")
		.replace(/\s+/g, " ")
		.trim();
}

function resolveHiddenThinkingLabel(component: unknown): string {
	const label = toRecord(component).hiddenThinkingLabel;
	if (typeof label !== "string") return DEFAULT_HIDDEN_THINKING_LABEL;
	const normalized = label.replace(/\s+/g, " ").trim();
	return normalized || DEFAULT_HIDDEN_THINKING_LABEL;
}

export function stripCollapsedThinkingPlaceholderLines(
	lines: readonly string[],
	label = DEFAULT_HIDDEN_THINKING_LABEL,
): string[] {
	const normalizedLabel = label.replace(/\s+/g, " ").trim() || DEFAULT_HIDDEN_THINKING_LABEL;
	const kept = lines.filter((line) => visibleText(line) !== normalizedLabel);
	return trimBlankEdges(kept);
}

export function trimBlankEdges(lines: readonly string[]): string[] {
	const kept = [...lines];
	while (kept.length > 0 && visibleText(kept[0]!) === "") kept.shift();
	while (kept.length > 0 && visibleText(kept[kept.length - 1]!) === "") kept.pop();
	return kept;
}

export function shouldHideCollapsedThinkingPlaceholder(component: unknown): boolean {
	const instance = toRecord(component);
	if (instance.hideThinkingBlock !== true) return false;
	const message = toRecord(instance.lastMessage);
	const content = message.content;
	if (!Array.isArray(content)) return false;

	return content.some((blockValue) => {
		const block = toRecord(blockValue);
		return block.type === "thinking" && typeof block.thinking === "string" && Boolean(block.thinking.trim());
	});
}

function messageContentBlocks(message: unknown): unknown[] {
	const content = toRecord(message).content;
	return Array.isArray(content) ? content : [];
}

function messageHasNarrationText(message: unknown): boolean {
	return messageContentBlocks(message).some((entry) => {
		const block = toRecord(entry);
		return block.type === "text" && typeof block.text === "string" && Boolean(block.text.trim());
	});
}

export function omitThinkingContentBlocks(message: unknown): unknown {
	if (!message || typeof message !== "object") return message;
	const content = messageContentBlocks(message);
	const next = content.filter((entry) => toRecord(entry).type !== "thinking");
	if (next.length === content.length) return message;
	return { ...toRecord(message), content: next };
}

function renderWithoutThinkingBlocks(
	component: PatchableAssistantMessage,
	originalRender: (this: PatchableAssistantMessage, width: number) => string[],
	width: number,
): string[] {
	const originalMessage = component.lastMessage;
	const stripped = omitThinkingContentBlocks(originalMessage);
	if (stripped === originalMessage || typeof component.updateContent !== "function") {
		return originalRender.call(component, width);
	}
	try {
		component.updateContent(stripped);
		return originalRender.call(component, width);
	} finally {
		try {
			component.updateContent(originalMessage);
		} catch {
			// Restore must stay fail-open so a later invalidate can rebuild.
		}
	}
}

export function isInterimAssistantNarration(component: unknown): boolean {
	const message = toRecord(toRecord(component).lastMessage);
	const stopReason = message.stopReason;
	if (stopReason === "error" || stopReason === "aborted" || stopReason === "length" || stopReason === "stop") {
		return false;
	}
	if (stopReason !== "toolUse" && !messageContentBlocks(message).some((blockValue) => toRecord(blockValue).type === "toolCall")) {
		return false;
	}
	const projection = resolveAggregateProjection(
		undefined,
		aggregateAssistantFrameId(message),
		firstToolCallId(message),
	);
	return projection?.shouldFrameAssistantNarration(message) === true;
}

/** @deprecated Use shouldHideCollapsedThinkingPlaceholder. */
export function isPureHiddenThinkingMessage(component: unknown): boolean {
	return shouldHideCollapsedThinkingPlaceholder(component);
}

function isExpanded(component: PatchableAssistantMessage, fallback = false): boolean {
	return component[AGGREGATE_ASSISTANT_EXPANDED_KEY] ?? fallback;
}

function assistantFrameId(component: PatchableAssistantMessage): string {
	const existing = component[AGGREGATE_ASSISTANT_FRAME_ID_KEY];
	if (existing) return existing;
	const id = aggregateAssistantFrameId(component.lastMessage) ?? `assistant:${++assistantFrameSequence}`;
	component[AGGREGATE_ASSISTANT_FRAME_ID_KEY] = id;
	return id;
}

let assistantFrameSequence = 0;

function firstToolCallId(message: unknown): string | undefined {
	const content = toRecord(message).content;
	if (!Array.isArray(content)) return undefined;
	for (const entry of content) {
		const block = toRecord(entry);
		if (block.type === "toolCall" && typeof block.id === "string" && block.id.trim()) return block.id;
	}
	return undefined;
}

function decorateAssistantLines(
	lines: readonly string[],
	theme: { fg(color: string, text: string): string },
): string[] {
	const firstVisible = lines.findIndex((line) => visibleText(line) !== "");
	if (firstVisible < 0) return [...lines];
	let mark = AGGREGATE_ASSISTANT_MARK;
	try {
		mark = theme.fg("muted", AGGREGATE_ASSISTANT_MARK);
	} catch {
		// Public markdown fallbacks and unbound Pi theme helpers must not crash render.
	}
	const continuation = " ".repeat(visibleWidth(`${AGGREGATE_ASSISTANT_MARK} `));
	// Keep native left padding, and reserve the marker column on every row.
	// Only discard right-side fill: carrying Markdown's padded width into the
	// frame pins even a short first row to the terminal edge.
	return lines.map((line, index) => `${index === firstVisible ? `${mark} ` : continuation}${line.trimEnd()}`);
}

function getPrototype(): PatchableAssistantPrototype {
	return AssistantMessageComponent.prototype as unknown as PatchableAssistantPrototype;
}

/** Without a Run in its segment, the latest assistant message hosts the Thinking block. */
function turnThinking(
	component: PatchableAssistantMessage,
	projection: AggregateProjection | undefined,
	width: number,
): { block: AggregateThinkingBlock; lines: string[]; region: AggregateClickRegion } | undefined {
	const block = projection?.getTurnThinkingBlock(component.lastMessage);
	if (!block) return undefined;
	const lines = renderAggregateThinkingBlock(block, width, resolveAggregateRenderTheme(projection));
	if (!lines.length) return undefined;
	// Row 1: callers put the block below the native leading blank.
	return { block, lines, region: { startRow: 1, endRow: 2, onClick: () => toggleAggregateViewportRun(component, block.run) } };
}

export function patchAggregateThinkingPlaceholders(isAggregateEnabled: () => boolean): void {
	if (THINKING_MODULE.retired) return;
	const prototype = getPrototype();
	const legacy = prototype[LEGACY_THINKING_PATCH_KEY];
	if (legacy) {
		legacy.isAggregateEnabled = () => false;
		if (prototype.render === legacy.patchedRender) prototype.render = legacy.originalRender;
		if (prototype.setExpanded === legacy.patchedSetExpanded) prototype.setExpanded = legacy.originalSetExpanded;
	}
	const existing = prototype[AGGREGATE_THINKING_PATCH_KEY];
	if (existing && existing.owner !== THINKING_MODULE) existing.releaseOwner();
	patchAggregateMouseHandling(prototype);
	const state = existing ?? {} as AggregateThinkingPatchState;
	if (!existing) {
		state.originalRender = prototype.render as AggregateThinkingPatchState["originalRender"];
		state.originalSetExpanded = prototype.setExpanded;
		state.patchedRender = function(width) { return state.renderImpl.call(this, width); };
		state.patchedSetExpanded = function(expanded) {
			state.onExpanded?.call(this, expanded);
			state.originalSetExpanded?.call(this, expanded);
			try { this.invalidate?.(); } catch { /* Disposed transcript component. */ }
		};
	}
	// Also install these hooks when adopting a pre-cache patch after /reload.
	if (!state.patchedUpdateContent) {
		state.originalUpdateContent = prototype.updateContent;
		state.originalInvalidate = prototype.invalidate;
		state.patchedUpdateContent = function(message, isStreaming) {
			state.onContentChanged?.call(this);
			return state.originalUpdateContent?.call(this, message, isStreaming);
		};
		state.patchedInvalidate = function() {
			state.onContentChanged?.call(this);
			return state.originalInvalidate?.call(this);
		};
	}
	state.owner = THINKING_MODULE;
	state.releaseOwner = () => { THINKING_MODULE.retired = true; thinkingOwner = undefined; };
	state.isAggregateEnabled = isAggregateEnabled;
	state.onContentChanged = function() { bodyLayouts.delete(this); };
	state.onExpanded = function(expanded) {
		this[AGGREGATE_ASSISTANT_EXPANDED_KEY] = expanded === true;
		resolveAggregateProjection(undefined, aggregateAssistantFrameId(this.lastMessage), firstToolCallId(this.lastMessage))
			?.noteTimelineExpansion(expanded === true);
	};
	state.renderImpl = function renderAggregateAssistantMessage(width: number): string[] {
		releaseAggregateClickRegions(this);
		if (!state.isAggregateEnabled()) return state.originalRender.call(this, width);

		const hideThinking = this.hideThinkingBlock === true;
		const interim = isInterimAssistantNarration(this);
		const hasNarrationText = messageHasNarrationText(this.lastMessage);
		const stopReason = toRecord(this.lastMessage).stopReason;
		const toolCallId = firstToolCallId(this.lastMessage);
		const frameId = assistantFrameId(this);
		const projection = resolveAggregateProjection(undefined, frameId, toolCallId);
		// Thinking is never narration. With a projection, shown thinking moves to the
		// segment Thinking block and hidden thinking is dropped; without one, keep Pi's.
		const stripThinkingBody = hideThinking || projection !== undefined || interim || (stopReason === "stop" && hasNarrationText);
		// Native Markdown pads every row to the width it receives. Reserve the
		// frame and narration marker before layout, not by clipping padded rows
		// afterwards (which also turns blank lines into full-width ellipses).
		const narrationWidth = interim
			? Math.max(1, width - visibleWidth(`${framePrefixForEdge("start")}${AGGREGATE_ASSISTANT_MARK} `))
			: width;
		const label = resolveHiddenThinkingLabel(this);
		let body = bodyLayouts.get(this);
		if (!body || body.width !== narrationWidth || body.stripThinking !== stripThinkingBody || body.label !== label) {
			const lines = stripThinkingBody
				? renderWithoutThinkingBlocks(this, state.originalRender, narrationWidth)
				: state.originalRender.call(this, narrationWidth);
			const hostMarkedPromptZone = hasPromptZoneStart(lines);
			// Cache marker-free layout and host marking together; tool-call messages stay unmarked.
			body = { width: narrationWidth, stripThinking: stripThinkingBody, label, hostMarkedPromptZone,
				lines: stripCollapsedThinkingPlaceholderLines(hostMarkedPromptZone ? stripPromptZone(lines) : lines, label) };
			bodyLayouts.set(this, body);
		}
		const markHostPromptZone = (lines: string[]): string[] => body.hostMarkedPromptZone ? markPromptZone(lines) : lines;
		const next = body.lines;
		projection?.setThinkingShown(!hideThinking);
		projection?.connectContextRenderer(this.lastMessage, () => invalidateDecoration(this));
		const expanded = projection?.isMessageExpanded(this.lastMessage, isExpanded(this, projection?.isTimelineExpanded()))
			?? isExpanded(this);
		const trimmed = next;
		if (interim) {
			recordAggregateClickRegions(this, width, 0);
			if (!hasNarrationText || trimmed.length === 0 || !expanded) {
				projection?.markFrameContentVisible(frameId, false);
				if (!hasNarrationText || trimmed.length === 0) projection?.untrackFramedItem(frameId);
				else projection?.trackFramedItem(frameId, undefined, toolCallId);
				// Hidden narration only paints Thinking when its segment has no Run to host it.
				const fallback = turnThinking(this, projection, width);
				if (!fallback) return [];
				const lines = ["", ...fallback.lines, ""];
				recordAggregateClickRegions(this, width, lines.length, [fallback.region], { run: fallback.block.run, titleRow: 1 });
				return lines;
			}
			projection?.trackFramedItem(frameId, undefined, toolCallId);
			projection?.connectFrameRenderer(frameId, () => invalidateDecoration(this));
			projection?.markFrameContentVisible(frameId, true);
		}
		const contextLines = interim ? [] : (projection?.getAssistantContextLines(this.lastMessage, expanded) ?? [])
			.map((line) => truncateToWidth(`  ${resolveAggregateRenderTheme(projection).fg("muted", line)}`, Math.max(0, width), "…"));
		const ownThinking = interim ? undefined : turnThinking(this, projection, width);
		if (ownThinking) {
			// [Run] → Thinking → answer: no Run here, so the block sits above this body.
			const lines = ["", ...ownThinking.lines];
			const bodyTop = lines.length;
			if (trimmed.length) lines.push("", ...trimmed);
			lines.push(...contextLines);
			const viewport = { run: ownThinking.block.run, titleRow: 1 };
			// The separator row stands in for the native leading Spacer of the stripped body.
			if (trimmed.length) recordAggregateNativeRegion(this, width, lines.length, { left: 0, top: bodyTop, width, height: trimmed.length + 1 }, [ownThinking.region], viewport);
			else recordAggregateClickRegions(this, width, lines.length, [ownThinking.region], viewport);
			return toolCallId ? lines : markPromptZone(lines);
		}
		if (trimmed.length === 0) return markHostPromptZone(contextLines.length > 0 ? ["", ...contextLines] : []);
		if (!interim) {
			// Thinking-placeholder cleanup also trims Pi's leading Spacer(1).
			// Put that gap back after the user prompt or a passthrough tool.
			// Only the reply sitting under the Tools ledger omits it, so later
			// tools in the same user turn cannot steal the blank from earlier text.
			const stackedOnTools = projection?.assistantFollowsAggregateLedger(this.lastMessage) === true;
			const body = stackedOnTools || visibleText(next[0] ?? "") === "" ? next : ["", ...next];
			return markHostPromptZone([...body, ...contextLines]);
		}
		const theme = resolveAggregateRenderTheme(projection);
		const marked = decorateAssistantLines(trimmed, theme);
		const inner = projection?.framedItemFollowsTool(frameId) === true ? ["", ...marked] : marked;
		const edge = projection?.getFrameEdge(frameId) ?? "only";
		const framed = applyAggregateGroupFrame(inner, width, theme, edge);
		const run = projection?.getViewportRun(frameId);
		let lines = [...framed];
		let titleRow: number | undefined;
		const regions: AggregateClickRegion[] = [];
		if (projection?.shouldHostExpandedSummary(frameId)) {
			const headerView = projection.getSegmentView(frameId);
			if (headerView) {
				const header = renderExpandedAggregateSummary(headerView, width, theme);
				lines = attachExpandedAggregateSummary(header, framed);
				regions.push({ startRow: 1, endRow: 1 + header.length, onClick: () => projection.toggleGroupExpansionFromComponent(frameId, this) });
				titleRow = 1;
			}
		}
		const thinking = projection ? attachRunThinking(projection, frameId, true, lines, width, regions, this) : undefined;
		const runRegion = run ? { run, ...(titleRow !== undefined ? { titleRow } : {}), ...(thinking ? { endRow: thinking.titleRow } : {}) } : undefined;
		const viewports = [...(runRegion ? [runRegion] : []), ...(thinking ? [thinking.viewport] : [])];
		recordAggregateClickRegions(this, width, lines.length, regions, viewports.length ? viewports : undefined);
		return markHostPromptZone(lines);
	};
	Object.defineProperty(prototype, AGGREGATE_THINKING_PATCH_KEY, {
		configurable: true,
		value: state,
	});
	if (!existing) {
		prototype.render = state.patchedRender;
		prototype.setExpanded = state.patchedSetExpanded;
	}
	if (state.originalUpdateContent && prototype.updateContent === state.originalUpdateContent) prototype.updateContent = state.patchedUpdateContent;
	if (state.originalInvalidate && prototype.invalidate === state.originalInvalidate) prototype.invalidate = state.patchedInvalidate;
}

export function restoreAggregateThinkingPlaceholders(): void {
	const prototype = getPrototype();
	const state = prototype[AGGREGATE_THINKING_PATCH_KEY];
	if (state && state.owner !== THINKING_MODULE) return;
	restoreAggregateMouseHandling(prototype);
	bodyLayouts = new WeakMap();
	if (!state) return;
	state.renderImpl = state.originalRender;
	state.onExpanded = undefined;
	state.onContentChanged = undefined;
	if (prototype.updateContent === state.patchedUpdateContent) prototype.updateContent = state.originalUpdateContent;
	if (prototype.invalidate === state.patchedInvalidate) prototype.invalidate = state.originalInvalidate;
	if (prototype.render === state.patchedRender) {
		prototype.render = state.originalRender;
		if (prototype.setExpanded === state.patchedSetExpanded) {
			if (state.originalSetExpanded) prototype.setExpanded = state.originalSetExpanded;
			else delete prototype.setExpanded;
		}
		delete prototype[AGGREGATE_THINKING_PATCH_KEY];
		return;
	}
	// A later wrapper still references patchedRender. Disable our behavior but
	// retain the state so a subsequent reload can safely update its predicate.
	state.isAggregateEnabled = () => false;
}

export function registerAggregateThinkingPlaceholderSuppression(
	pi: ExtensionAPI,
	isAggregateEnabled: () => boolean,
): void {
	if (registeredApis.has(pi) || THINKING_MODULE.retired) return;
	registeredApis.add(pi);
	const bind = (hasUI: boolean | undefined) => {
		if (hasUI === false || THINKING_MODULE.retired || (thinkingOwner && thinkingOwner !== pi)) return;
		thinkingOwner = pi;
		patchAggregateThinkingPlaceholders(isAggregateEnabled);
	};
	pi.on("session_shutdown", async () => {
		registeredApis.delete(pi);
		if (thinkingOwner !== pi) return;
		thinkingOwner = undefined;
		restoreAggregateThinkingPlaceholders();
	});
	pi.on("session_start", async (_event, ctx) => bind(ctx?.hasUI));
	pi.on("before_agent_start", async (_event, ctx) => bind(ctx?.hasUI));
}
