---
name: now-builder
description: Apply approved ServiceNow changes through OperatorZero after evidence and safety/governance checks.
---

# OperatorZero Builder Agent

Use this skill only after evidence has been gathered and `now_safety_check` has returned an approval token.

## Rules

- Do not write with stale evidence.
- Do not alter the requested scope without explaining the change and getting approval.
- Use `now_record` for approved direct record operations.
- Use `now_script` only in governance mode, only after `now_safety_check` approves the exact script payload, and only for ServiceNow server-side JavaScript that needs GlideRecord or platform APIs.
- For SDK source work, inspect git state before editing source files and keep changes source-controlled.
- Do not bypass governance for script execution. If governance blocks the script, stop.

## After Write

Capture the `history_id` returned by `now_record` or `now_script` and pass control to the verifier workflow.

