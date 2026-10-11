import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, getKeybindings, setKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import { AggregateProjection, patchAggregateToolExecutions, registerAggregateProjectionEvents, restoreAggregateToolExecutions } from "../src/aggregate-activity.ts";
import { patchAggregateThinkingPlaceholders, restoreAggregateThinkingPlaceholders } from "../src/aggregate-thinking-placeholder.ts";
import registerNativeUserMessageBox from "../src/user-message-box-native.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";
import { Rows, fullscreen } from "./helpers/aggregate-terminal.ts";
import { hasPromptZoneStart } from "../src/prompt-zone-markers.ts";

const { KeybindingsManager } = await import(new URL("core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);

const plain = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const clean = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp });
const assistant = (id: string, name: string, timestamp: number, text = `note ${id}`) => ({
	role: "assistant", id: `turn-${id}`, timestamp, stopReason: "toolUse",
	usage: { input: timestamp, output: 10, cacheRead: 0, cacheWrite: 0 },
	content: [{ type: "text", text }, { type: "toolCall", id, name, arguments: { path: `${id}.ts` } }],
});
const result = (id: string, name: string, timestamp: number, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: name, timestamp, isError, content: [{ type: "text", text: `${id} result` }] });
const entries = (messages: unknown[]) => messages.map((message, i) => ({ type: "message", id: `entry-${i}`, message }));
function tool(id: string, name: string) {
	return new ToolExecutionComponent(name, id, { path: `${id}.ts` }, {}, {
		name, label: name, description: name, parameters: { type: "object", properties: {} },
		execute() { throw new Error("Rendering must not execute tools"); },
		renderCall: () => new Text(id, 0, 0), renderResult: () => new Text(id, 0, 0),
	} as never, { requestRender() {} } as never, process.cwd());
}

