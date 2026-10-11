import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import { AggregateProjection, patchAggregateToolExecutions, registerAggregateProjectionEvents, restoreAggregateToolExecutions } from "../src/aggregate-activity.ts";
import { patchAggregateThinkingPlaceholders, restoreAggregateThinkingPlaceholders } from "../src/aggregate-thinking-placeholder.ts";
import { Rows, fullscreen } from "./helpers/aggregate-terminal.ts";

// Status colour is the only state signal of the static dot; keep it visible in plain text.
const marked = { fg: (color: string, text: string) => text === "●" ? `●<${color}>` : text, bold: (text: string) => text };
const clean = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const usage = (n: number) => ({ input: n, output: 10, cacheRead: 0, cacheWrite: 0 });
const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp });
const call = (id: string, turn: string, timestamp: number, thinking?: string, extra: Record<string, unknown> = {}) => ({
	role: "assistant", id: turn, timestamp, stopReason: "toolUse", usage: usage(timestamp),
	content: [...(thinking ? [{ type: "thinking", thinking }] : []), { type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } }],
	...extra,
});
const answer = (turn: string, timestamp: number, text: string, thinking?: string) => ({
	role: "assistant", id: turn, timestamp, stopReason: "stop", usage: usage(timestamp),
	content: [...(thinking ? [{ type: "thinking", thinking }] : []), { type: "text", text }],
});
const result = (id: string, timestamp: number) => ({ role: "toolResult", toolCallId: id, toolName: "read", timestamp, isError: false, content: [{ type: "text", text: `${id} body` }] });
const entries = (messages: unknown[]) => messages.map((message, i) => ({ type: "message", id: `entry-${i}`, message }));

function tool(id: string) {
	return new ToolExecutionComponent("read", id, { path: `${id}.ts` }, {}, {
		name: "read", label: "read", description: "read", parameters: { type: "object", properties: {} },
		execute() { throw new Error("Rendering must not execute tools"); },
		renderCall: () => new Text(id, 0, 0), renderResult: () => new Text(id, 0, 0),
	} as never, { requestRender() {} } as never, process.cwd());
}

/** Real Pi components in transcript order; `hide` is Pi's hideThinkingBlock setting. */
function transcript(p: AggregateProjection, messages: any[], hide = false, live = true) {
	const root = new Container();
	const assistants: AssistantMessageComponent[] = [];
	for (const message of messages) {
		if (live) {
			if (message.role === "user") p.ingestUserMessage(message);
			else if (message.role === "assistant") p.ingestAssistantMessage(message);
			else p.ingestToolResult(message);
		}
		if (message.role === "user") {
			root.addChild(new Spacer(1));
			root.addChild(new UserMessageComponent(message.content));
		} else if (message.role === "assistant") {
			const component = new AssistantMessageComponent(message, hide);
			assistants.push(component);
			root.addChild(component);
			for (const block of message.content) if (block.type === "toolCall") root.addChild(tool(block.id));
		}
	}
	return { root, assistants };
}

function setup() {
	initTheme("dark", false);
	const p = new AggregateProjection(() => false, () => "flat");
	p.setRenderTheme(marked);
	patchAggregateToolExecutions(p);
	patchAggregateThinkingPlaceholders(() => true);
	return p;
}
function teardown() {
	restoreAggregateThinkingPlaceholders();
	restoreAggregateToolExecutions();
}
const order = (text: string, ...needles: string[]) => {
	let from = 0;
	for (const needle of needles) {
		const at = text.indexOf(needle, from);
		assert.ok(at >= 0, `expected ${JSON.stringify(needle)} after offset ${from} for order ${JSON.stringify(needles)} in:\n${text}`);
		from = at + needle.length;
	}
};
const count = (text: string, needle: string) => text.split(needle).length - 1;

const runMessages = [
	user("request", 100),
	call("a", "turn-a", 110, "plan **A**"), result("a", 120),
	call("b", "turn-b", 130, "plan B"), result("b", 140),
	answer("final", 150, "done", "conclude"),
];

