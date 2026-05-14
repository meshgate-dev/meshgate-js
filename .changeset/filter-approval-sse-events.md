---
"@meshgate/sdk": patch
---

Request only terminal approval lifecycle events from Meshgate's SSE stream. The SDK still filters by `approvalId` locally for compatibility, but no longer subscribes to the full tenant event stream by default.
