# Security Notes

OperatorZero is designed so prose instructions are not the only safety layer.

## Secrets

Do not commit credentials. Primary auth uses the ServiceNow SDK default login. This is an optional override for multi-instance work:

- `OZ_SN_AUTH_ALIAS`

Fallback auth can use environment variables:

- `SN_BEARER_TOKEN`
- or `SN_USER` and `SN_PASS`

`.env` and `.env.*` are ignored by git.

## Writes

`now_record` and `now_script` cannot run without a one-use approval token from `now_safety_check`.

`now_script` is available only through Governance mode. The ServiceNow-side Governance API must approve, warn, or block the server-side JavaScript before it can run through the Scripted REST API.

The token is tied to the exact operation payload and expires after 10 minutes.

## Production

Production instances are read-only by default. If `OZ_INSTANCE_KIND=prod` or the instance alias/host looks like production, local writes are blocked.

## Telemetry

Telemetry is described as anonymous community learning data.

Collected:

- command type
- execution mode
- success/failure/block/warn outcome
- generic error codes
- anonymized counts
- governance decision type

Never collected:

- credentials
- raw prompts
- record values
- customer names
- user names
- script bodies
- business logic
- raw metadata dumps
