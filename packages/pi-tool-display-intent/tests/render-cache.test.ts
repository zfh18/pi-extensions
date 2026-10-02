import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { AggregateProjection, patchAggregateToolExecutions, restoreAggregateToolExecutions } from "../src/aggregate-activity.ts";
import { patchAggregateThinkingPlaceholders, restoreAggregateThinkingPlaceholders } from "../src/aggregate-thinking-placeholder.ts";
import { PreviewText } from "../src/preview-text.ts";

const message = () => ({
	role: "assistant", id: "cache-message", timestamp: 1, stopReason: "stop",
	content: [{ type: "thinking", thinking: "Private reasoning" }, { type: "text", text: "Visible **answer**" }],
});

test("preview reuses layout until width or explicit invalidation changes", () => {
	let layouts = 0;
	const lines = ["first result"];
	const preview = new PreviewText({ lines, maxRows: 3, expanded: false,
		theme: { fg: (_, text) => text }, appendHints: (text) => { layouts++; return text; } });
	const initial = preview.render(80);
	for (let i = 0; i < 20; i++) assert.deepEqual(preview.render(80), initial);
	assert.equal(layouts, 1);
	preview.render(40);
	assert.equal(layouts, 2);
	lines[0] = "updated result";
	preview.invalidate();
	assert.match(preview.render(40).join("\n"), /updated result/);
	assert.equal(layouts, 3);
});

test("assistant body is cached, but in-place streaming updates, width and invalidate still refresh it", () => {
	initTheme("dark", false);
	const prototype = AssistantMessageComponent.prototype;
	const originalUpdate = prototype.updateContent;
	const nativeBody = (new AssistantMessageComponent(message() as never, true) as any).contentContainer.children.at(-1);
	const markdownPrototype = Object.getPrototypeOf(nativeBody);
	const originalMarkdown = markdownPrototype.render;
	let updates = 0;
	let markdownRenders = 0;
	prototype.updateContent = function(...args) { updates++; return originalUpdate.apply(this, args); };
	markdownPrototype.render = function(width: number) { markdownRenders++; return originalMarkdown.call(this, width); };
	try {
		patchAggregateThinkingPlaceholders(() => true);
		const source = message();
		const component = new AssistantMessageComponent(source as never, true);
		const first = component.render(80);
		updates = markdownRenders = 0;
		for (let i = 0; i < 20; i++) assert.deepEqual(component.render(80), first);
		assert.equal(updates, 0);
		assert.equal(markdownRenders, 0);
		assert.equal((component as any).lastMessage, source);

		source.content[1]!.text = "Streaming replacement";
		component.updateContent(source as never, true);
		assert.equal((component as any).isStreaming, true);
		assert.match(component.render(80).join("\n"), /Streaming replacement/);
		assert.ok(markdownRenders > 0);
		markdownRenders = 0;
		component.render(40);
		assert.ok(markdownRenders > 0);
		markdownRenders = 0;
		component.invalidate();
		component.render(40);
		assert.ok(markdownRenders > 0);

		// Native thinking visibility setters also rebuild through updateContent.
		source.content = [{ type: "thinking", thinking: "Visible reasoning" }];
		component.updateContent(source as never, false);
		component.setHideThinkingBlock(false);
		assert.match(component.render(80).join("\n"), /Visible reasoning/);
		component.setHideThinkingBlock(true);
		assert.deepEqual(component.render(80), []);
	} finally {
		restoreAggregateThinkingPlaceholders();
		assert.equal(prototype.updateContent === originalUpdate, false, "restore retains the earlier wrapper");
		prototype.updateContent = originalUpdate;
		markdownPrototype.render = originalMarkdown;
	}
});

test("collapsed narration does not calculate discarded context lines, and expansion reuses its body", () => {
	initTheme("dark", false);
	const projection = new AggregateProjection();
	projection.startUserGroup("cache-user");
	const source = { ...message(), stopReason: "toolUse", content: [...message().content,
		{ type: "toolCall", id: "cache-call", name: "read", arguments: { path: "a.ts" } }] };
	projection.ingestAssistantMessage(source);
	projection.markComplete("cache-call", { content: [] }, false);
	projection.markGroupSettled();
	projection.getAssistantContextLines = () => { throw new Error("discarded context should not be rendered"); };
	patchAggregateToolExecutions(projection);
	patchAggregateThinkingPlaceholders(() => true);
	try {
		const component = new AssistantMessageComponent(source as never, true);
		assert.deepEqual(component.render(80), []);
		let scans = 0;
		const getFrames = projection.getFramedItemIds.bind(projection);
		projection.getFramedItemIds = (id) => { scans++; return getFrames(id); };
		assert.deepEqual(component.render(80), []);
		assert.equal(scans, 0, "unchanged hidden frames must not rescan the run");
		projection.toggleGroupExpansion("cache-call");
		assert.match(component.render(80).join("\n"), /answer/);
		projection.toggleGroupExpansion("cache-call");
		assert.deepEqual(component.render(80), []);
	} finally {
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
});

test("cache hooks survive disable/re-enable behind a later render wrapper", () => {
	initTheme("dark", false);
	const prototype = AssistantMessageComponent.prototype;
	const original = prototype.render;
	const originalUpdate = prototype.updateContent;
	const originalInvalidate = prototype.invalidate;
	patchAggregateThinkingPlaceholders(() => true);
	const patched = prototype.render;
	const outer = function(this: AssistantMessageComponent, width: number) { return patched.call(this, width); };
	prototype.render = outer;
	try {
		const source = message();
		const component = new AssistantMessageComponent(source as never, true);
		component.render(80);
		restoreAggregateThinkingPlaceholders();
		assert.equal(prototype.render, outer);
		assert.equal(prototype.updateContent, originalUpdate);
		assert.equal(prototype.invalidate, originalInvalidate);
		source.content[1]!.text = "Changed while disabled";
		component.updateContent(source as never);
		patchAggregateThinkingPlaceholders(() => true);
		assert.match(component.render(80).join("\n"), /Changed while disabled/);
		source.content[1]!.text = "Changed after re-enable";
		component.updateContent(source as never);
		assert.match(component.render(80).join("\n"), /Changed after re-enable/);
	} finally {
		prototype.render = patched;
		restoreAggregateThinkingPlaceholders();
		assert.equal(prototype.render, original);
	}
});