for (const replay of [false, true]) test(`${replay ? "history" : "live"}: collapsed and expanded Runs stay on their own side of multiple steers`, async () => {
	initTheme("dark", false);
	const p = new AggregateProjection(() => false, () => "turns");
	p.setRenderTheme(plain);
	const messages = [user("request", 100), assistant("a", "read", 110), result("a", "read", 120, true),
		user("first steer", 130), user("second steer", 140), assistant("b", "edit", 150), result("b", "edit", 160),
		user("third steer", 170), assistant("c", "bash", 180), result("c", "bash", 190),
		{ role: "assistant", id: "final", timestamp: 200, stopReason: "stop", content: [{ type: "text", text: "done" }], usage: { input: 200, output: 10, cacheRead: 0, cacheWrite: 0 } }];
	if (replay) p.rebuild(entries(messages));
	patchAggregateToolExecutions(p);
	patchAggregateThinkingPlaceholders(() => true);
	const shutdown: Array<(event: any) => unknown> = [];
	registerNativeUserMessageBox({ on(name: string, cb: (event: any) => unknown) { if (name === "session_shutdown") shutdown.push(cb); } } as ExtensionAPI,
		() => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, toolCallLayout: "aggregate" }));
	const root = new Container();
	const tools: ToolExecutionComponent[] = [];
	try {
		for (const message of messages) {
			if (!replay) {
				if (message.role === "user") p.ingestUserMessage(message);
				else if (message.role === "assistant") p.ingestAssistantMessage(message);
				else p.ingestToolResult(message);
			}
			if (message.role === "user") {
				root.addChild(new Spacer(1));
				root.addChild(new UserMessageComponent(message.content as string));
			} else if (message.role === "assistant") {
				root.addChild(new AssistantMessageComponent(message as never, true));
				for (const block of message.content as any[]) if (block.type === "toolCall") {
					const component = tool(block.id, block.name);
					tools.push(component);
					root.addChild(component);
				}
			}
			if (!replay && tools.length >= 2) {
				assert.match(clean(tools[0].render(90)), /Run \(1 call/);
				assert.match(clean(tools[1].render(90)), /Run \(1 call/);
			}
		}
		for (const expanded of [false, true, false]) {
			p.noteTimelineExpansion(expanded);
			for (const width of [50, 110]) {
				const text = clean(root.render(width));
				assert.equal((text.match(/Run \(1 call/g) ?? []).length, 3);
				assert.ok(text.indexOf("read ×1") < text.indexOf("first steer"));
				assert.ok(text.indexOf("second steer") < text.indexOf("edit ×1"));
				assert.ok(text.indexOf("edit ×1") < text.indexOf("third steer"));
				assert.ok(text.indexOf("third steer") < text.indexOf("bash ×1"));
				assert.equal((text.match(/first steer/g) ?? []).length, 1);
			}
		}
		assert.equal(p.getGroups().length, 1);
		assert.equal(p.getViewForGroup("a")?.callCount, 3, "logical request accounting is unchanged");
		assert.equal(p.getView("a")?.failedCount, 1);
		assert.equal(p.getView("b")?.failedCount, 0);
		assert.equal(p.getView("a")?.agentTurnCount, 1);
		assert.equal(p.getView("b")?.agentTurnCount, 1);
		assert.equal(p.getView("c")?.agentTurnCount, 2);
		assert.equal(p.getView("a")?.usage?.input, 110);
		assert.equal(p.getView("b")?.usage?.input, 150);
		assert.equal(p.getView("c")?.usage?.input, 380);
		assert.match(p.getViewportRun("a")!.label(), /1 call/);
		assert.notEqual(p.getViewportRun("a")!.id, p.getViewportRun("b")!.id);
		const lines = root.render(110);
		const titleRows = lines.flatMap((line, index) => line.includes("Run (") ? [index] : []);
		root.handleMouse({ type: "click", button: "left", x: 3, y: titleRows[1]!, screenX: 3, screenY: titleRows[1]!,
			width: 110, height: lines.length, shift: false, alt: false, ctrl: false });
		assert.equal(p.isItemExpanded("a"), false);
		assert.equal(p.isItemExpanded("b"), true, "clicking the second title must not expand the first segment");
		p.toggleGroupExpansion("b");
		const keybindingsBefore = getKeybindings();
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const sequences: Record<string, string> = { "ctrl+up": "\x1b[1;5A", "ctrl+down": "\x1b[1;5B",
			"ctrl+shift+up": "\x1b[1;6A", "ctrl+shift+down": "\x1b[1;6B" };
		const screen = fullscreen({ scrollbar: "hidden", follow: "none" });
		try {
			screen.document.addChild(root);
			screen.document.addChild(new Rows(30));
			screen.start();
			for (const expanded of [false, true, false]) {
				p.noteTimelineExpansion(expanded);
				const boundaries = root.render(screen.terminal.columns).flatMap((line, index) => hasPromptZoneStart([line]) ? [index] : []);
				assert.equal(boundaries.length, 5, "initial user, three steers and final reply remain navigable");
				screen.scroll.scrollTo(0);
				screen.paint();
				for (const boundary of boundaries) {
					screen.terminal.onInput?.(sequences[keybindings.getKeys("tui.altScreen.nextPrompt")[0]]!);
					screen.paint();
					assert.equal(screen.scroll.scrollTop, boundary);
				}
				for (const boundary of boundaries.slice(0, -1).reverse()) {
					screen.terminal.onInput?.(sequences[keybindings.getKeys("tui.altScreen.previousPrompt")[0]]!);
					screen.paint();
					assert.equal(screen.scroll.scrollTop, boundary);
				}
			}
		} finally { screen.stop(); setKeybindings(keybindingsBefore); }
		p.toggleGroupExpansion("a");
		assert.equal(p.isItemExpanded("a"), true);
		assert.equal(p.isItemExpanded("b"), false);
		p.rebuild(entries(messages));
		assert.equal(p.isItemExpanded("a"), true);
		assert.equal(p.isItemExpanded("b"), false);
		assert.equal(p.getFrameEdge("a"), "end");
	} finally {
		for (const cb of shutdown) await cb({ reason: "reload" });
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
});

test("inserted steer folds the preceding successful previews before the agent settles", async () => {
	initTheme("dark", false);
	const p = new AggregateProjection();
	p.setRenderTheme(plain);
	const handlers = new Map<string, (event: any) => unknown>();
	registerAggregateProjectionEvents({ on(name: string, handler: (event: any) => unknown) { handlers.set(name, handler); } } as ExtensionAPI, p);
	patchAggregateToolExecutions(p);
	const root = new Container();
	try {
		await handlers.get("message_start")!({ message: user("request", 100) });
		const batch = assistant("a", "read", 110);
		batch.content.push({ type: "toolCall", id: "b", name: "read", arguments: { path: "b.ts" } },
			{ type: "toolCall", id: "failed", name: "read", arguments: { path: "failed.ts" } });
		await handlers.get("message_end")!({ message: batch });
		for (const id of ["a", "b", "failed"]) {
			root.addChild(tool(id, "read"));
			await handlers.get("tool_execution_end")!({ toolCallId: id, result: result(id, "read", 120), isError: id === "failed" });
		}
		assert.match(clean(root.render(100)), /a\.ts/);
		assert.match(clean(root.render(100)), /b\.ts/);
		await handlers.get("input")!({ streamingBehavior: "steer" });
		assert.equal(p.getView("failed")?.displayRows.length, 2, "queueing a steer is not insertion yet");
		await handlers.get("message_start")!({ message: user("adjust", 130) });
		assert.deepEqual(p.getView("failed")?.displayRows, [], "do not wait for whole-agent settlement");
		assert.equal(p.getView("failed")?.settled, true);
		assert.equal(p.getViewForGroup("failed")?.settled, false);
		assert.equal(p.getMember("a")?.retainedDone, false);
		assert.equal(p.getMember("a")?.completionOrder, undefined);
		const folded = clean(root.render(100));
		assert.match(folded, /Run \(3 calls/);
		assert.match(folded, /1 failed/);
		assert.doesNotMatch(folded, /[ab]\.ts/);
		await handlers.get("message_start")!({ message: assistant("next", "edit", 140) });
		await handlers.get("tool_execution_end")!({ toolCallId: "next", result: result("next", "edit", 150) });
		assert.equal(p.getView("next")?.displayRows.length, 1, "the active segment keeps normal success previews");
		assert.deepEqual(p.getView("failed")?.displayRows, []);
		p.toggleGroupExpansion("a");
		assert.match(clean(root.render(100)), /a\.ts/, "earlier tools remain available on expansion");
	} finally {
		await handlers.get("session_shutdown")!({ reason: "reload" });
		restoreAggregateToolExecutions();
	}
});

for (const completion of ["tool_execution_end", "message_end", "native updateResult"] as const) test(`closed segment late ${completion} does not reopen success previews`, () => {
	initTheme("dark", false);
	const p = new AggregateProjection();
	p.setRenderTheme(plain);
	patchAggregateToolExecutions(p);
	try {
		p.ingestUserMessage(user("request", 100));
		p.ingestAssistantMessage(assistant("a", "read", 110));
		p.markStarted("a", "read", { path: "a.ts" });
		const earlier = tool("a", "read");
		p.ingestUserMessage(user("adjust", 130));
		p.ingestAssistantMessage(assistant("b", "edit", 140));
		p.ingestToolResult(result("b", "edit", 150));
		assert.equal(p.getView("a")?.settled, false, "pending earlier work is not fake-completed");
		assert.match(clean(earlier.render(100)), /a\.ts/);
		if (completion === "tool_execution_end") p.markComplete("a", result("a", "read", 160), false);
		else if (completion === "message_end") p.ingestToolResult(result("a", "read", 160));
		else earlier.updateResult(result("a", "read", 160));
		assert.equal(p.getView("a")?.settled, true);
		assert.deepEqual(p.getView("a")?.displayRows, []);
		assert.notEqual(p.getMember("a")?.retainedDone, true);
		assert.equal(p.getMember("a")?.completionOrder, undefined);
		assert.doesNotMatch(clean(earlier.render(100)), /a\.ts/);
		assert.deepEqual(p.getView("b")?.displayRows.map(member => member.toolCallId), ["b"]);
		p.toggleGroupExpansion("b");
		p.ingestUserMessage(user("adjust again", 170));
		assert.deepEqual(p.getView("b")?.displayRows, []);
		assert.equal(p.isItemExpanded("b"), true, "settling previews must not override an explicit expansion");
	} finally { restoreAggregateToolExecutions(); }
});

test("a new segment follows the global expansion setting, not the preceding local toggle", () => {
	const p = new AggregateProjection();
	p.ingestUserMessage(user("request", 100));
	p.ingestAssistantMessage(assistant("a", "read", 110));
	p.toggleGroupExpansion("a");
	p.ingestUserMessage(user("adjust", 130));
	const next = { role: "assistant", id: "new-narration", timestamp: 140, stopReason: "toolUse", content: [{ type: "text", text: "next step" }] };
	p.ingestAssistantMessage(next);
	assert.equal(p.isMessageExpanded(next), false);
	p.ingestAssistantMessage(assistant("b", "edit", 150));
	assert.equal(p.isItemExpanded("a"), true);
	assert.equal(p.isItemExpanded("b"), false);
	p.noteTimelineExpansion(true);
	p.toggleGroupExpansion("b");
	p.ingestUserMessage(user("adjust again", 160));
	p.ingestAssistantMessage(assistant("c", "bash", 170));
	assert.equal(p.isItemExpanded("b"), false);
	assert.equal(p.isItemExpanded("c"), true);
});

test("late results and revised streaming IDs remain in the segment that declared their tool", () => {
	const p = new AggregateProjection();
	p.ingestUserMessage(user("request", 100));
	const before = assistant("a", "read", 110);
	p.ingestAssistantMessage(before);
	p.ingestUserMessage(user("adjust", 130));
	p.ingestAssistantMessage(assistant("b", "edit", 140));
	before.id = "updated-stream-id";
	before.usage.input = 111;
	before.content[0]!.text = "updated first note";
	p.ingestAssistantMessage(before);
	p.ingestToolResult({ ...result("a", "read", 150), usage: { input: 15, output: 2, cacheRead: 0, cacheWrite: 0 } });
	assert.equal(p.getView("a")?.agentTurnCount, 1);
	assert.equal(p.getView("b")?.agentTurnCount, 1);
	assert.equal(p.getView("a")?.usage?.input, 126);
	assert.equal(p.getView("b")?.usage?.input, 140);
	assert.equal(p.getView("a")?.latestNarration, "updated first note");
	assert.equal(p.getView("b")?.latestNarration, "note b");
	assert.equal(p.getView("a")?.settled, true);
	assert.equal(p.getView("b")?.settled, false);
	assert.equal(p.getView("a")?.completedAtMs, 150);
	p.ingestToolResult(result("b", "edit", 180));
	assert.equal(p.getView("a")?.completedAtMs, 150, "the later segment cannot extend the earlier duration");
});

test("empty and passthrough-only segments do not steal a preceding Run; removed branches release handles", () => {
	const p = new AggregateProjection((name) => name === "Agent");
	const messages = [user("request", 100), assistant("a", "read", 110), result("a", "read", 120),
		user("adjust", 130), assistant("pass", "Agent", 140), result("pass", "Agent", 150),
		user("adjust again", 160), assistant("b", "edit", 170), result("b", "edit", 180)];
	p.rebuild(entries(messages));
	assert.equal(p.getView("a")?.callCount, 1);
	assert.equal(p.getView("pass"), undefined);
	assert.equal(p.getView("b")?.callCount, 1);
	assert.equal(p.getViewForGroup("a")?.callCount, 3);
	const oldRun = p.getViewportRun("b")!;
	p.rebuild(entries(messages.slice(0, 3)));
	assert.equal(oldRun.isValid(), false);
	oldRun.toggle();
	assert.equal(p.isItemExpanded("a"), false);
	assert.equal(p.getMember("b"), undefined);
	assert.equal(p.getView("a")?.callCount, 1);
});

test("a steer without a later tool seals the earlier display but creates no empty Run", () => {
	const p = new AggregateProjection();
	p.ingestUserMessage(user("request", 100));
	p.ingestAssistantMessage(assistant("a", "read", 110));
	p.ingestUserMessage(user("adjust", 130));
	assert.equal(p.getView("a")?.settled, false, "do not fake completion of an earlier running tool");
	p.ingestToolResult(result("a", "read", 140));
	assert.equal(p.getView("a")?.settled, true);
	assert.equal(p.getView("a")?.completedAtMs, 140);
	assert.equal(p.getView("a")?.callCount, 1);
	assert.equal(p.getGroups().length, 1);
	p.ingestAssistantMessage({ role: "assistant", id: "reply", timestamp: 150, stopReason: "stop", content: [{ type: "text", text: "answer without tools" }] });
	assert.equal(p.getView("a")?.agentTurnCount, 1, "later plain replies cannot enlarge the earlier segment");
	assert.equal(p.getViewForGroup("a")?.agentTurnCount, 2);
});
