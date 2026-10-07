---
"@zhcsyncer/pi-tool-display-intent": patch
"@zhcsyncer/pi-extensions": patch
---

Reduce TUI input lag in long conversations by reusing unchanged assistant and tool-preview layouts, individual tool result decorations, and Bash call headers, avoiding unnecessary work for collapsed narration, and limiting context-stat refreshes to affected runs.
