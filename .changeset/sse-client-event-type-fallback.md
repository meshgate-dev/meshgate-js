---
"@meshgate/sdk": patch
---

Fix SseClient silently dropping all events when server omits named "event:" SSE lines. Fall back to the "type" field embedded in the JSON data payload so guard() no longer hangs indefinitely against servers that embed the event type in the data body instead of the SSE event line.
