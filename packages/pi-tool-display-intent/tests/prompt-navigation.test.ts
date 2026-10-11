import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { patchAggregateThinkingPlaceholders, restoreAggregateThinkingPlaceholders } from "../src/aggregate-thinking-placeholder.ts";
import { AggregateProjection, patchAggregateToolExecutions, restoreAggregateToolExecutions } from "../src/aggregate-activity.ts";
import { resolveAggregateSteerUserPresentation } from "../src/user-message-box-native.ts";
import { patchNativeUserMessagePrototype } from "../src/user-message-box-renderer.ts";
import { unregisterUserMessageRenderPrototypePatch } from "../src/user-message-box-patch.ts";
import { Rows, fullscreen } from "./helpers/aggregate-terminal.ts";

// Pi overrides the bare TUI defaults on Windows/WSL; test the same bindings the CLI installs.
const { KeybindingsManager } = await import(new URL("core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const sequences: Record<string, string> = {
	"ctrl+up": "\x1b[1;5A", "ctrl+down": "\x1b[1;5B",
	"ctrl+shift+up": "\x1b[1;6A", "ctrl+shift+down": "\x1b[1;6B",
};

for (const aggregate of [false, true]) {
	test(`fullscreen host shortcuts navigate cached ${aggregate ? "aggregate messages including steers" : "individual messages"}`, () => {
		initTheme("dark", false);
		const previousKeybindings = getKeybindings();
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const nextSequence = sequences[keybindings.getKeys("tui.altScreen.nextPrompt")[0]];
		const previousSequence = sequences[keybindings.getKeys("tui.altScreen.previousPrompt")[0]];
		const f = fullscreen({ scrollbar: "hidden", follow: "none" });
		const prototype = UserMessageComponent.prototype;
		const projection = new AggregateProjection();
		if (aggregate) {
			projection.startUserGroup("nav-user");
			projection.markStarted("nav-read", "read", { path: "a.ts" });
			projection.ingestUserMessage({ role: "user", content: "Question 2" }, { streamingBehavior: "steer" });
			patchAggregateToolExecutions(projection);
		}
		patchNativeUserMessagePrototype(prototype, () => undefined, () => true, () => aggregate, resolveAggregateSteerUserPresentation);
		patchAggregateThinkingPlaceholders(() => aggregate);
		try {
			const messages = [1, 2].flatMap((turn) => [
				new UserMessageComponent(`Question ${turn}`),
				new AssistantMessageComponent({ role: "assistant", stopReason: "stop", content: [
					{ type: "thinking", thinking: "Hidden reasoning" },
					{ type: "text", text: `Answer ${turn}` },
				] } as never, true),
			]);
			let row = 2;
			const boundaries = messages.map((message) => {
				const start = row;
				row += message.render(f.terminal.columns).length;
				return start;
			});
			f.document.addChild(new Rows(2));
			for (const message of messages) f.document.addChild(message);
			f.document.addChild(new Rows(20)); // Leave room to align the final message at viewport top.
			f.start();
			assert.ok(nextSequence && previousSequence, "host navigation keys need test input sequences");
			for (let pass = 0; pass < 2; pass++) {
				if (aggregate) projection.toggleGroupExpansion("nav-read");
				f.scroll.scrollTo(0);
				f.paint();
				for (const boundary of boundaries) {
					f.terminal.onInput?.(nextSequence);
					f.paint();
					assert.equal(f.scroll.scrollTop, boundary, "next prompt must land on each user/assistant boundary");
				}
				for (const boundary of boundaries.slice(0, -1).reverse()) {
					f.terminal.onInput?.(previousSequence);
					f.paint();
					assert.equal(f.scroll.scrollTop, boundary, "previous prompt must land on each user/assistant boundary");
				}
			}
		} finally {
			f.stop();
			restoreAggregateThinkingPlaceholders();
			if (aggregate) restoreAggregateToolExecutions();
			unregisterUserMessageRenderPrototypePatch(prototype);
			setKeybindings(previousKeybindings);
		}
	});
}