for (const live of [true, false]) test(`${live ? "live" : "history"}: one segment Thinking block sits below the Run and above the answer`, () => {
	const p = setup();
	try {
		if (!live) p.rebuild(entries(runMessages));
		const { root } = transcript(p, runMessages, false, live);
		for (const width of [60, 100]) {
			const folded = clean(root.render(width));
			order(folded, "Run (2 calls", "●<success> Thinking · 3 parts ▸", "done");
			assert.equal(count(folded, "Thinking"), 1, "one block per Run segment");
			assert.doesNotMatch(folded, /plan|conclude/, "folded thinking never paints its text");
		}

		// Ctrl+O expands only the Run; the block moves to the Run end and stays folded.
		p.noteTimelineExpansion(true);
		const expandedRun = clean(root.render(100));
		order(expandedRun, "Read(a.ts)", "Read(b.ts)", "Thinking · 3 parts ▸", "done");
		assert.doesNotMatch(expandedRun, /plan|conclude/, "an expanded Run never contains thinking");
		p.noteTimelineExpansion(false);

		// The block opens independently, in time order, annotated with the calls each part led to.
		const segment = p.getRunThinkingBlock("b", false)!;
		segment.toggle();
		const open = clean(root.render(100));
		order(open, "Run (2 calls", "Thinking · 3 parts ▾", "plan A", "→ Read(a.ts)", "plan B", "→ Read(b.ts)", "conclude", "└", "done");
		assert.match(open, /Run \(2 calls[^\n]*/);
		assert.doesNotMatch(open, /\*\*A\*\*/, "thinking renders as Markdown");

		p.noteTimelineExpansion(true);
		const both = clean(root.render(100));
		order(both, "Read(a.ts)", "Read(b.ts)", "Thinking · 3 parts ▾", "plan A", "conclude", "done");
		const runEnd = both.indexOf("└ ●<success> Read(b.ts)");
		assert.ok(runEnd >= 0 && both.indexOf("plan A") > runEnd, "thinking is not interleaved with Run rows");
		p.noteTimelineExpansion(false);
		assert.match(clean(root.render(100)), /Thinking · 3 parts ▾/, "Ctrl+O does not fold Thinking");
	} finally { teardown(); }
});

test("without a Run the block sits above the answer; hideThinkingBlock removes it entirely", () => {
	const p = setup();
	try {
		const messages = [user("hi", 100), answer("reply", 110, "the answer", "secret reasoning")];
		const { root, assistants } = transcript(p, messages, true);
		const hidden = clean(root.render(80));
		assert.match(hidden, /the answer/);
		assert.doesNotMatch(hidden, /Thinking|secret reasoning/, "Pi's hidden-thinking setting wins");

		assistants[0]!.setHideThinkingBlock(false);
		const shown = clean(root.render(80));
		order(shown, "●<success> Thinking ▸", "the answer");
		assert.doesNotMatch(shown, /secret reasoning/);
		assert.doesNotMatch(shown, /parts/, "a single part has no count");

		assistants[0]!.setHideThinkingBlock(true);
		assert.doesNotMatch(clean(root.render(80)), /Thinking/);
	} finally { teardown(); }
});

test("hideThinkingBlock also removes the block from Run hosts", () => {
	const p = setup();
	try {
		const { root } = transcript(p, runMessages, true);
		const text = clean(root.render(100));
		assert.match(text, /Run \(2 calls/);
		assert.doesNotMatch(text, /Thinking|plan|conclude/);
	} finally { teardown(); }
});

test("steer splits Thinking with the Run: each segment keeps its own block", () => {
	const p = setup();
	try {
		const messages = [
			user("request", 100), call("a", "turn-a", 110, "before steer"), result("a", 120),
			user("steer now", 130), call("b", "turn-b", 140, "after steer"), result("b", 150),
			answer("final", 160, "done", "wrap up"),
		];
		const { root } = transcript(p, messages);
		const text = clean(root.render(100));
		order(text, "Run (1 call", "●<success> Thinking ▸", "steer now", "Run (1 call", "Thinking · 2 parts ▸", "done");
		assert.equal(count(text, "Thinking"), 2);
		p.getRunThinkingBlock("a", false)!.toggle();
		const open = clean(root.render(100));
		order(open, "before steer", "steer now", "Thinking · 2 parts ▸");
		assert.doesNotMatch(open, /after steer|wrap up/, "segments open independently");
	} finally { teardown(); }
});

test("static status: yellow while thinking, green at thinking_end, never green when interrupted", async () => {
	const p = setup();
	const handlers = new Map<string, (event: any, ctx?: any) => unknown>();
	registerAggregateProjectionEvents({ on(name: string, cb: any) { handlers.set(name, cb); } } as unknown as ExtensionAPI, p, { doneSettleDelayMs: 0 });
	try {
		const first = { role: "assistant", id: "t1", timestamp: 110, content: [{ type: "thinking", thinking: "hmm" }] };
		const { root } = transcript(p, [user("request", 100)]);
		await handlers.get("message_start")!({ message: first });
		const component = new AssistantMessageComponent(first as never, false);
		root.addChild(component);
		await handlers.get("message_update")!({ message: first, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
		await handlers.get("message_update")!({ message: first, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 } });
		assert.match(clean(root.render(80)), /●<warning> Thinking ▸/);
		await handlers.get("message_update")!({ message: first, assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } });
		assert.match(clean(root.render(80)), /●<success> Thinking ▸/, "turns green before the message or Run ends");

		const second = { role: "assistant", id: "t2", timestamp: 120, content: [{ type: "thinking", thinking: "cut off" }] };
		await handlers.get("message_start")!({ message: second });
		await handlers.get("message_update")!({ message: second, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 } });
		const next = new AssistantMessageComponent(second as never, false);
		root.addChild(next);
		assert.match(clean(root.render(80)), /●<warning> Thinking · 2 parts/);
		await handlers.get("agent_settled")!({});
		const settled = clean(root.render(80));
		assert.doesNotMatch(settled, /●<success>|●<warning>/);
		assert.match(settled, /Thinking · 2 parts · interrupted/);
	} finally { teardown(); }
});

test("aborted thinking restores as interrupted from history", () => {
	const p = setup();
	try {
		const aborted = { role: "assistant", id: "t1", timestamp: 110, stopReason: "aborted", usage: usage(1), content: [{ type: "thinking", thinking: "half" }] };
		const messages = [user("request", 100), aborted];
		p.rebuild(entries(messages));
		const { root } = transcript(p, messages, false, false);
		const text = clean(root.render(80));
		assert.match(text, /●<muted> Thinking · interrupted ▸/);
		assert.match(text, /Operation aborted/, "the error stays outside the fold");
	} finally { teardown(); }
});

test("folded blocks never lay out thinking; streaming deltas do not repaint a folded Run host", () => {
	const p = setup();
	try {
		const { root } = transcript(p, runMessages);
		root.render(100);
		const block = p.getRunThinkingBlock("b", false)!;
		assert.ok(block.parts.every((part) => part.cache === undefined), "no Markdown layout while folded");
		let repaints = 0;
		p.connectRenderer("b", "read", {}, () => { repaints++; });
		const growing = runMessages.at(-1) as any;
		p.noteThinkingEvent(growing, { type: "thinking_start" });
		const pass = (grow: boolean) => {
			repaints = 0;
			for (let i = 0; i < 20; i++) {
				if (grow) growing.content[0].thinking += " more";
				p.ingestAssistantMessage(growing);
				p.noteThinkingEvent(growing, { type: "thinking_delta" });
			}
			return repaints;
		};
		const steady = pass(false);
		assert.equal(pass(true), steady, "folded thinking growth adds no repaint over ordinary streaming");
		block.toggle();
		root.render(100);
		const caches = p.getRunThinkingBlock("b", false)!.parts.map((part) => part.cache);
		root.render(100);
		assert.deepEqual(p.getRunThinkingBlock("b", false)!.parts.map((part) => part.cache), caches, "expanded bodies are cached");
	} finally { teardown(); }
});

test("fullscreen click toggles only Thinking and keeps its title row in place", (t) => {
	const p = setup();
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const screen = fullscreen({ scrollbar: "hidden", follow: "none" });
	try {
		const { root } = transcript(p, runMessages);
		screen.terminal.resize(80, 30);
		screen.document.addChild(root);
		screen.document.addChild(new Rows(20));
		screen.start();
		const row = screen.lines().findIndex((line) => line.includes("Thinking · 3 parts"));
		assert.ok(row > 0);
		screen.terminal.click(4, row);
		screen.paint();
		const lines = screen.lines();
		assert.equal(lines.findIndex((line) => line.includes("Thinking · 3 parts ▾")), row, "title stays anchored");
		assert.ok(lines.some((line) => line.includes("plan A")));
		assert.ok(lines.some((line) => line.includes("Run (2 calls")), "Run stays collapsed");
		assert.equal(p.isItemExpanded("b"), false, "Run stays collapsed");
		now += 1000; // A deliberate second click, not native double-click selection.
		screen.terminal.click(4, row);
		screen.paint();
		assert.ok(!screen.lines().some((line) => line.includes("plan A")));
	} finally { screen.stop(); teardown(); }
});
