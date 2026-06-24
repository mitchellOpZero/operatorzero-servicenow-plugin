---
description: OperatorZero ServiceNow workflow with evidence, safety checks, approved execution, and verification
argument-hint: <setup|privacy|history|show last|explain last|ServiceNow task>
allowed-tools: [Read, mcp__operatorzero-servicenow-plugin__now_status, mcp__operatorzero-servicenow-plugin__now_setup_check, mcp__operatorzero-servicenow-plugin__now_doctor, mcp__operatorzero-servicenow-plugin__now_privacy, mcp__operatorzero-servicenow-plugin__now_history, mcp__operatorzero-servicenow-plugin__now_show_last, mcp__operatorzero-servicenow-plugin__now_explain_last, mcp__operatorzero-servicenow-plugin__now_query, mcp__operatorzero-servicenow-plugin__now_get, mcp__operatorzero-servicenow-plugin__now_schema, mcp__operatorzero-servicenow-plugin__now_safety_check, mcp__operatorzero-servicenow-plugin__now_record, mcp__operatorzero-servicenow-plugin__now_script]
---

Use the OperatorZero plugin workflow in `providers/claude/plugin/commands/now.md` for this task:

$ARGUMENTS

If that plugin command file is unavailable, treat this as the same OperatorZero ServiceNow workflow: gather evidence before writes or scripts, call `now_setup_check` for setup, call `now_history` for history, call `now_show_last` for `/now show last`, call `now_explain_last` for `/now explain last`, call `now_safety_check` before `now_record` or `now_script`, ask for explicit terminal approval before execution, stop on governance blocks, verify after execution, and report evidence, decision path, changes, verification, and local history id.
