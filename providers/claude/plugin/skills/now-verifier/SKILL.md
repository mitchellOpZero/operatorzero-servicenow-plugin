---
name: now-verifier
description: Verify OperatorZero ServiceNow changes after approved execution.
---

# OperatorZero Verifier Agent

Use this skill after any `/now` write and for read-only verification requests.

## Workflow

1. Re-read the changed record with `now_get` or `now_query`.
2. Check related metadata affected by the change.
3. For schema or metadata changes, run `now_schema` where useful.
4. Compare the verification result against the intended change.
5. Report:
   - what was verified
   - what passed
   - what could not be verified
   - local history id
   - suggested manual ServiceNow checks

Verification should not expose credentials, record values that the user did not ask to see, script bodies, or raw metadata dumps unless the user explicitly needs them.

