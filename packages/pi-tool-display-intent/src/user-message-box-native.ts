import {
  type ExtensionAPI,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  patchNativeUserMessagePrototype,
  wrapAggregatePromptLine,
  type PatchableUserMessagePrototype,
  type UserMessageSteerPresentation,
  type UserMessageTheme,
} from "./user-message-box-renderer.js";
import { unregisterUserMessageRenderPrototypePatch } from "./user-message-box-patch.js";
import { extractUserMessageMarkdownState } from "./user-message-box-markdown.js";
import {
  getActiveAggregateProjection,
  resolveAggregateRenderTheme,
} from "./aggregate-activity.js";
import { layoutSteerPreview } from "./steer-preview.js";
import type { ToolDisplayConfig } from "./types.js";
import { onReloadShutdown } from "./extension-lifecycle.js";
import { patchAggregateMouseHandling, recordAggregateClickRegions, releaseAggregateClickRegions, restoreAggregateMouseHandling } from "./aggregate-interaction.js";

const registeredNativeUserMessageApis = new WeakSet<ExtensionAPI>();

function getUserMessagePrototype(): PatchableUserMessagePrototype {
  return UserMessageComponent.prototype as unknown as PatchableUserMessagePrototype;
}

function readUserMessageText(instance: object): string | undefined {
  const text = (instance as { text?: unknown }).text;
  if (typeof text === "string") return text;
  return extractUserMessageMarkdownState(instance)?.text;
}

export function resolveAggregateSteerUserPresentation(
  instance: object,
  width: number,
): UserMessageSteerPresentation | undefined {
  releaseAggregateClickRegions(instance);
  const projection = getActiveAggregateProjection();
  if (!projection) return undefined;
  const text = readUserMessageText(instance);
  const steer = projection.matchSteerForComponent(instance, text);
  if (!steer) return undefined;
  const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (safeWidth === 0) return { lines: [] };
  const theme = resolveAggregateRenderTheme(projection);
  const preview = layoutSteerPreview(steer.text, Math.max(1, safeWidth - 2));
  const lines = ["", ...preview.rows, ""].map((line) =>
    truncateToWidth(wrapAggregatePromptLine(line, safeWidth, theme), safeWidth, ""));
  // This is an independent user message, not a Run frame or folding target.
  const omissionRow = preview.omissionRow;
  recordAggregateClickRegions(instance, width, lines.length, omissionRow === undefined ? [] : [{
    startRow: omissionRow + 1,
    endRow: omissionRow + 2,
    onClick: () => projection.openDetail({ kind: "steer", text: steer.text }),
  }]);
  return { lines };
}

function patchUserMessageRender(
  getTheme: () => UserMessageTheme | undefined,
  isEnabled: () => boolean,
  isCompact: () => boolean,
): void {
  patchNativeUserMessagePrototype(
    getUserMessagePrototype(),
    getTheme,
    isEnabled,
    isCompact,
    (instance, width) => isCompact() ? resolveAggregateSteerUserPresentation(instance, width) : undefined,
  );
  patchAggregateMouseHandling(getUserMessagePrototype());
}

function restoreUserMessageRender(): void {
  restoreAggregateMouseHandling(getUserMessagePrototype());
  unregisterUserMessageRenderPrototypePatch(getUserMessagePrototype());
}

export default function registerNativeUserMessageBox(
  pi: ExtensionAPI,
  getConfig: () => ToolDisplayConfig,
): void {
  if (registeredNativeUserMessageApis.has(pi)) {
    return;
  }
  registeredNativeUserMessageApis.add(pi);

  let activeTheme: UserMessageTheme | undefined;

  const getTheme = (): UserMessageTheme | undefined => activeTheme;
  const isAggregate = (): boolean => getConfig().toolCallLayout === "aggregate";
  const isEnabled = (): boolean => true;
  const isCompact = (): boolean => isAggregate();

  patchUserMessageRender(getTheme, isEnabled, isCompact);

  onReloadShutdown(pi, () => {
    restoreUserMessageRender();
    activeTheme = undefined;
    registeredNativeUserMessageApis.delete(pi);
  });

  pi.on("before_agent_start", async () => {
    patchUserMessageRender(getTheme, isEnabled, isCompact);
  });

  pi.on("session_start", async (_event, ctx) => {
    activeTheme = ctx?.ui?.theme as unknown as UserMessageTheme;
    patchUserMessageRender(getTheme, isEnabled, isCompact);
  });

}
