# OperatorZero ServiceNow Plugin

OperatorZero ServiceNow Plugin turns Claude Code into a safer ServiceNow development assistant.

Prompt Claude Code in normal language. When the task involves ServiceNow, the plugin activates in the background to gather live instance evidence, check the planned change, ask before writes, run approved changes, and verify the result.

```text
inspect the incident table schema and explain the assignment fields
find a safe dev incident, update work_notes after approval, and verify it
explain why this business rule may be affecting assignment
```

## Why use it

ServiceNow work is risky when an AI assistant can guess, write directly, or skip verification. OperatorZero adds a ServiceNow-specific workflow around Claude Code:

- It reads live ServiceNow records and schema before acting.
- It uses your ServiceNow SDK login by default.
- It separates read-only investigation from writes.
- It requires a safety or governance check before every write or script run.
- It asks for explicit approval before execution.
- It verifies changes after execution.
- It keeps production read-only by default.
- It stores only sanitized local history.

OperatorZero is governance-first for team use. `/now setup` can deploy the ServiceNow-side Governance API so approve, warn, or block decisions happen inside ServiceNow before changes run. If governance is not installed yet, OperatorZero can still use local safety checks for quick starts and individual development.

OperatorZero exposes bounded ServiceNow operations for normal record work: query, get, schema, insert, update, upsert, and delete. In Governance mode, it can also choose governed ServiceNow server-side scripting through `now_script` when that is the simpler or safer path. The script is checked by the ServiceNow-side Governance API before it can run.

## Quick install

Requirements:

- Node.js 20.18.0 or newer.
- npm.
- Claude Code or another MCP-capable client.
- Access to a ServiceNow instance.

Install it from Claude Code:

```text
/plugin marketplace add mitchellOpZero/operatorzero-servicenow-plugin
/plugin install now@mitchellOpZero-operatorzero-servicenow-plugin
```

The setup flow handles the local OperatorZero tool server and Claude Code connection for you. You should not need to manually copy MCP JSON for the normal install path.

Local install from source:

```bash
git clone https://github.com/mitchellOpZero/operatorzero-servicenow-plugin.git
cd operatorzero-servicenow-plugin
npm install
npm run setup
```

Sign in with the ServiceNow SDK if you have not already:

```bash
npx --yes @servicenow/sdk@4.8.0 auth --add https://dev000000.service-now.com
```

Then open Claude Code and run:

```text
/now setup
```

`/now setup` handles setup from inside Claude Code. It checks your local build, Node version, ServiceNow SDK login, selected mode, privacy settings, and OperatorZero tool connection. It can also deploy the ServiceNow-side Governance API so ServiceNow can approve, warn, or block changes before execution. If anything is missing, it tells you the next command to run.

The plugin runs a bounded local MCP server in the background. That MCP server uses your ServiceNow auth and gives Claude Code controlled operations for evidence, safety checks, approved execution, and verification instead of raw credentials or unrestricted scripts.

## Common workflows

### Inspect and explain

```text
inspect the incident table schema and explain fields related to assignment
query recent active catalog tasks and summarize the assignment pattern
explain what this record depends on before I change it
```

OperatorZero will use read-only tools to gather ServiceNow evidence before answering.

### Make an approved change

```text
update this dev incident's work_notes with "Validated by OperatorZero" after approval, then verify it
```

For writes, OperatorZero should:

1. Gather evidence first.
2. Show the target table, target record or query, and fields to change.
3. Run a safety or governance check.
4. Ask for explicit approval.
5. Execute only with a matching one-use approval token.
6. Re-read the result to verify.
7. Store sanitized local history.

### Run governed server-side scripts

Use this when a change is easier as ServiceNow server-side JavaScript than as a simple record operation.

```text
find inactive catalog items matching this query, explain the impact, run the simplest governed change, and verify the result
```

OperatorZero can use the Table API for normal record reads and writes, and SDK mode for source-controlled app work. In Governance mode, it can also choose the governed script path when that is the simpler or safer way to complete the task.

For governed scripts, OperatorZero sends the planned server-side JavaScript to the ServiceNow-side Governance API first. If governance approves or warns, OperatorZero asks for explicit approval, then runs it through the governed Scripted REST API. If governance blocks it, OperatorZero stops.

