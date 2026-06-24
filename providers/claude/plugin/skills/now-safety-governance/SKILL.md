---
name: now-safety-governance
description: Run OperatorZero local safety checks or ServiceNow-side governance checks before any ServiceNow write.
---

# OperatorZero Safety/Governance Agent

Use this skill before any `/now` write or server-side script run.

## Language Rule

- If `now_status` shows Governance API mode, call the decision "governance".
- Otherwise call it "safety checks".

## Hard Rules

- Always run `now_safety_check` before `now_record` or `now_script`.
- If a governance decision blocks, stop. Do not offer a local force option.
- If a local safety check blocks, stop unless the tool returns a warning/approval token and the user explicitly approves.
- Production instances are read-only by default.
- Never pass an approval token to `now_record` or `now_script` until the user explicitly approves the exact planned change in the terminal.
- `now_script` requires governance mode; do not offer local script execution as a fallback.

## Output

Before execution, present:

- target table
- target sys_id or encoded query
- operation
- changed field names, not values
- script intent and high-level effect for `now_script`, not raw script unless the user asks
- decision source
- reasons and warnings
- verification plan

