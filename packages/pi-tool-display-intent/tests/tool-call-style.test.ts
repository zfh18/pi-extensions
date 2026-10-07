import assert from "node:assert/strict";
import test from "node:test";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import {
	applyToolResultStyle,
	ClaudeToolResultComponent,
	formatClaudeToolCall,
	formatClaudeStatusMarker,
} from "../src/tool-call-style.ts";

const taggedTheme = {
	fg: (color: string, text: string): string => `<${color}>${text}</${color}>`,
	bold: (text: string): string => `<b>${text}</b>`,
};

const plainTheme = {
	fg: (_color: string, text: string): string => text,
	bold: (text: string): string => text,
};

test("Claude status markers distinguish running, success, and failure", () => {
	assert.equal(formatClaudeStatusMarker(taggedTheme, { isPartial: true }), "<warning>●</warning>");
	assert.equal(formatClaudeStatusMarker(taggedTheme, { isPartial: true }, "⠋"), "<warning>⠋</warning>");
	assert.equal(formatClaudeStatusMarker(taggedTheme, { isPartial: false }), "<success>●</success>");
	assert.equal(formatClaudeStatusMarker(taggedTheme, { isError: true }), "<error>●</error>");
});

test("Claude call headers preserve deterministic targets and intent", () => {
	const rendered = formatClaudeToolCall(
		"edit",
		"src/index.ts",
		" (2 lines)",
		" — 更新配置加载逻辑",
		plainTheme,
		{ isPartial: false },
	);
	assert.equal(rendered, "● Update(src/index.ts) (2 lines) — 更新配置加载逻辑");
});

test("Claude result wrapper replaces legacy arrows, indents continuations, and respects width", () => {
	const wrapped = applyToolResultStyle(new Text("↳ Added 1 line\ndiff detail", 0, 0), "claude") as {
		render(width: number): string[];
		invalidate(): void;
	};
	const lines = wrapped.render(24);

	assert.deepEqual(lines.map((line) => line.trimEnd()), ["  ⎿ Added 1 line", "    diff detail"]);
	assert.ok(lines.every((line) => visibleWidth(line) <= 24));
	assert.doesNotThrow(() => wrapped.invalidate());
});

test("Claude Bash result wrapper connects every output row through the last line", () => {
	const wrapped = applyToolResultStyle(
		new Text("first output\nsecond output\nlast output", 0, 0),
		"claude",
		{ connectRows: true },
	) as { render(width: number): string[] };

	assert.deepEqual(
		wrapped.render(24).map((line) => line.trimEnd()),
		["  │ first output", "  │ second output", "  └ last output"],
	);

	const single = applyToolResultStyle(new Text("only output", 0, 0), "claude", { connectRows: true }) as {
		render(width: number): string[];
	};
	assert.deepEqual(single.render(24).map((line) => line.trimEnd()), ["  └ only output"]);
});

test("Claude result cache observes live child rows, width and theme invalidation", () => {
	for (const connectRows of [false, true]) {
		let rows = ["\x1b[32m结果 👩‍💻\x1b[0m", "second line"];
		let renders = 0;
		let paints = 0;
		let invalidations = 0;
		let color = 90;
		const wrapped = new ClaudeToolResultComponent({
			render: () => { renders++; return rows; },
			invalidate: () => { invalidations++; },
		}, { connectRows, theme: { fg: (_, text) => { paints++; return `\x1b[${color}m${text}\x1b[0m`; } } });
		const first = wrapped.render(80);
		paints = 0;
		for (let i = 0; i < 10; i++) assert.equal(wrapped.render(80), first);
		assert.equal(paints, 0, "cached child output must not be redecorated");
		assert.equal(renders, 11, "live children must still be polled");
		rows = [...rows];
		assert.equal(wrapped.render(80), first, "fresh arrays with identical rows share the decoration cache");

		// Some children mutate the same array rather than returning a new one.
		rows[1] = "streamed replacement";
		assert.match(wrapped.render(80).join("\n"), /streamed replacement/);
		rows.push("third line");
		assert.equal(wrapped.render(80).length, 3);
		const wide = wrapped.render(80);
		color = 31;
		wrapped.invalidate();
		assert.equal(invalidations, 1);
		assert.notDeepEqual(wrapped.render(80), wide);
		for (const width of [12, 3, 0]) {
			assert.ok(wrapped.render(width).every((line) => visibleWidth(line) <= width));
		}
		rows.length = 0;
		assert.deepEqual(wrapped.render(80), []);
		rows.push("restored");
		assert.match(wrapped.render(80).join("\n"), /restored/);
	}
});

test("Claude result wrapper hides empty result components and compact style is unchanged", () => {
	const empty = applyToolResultStyle(new Text("", 0, 0), "claude") as { render(width: number): string[] };
	assert.deepEqual(empty.render(80), []);

	const compact = new Text("↳ unchanged", 0, 0);
	assert.equal(applyToolResultStyle(compact, "compact"), compact);
});
