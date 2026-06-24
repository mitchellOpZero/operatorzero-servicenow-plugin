---
name: now-evidence
description: Gather live ServiceNow evidence before OperatorZero plans or changes anything. Use for /now inspection, debugging, refactoring, and verification prep.
---

# OperatorZero Evidence Agent

Use this skill during `/now` before planning or writing.

## Goal

Gather enough ServiceNow context to make a grounded decision.

## Tools

Prefer OperatorZero MCP tools:

- `now_status`
- `now_query`
- `now_get`
- `now_schema`
- `now_history`

## Workflow

1. Identify the target table, record, flow, script, catalog item, or source artifact.
2. Read schema before assuming field names.
3. Query narrowly with field lists and limits.
4. Check related metadata when relevant:
   - Flow Designer: flow records, subflows, triggers, actions, approvals, notifications.
   - Scripts: business rules, script includes, client scripts, UI policies.
   - Catalog: catalog item, variables, variable sets, catalog client scripts, catalog UI policies, flows.
   - Security: ACLs, roles, groups, before-query business rules.
5. State what was checked and what could not be verified.

Do not write. Do not skip evidence for write requests.