### Review recent activity

```text
/now history
/now show last
/now explain last
```

History is local and sanitized. It records operation type, mode, table name, field names, decisions, warnings, and outcomes. It does not store credentials, raw prompts, record values, customer names, user names, script bodies, business logic, or raw metadata dumps.

## Configuration

Most users only need the ServiceNow SDK login. OperatorZero reuses the SDK default login automatically, and `/now setup` walks through the rest.

Advanced teams can still override the mode, SDK alias, instance kind, fallback auth, telemetry, storage directory, or query limits with environment variables. See `.env.example` for the full list. Do not commit `.env` files or credentials.

## Modes

### Governance mode

Recommended for teams. OperatorZero can deploy the ServiceNow-side Governance API during `/now setup`, then use it as the policy boundary for direct changes and governed server-side scripts. ServiceNow makes the approve, warn, or block decision before execution.

### Local safety mode

Good for quick starts, PDIs, and individual development before governance is installed. OperatorZero reads and writes through the ServiceNow Table API with local safety checks, explicit approval, and verification.

### SDK mode

For source-controlled ServiceNow SDK app work. OperatorZero keeps the SDK login as the primary authenticated context.

## ServiceNow Governance API

Governance mode is the recommended team path. `/now setup` can deploy the ServiceNow-side Governance API to a PDI, dev, or sub-production instance. That gives team leads a ServiceNow-side policy boundary for approve, warn, or block decisions before writes or governed server-side scripts run. You need permission to create or update Script Includes and Scripted REST APIs.

You can still use OperatorZero without installing anything inside ServiceNow. In that case, local safety checks are built in and the plugin uses the Table API for approved dev/sub-production changes.

## Safety and privacy

OperatorZero enforces these local safeguards:

- Production instances are read-only by default.
- Writes to credential-like fields are blocked.
- Sensitive platform tables are blocked for local direct writes.
- Deletes require a `sys_id`.
- Upserts require a `sys_id` or query.
- Approval tokens are tied to the exact operation payload.
- Approval tokens are one-use and expire after 10 minutes.

OperatorZero calls telemetry “anonymous community learning data.” By default, it is stored locally in `~/.operatorzero/telemetry.jsonl` unless `OZ_STORAGE_DIR` is set.

It never stores credentials, raw prompts, record values, customer names, user names, script bodies, business logic, or raw metadata dumps.

Manage privacy from Claude Code:

```text
/now privacy
```

Or disable telemetry with:

```bash
export OZ_TELEMETRY=false
```

## Troubleshooting

Start here:

```text
/now doctor
/now setup
```

OperatorZero will check the plugin connection, local build, Node version, SDK login, privacy settings, selected mode, and governance path. If something is missing, it gives you the next command to run.

Common fixes:

```bash
# Build or refresh the local MCP server
npm install
npm run setup

# Check or add ServiceNow SDK auth
npx --yes @servicenow/sdk@4.8.0 auth --list
npx --yes @servicenow/sdk@4.8.0 auth --add https://dev000000.service-now.com
```

If you use multiple ServiceNow SDK logins, choose the right SDK alias in your shell or environment file:

```bash
export OZ_SN_AUTH_ALIAS=dev
```

If your team cannot use ServiceNow SDK auth, fallback Basic or Bearer auth is supported:

```bash
export OZ_SN_INSTANCE_URL=https://dev000000.service-now.com
export SN_USER=integration_user
export SN_PASS=replace_me

# or
export SN_BEARER_TOKEN=replace_me
```

If a custom MCP client cannot start OperatorZero, run `npm run mcp:config` and point that client at `.operatorzero/mcp.config.json`. Claude Code users should not normally need this.

If writes are blocked, check:

- The instance is not classified as production.
- The target table is allowed for the selected mode.
- The field names do not look like credentials or secrets.
- The request passed safety or governance checks first.
- The approval token matches the exact operation payload.
- The token has not expired and has not already been used.

For the most recent blocked or completed action:

```text
/now explain last
```

## License

MIT © OperatorZero.

OperatorZero is not affiliated with or endorsed by ServiceNow, Inc. ServiceNow is a trademark of ServiceNow, Inc.; it is used here only to describe compatibility.
