// Run from this package: node --import tsx scripts/benchmark-render-cache.ts
// In-memory terminal: measures JS rendering/input latency, not terminal I/O.
import { performance } from "node:perf_hooks";
import { AssistantMessageComponent, ToolExecutionComponent, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, Text, TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { AggregateProjection, patchAggregateToolExecutions, restoreAggregateToolExecutions } from "../src/aggregate-activity.ts";
import { patchAggregateThinkingPlaceholders, restoreAggregateThinkingPlaceholders } from "../src/aggregate-thinking-placeholder.ts";
import { PreviewText } from "../src/preview-text.ts";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

initTheme("dark", false);
const width = 100;
const body = "### Analysis\n\nMeasured **render work** with `cache` and Unicode 中文.\n\n"
	+ Array.from({ length: 8 }, (_, i) => `- Item ${i}: repeated historical text with **bold**, a path src/example.ts and expected result.\n`).join("");
function message(id: number, tools = false) {
	return { role: "assistant", id: `a-${id}`, timestamp: id + 1000, stopReason: tools ? "toolUse" : "stop",
		content: [{ type: "thinking", thinking: "Reasoning content ".repeat(100) }, { type: "text", text: `Reply ${id}\n${body}` },
			...(tools ? [{ type: "toolCall", id: `t-${id}`, name: "read", arguments: { path: `file-${id}.ts` } }] : [])] };
}
let updates = 0;
const prototype = AssistantMessageComponent.prototype;
const originalUpdate = prototype.updateContent;
prototype.updateContent = function(...args) { updates++; return originalUpdate.apply(this, args); };
function measure(render: () => unknown) {
	render(); render();
	updates = 0;
	const samples = Array.from({ length: 7 }, () => { const start = performance.now(); render(); return performance.now() - start; });
	return { medianMs: +samples.sort((a, b) => a - b)[3]!.toFixed(2), updatesPerFrame: updates / 7 };
}
try {
	const document = new Container();
	for (let i = 0; i < 300; i++) document.addChild(new AssistantMessageComponent(message(i) as never, true, undefined, "Thinking...", 0));
	const editor = Object.assign(new Text("Input > ", 0, 0), { handleInput: (data: string) => editor.setText(`Input > ${data}`) });
	const tui = new TuiAltScreen({ columns: width, rows: 30, write() {} } as never, false);
	// Exercise the real input → immediate render → fullscreen layout path without starting a terminal.
	const runtime = tui as any;
	runtime.altScreenActive = true;
	runtime.focusedComponent = editor;
	runtime.layoutRoot = new VStack([
		{ component: new ScrollView(document, { follow: "end", primary: true }), basis: 0, grow: 1, minSize: 1 },
		{ component: editor, basis: "auto", minSize: 1 },
	]);
	tui.requestRender = () => {};
	const native = measure(() => runtime.doRender());
	patchAggregateThinkingPlaceholders(() => true);
	const patched = measure(() => runtime.doRender());
	const input = async (key: string) => {
		const start = performance.now();
		runtime.handleTerminalInput(key);
		await new Promise((resolve) => setImmediate(resolve));
		return performance.now() - start;
	};
	await input("warmup");
	updates = 0;
	const inputs: number[] = [];
	for (let i = 0; i < 7; i++) inputs.push(await input(String(i)));
	console.log(JSON.stringify({ case: "300 historical assistants, fullscreen 100x30", native, patched,
		inputToPaintMedianMs: +inputs.sort((a, b) => a - b)[3]!.toFixed(2), updatesPerKey: updates / 7 }));
	runtime.stopped = true;
	restoreAggregateThinkingPlaceholders();

	for (const n of [300, 1000]) {
		const root = new Container();
		for (let i = 0; i < n; i++) root.addChild(new PreviewText({
			lines: Array.from({ length: 8 }, (_, j) => `Result ${i}/${j} ` + "some output 中文 ".repeat(6)),
			maxRows: 8, expanded: false, theme: { fg: (_, text) => text },
		}));
		console.log(JSON.stringify({ case: "output previews", n, ...measure(() => root.render(width)) }));
	}
	// Include the real result wrappers and Bash headers, not just bare PreviewText.
	const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
	registerToolDisplayOverrides({
		registerTool: (tool) => { tools.set(tool.name, tool); },
		on() {}, getAllTools: () => [],
	} as unknown as ExtensionAPI, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	for (const n of [300, 1000]) {
		document.clear();
		for (let i = 0; i < n; i++) {
			const name = i % 10 === 0 ? "write" : "bash";
			const args = name === "bash"
				? { command: "printf first\nprintf second", displaySummary: "Check historical output" }
				: { path: `cache-${i}.ts`, content: Array.from({ length: 30 }, (_, row) => `const item${row} = '中文';`).join("\n") };
			const tool = new ToolExecutionComponent(name, `individual-${i}`, args, {}, tools.get(name),
				{ requestRender() {} } as never, process.cwd());
			tool.updateResult({ content: [{ type: "text", text: Array.from({ length: 8 }, (_, row) =>
				`Result ${i}/${row} ` + "output 中文 👩‍💻 ".repeat(6)).join("\n") }], isError: false });
			document.addChild(tool);
		}
		runtime.stopped = false;
		const frame = measure(() => runtime.doRender());
		await input("warmup");
		const inputs: number[] = [];
		for (let i = 0; i < 7; i++) inputs.push(await input(String(i)));
		console.log(JSON.stringify({ case: "individual tools, full native chain, fullscreen 100x30", n, ...frame,
			inputToPaintMedianMs: +inputs.sort((a, b) => a - b)[3]!.toFixed(2) }));
		runtime.stopped = true;
	}
	for (const [n, narration] of [[300, true], [2000, false]] as const) {
		const projection = new AggregateProjection();
		projection.startUserGroup("benchmark-run");
		const root = new Container();
		for (let i = 0; i < n; i++) {
			const source = message(i, true);
			projection.ingestAssistantMessage(source);
			projection.markComplete(`t-${i}`, { content: [] }, false, { retainDone: false });
			root.addChild(narration ? new AssistantMessageComponent(source as never, true)
				: new ToolExecutionComponent("read", `t-${i}`, { path: `file-${i}.ts` }, {}, undefined, { requestRender() {} } as never, process.cwd()));
		}
		projection.markGroupSettled();
		patchAggregateToolExecutions(projection);
		patchAggregateThinkingPlaceholders(() => true);
		console.log(JSON.stringify({ case: narration ? "collapsed narration" : "collapsed tools, single run", n,
			...measure(() => root.render(width)), visibleLines: root.render(width).length }));
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
} finally {
	restoreAggregateThinkingPlaceholders();
	restoreAggregateToolExecutions();
	prototype.updateContent = originalUpdate;
}
