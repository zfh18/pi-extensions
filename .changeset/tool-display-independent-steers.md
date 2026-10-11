---
"@zhcsyncer/pi-tool-display-intent": patch
"@zhcsyncer/pi-extensions": patch
---

Keep steering messages visible as independent user messages at their original transcript position, regardless of Run folding. Split Run displays at steering messages so earlier calls never move below later instructions, with separate segment counts and folding while preserving request-level statistics. Completed-call previews in an earlier Run fold as soon as a steering message is inserted, without waiting for later work to finish or reopening on delayed results. Stop repeating steering text or counts in tool summaries, and retain bounded long-message previews and message navigation.
