# AGENTS.md

Instructions for AI agents (Claude Code, Cursor, etc.) installing or operating `mcp-google-sheets-full` on behalf of a user. Imperative, no marketing. Read top-to-bottom on first contact.

## Install + register (idempotent)

```bash
npm install -g mcp-google-sheets-full
claude mcp add google-sheets -- mcp-google-sheets-full --scope user
```

Replace the second line with the equivalent for the current MCP client (Cursor: edit `mcp.json`; Claude Desktop: edit `claude_desktop_config.json`). After registering, ask the user to restart the MCP client so the server is loaded.

## First call: detect setup state

Always call `auth_status` first when starting a session against this server. It tells you which auth mode is active and what is missing.

**OAuth mode response (default):**
```json
{
  "auth_mode": "oauth",
  "configDir": "C:\\Users\\<user>\\.mcp-google-sheets",
  "credentialsPath": ".../gdrive-credentials.json",
  "tokenPath": ".../gdrive-token.json",
  "service_account_key_path": null,
  "credentials_present": true|false,
  "token_present": true|false
}
```

- `credentials_present: false` → go to **OAuth setup** below.
- `credentials_present: true, token_present: false` → go to **First OAuth authorization** below.
- Both `true` → ready to operate.

**Service account mode response (env `GOOGLE_APPLICATION_CREDENTIALS` set):**
```json
{
  "auth_mode": "service_account",
  "service_account_key_path": "/path/to/sa-key.json",
  "service_account_key_present": true|false,
  "service_account_email": "xxx@yyy.iam.gserviceaccount.com"
}
```

- `service_account_key_present: false` → the env var points at a missing file. Tell the user the path and ask them to fix it.
- `service_account_key_present: true` → ready to operate, but **every spreadsheet must be shared with `service_account_email`** (Editor or Viewer). If a tool call returns 403, that's the cause.

## Auth mode selection

Do **not** prompt the user to pick a mode. The mode is determined automatically by whether `GOOGLE_APPLICATION_CREDENTIALS` is set in the server's process env:

- Set to a valid SA JSON path → service account mode.
- Unset / empty → OAuth mode (default).

If the user explicitly asks for one mode, instruct them to register the server with or without that env var in `claude_desktop_config.json` / `claude mcp add --env`. Restart the MCP client after changing it.

## OAuth setup (only when in OAuth mode and credentials_present is false)

This step is **manual and required**: there is no API to create OAuth clients programmatically. Print these instructions verbatim to the user; do not invent shortcuts.

1. Open <https://console.cloud.google.com/>. Create a project (any name) or pick an existing one.
2. **APIs & Services → Library**: enable **Google Sheets API** and **Google Drive API**.
3. **APIs & Services → OAuth consent screen**: "External", add the user's own Google email under "Test users".
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**: application type **Desktop app**. Any name.
5. Download the JSON.
6. Save it as the `credentialsPath` from `auth_status` (typically `~/.mcp-google-sheets/gdrive-credentials.json`).

After the user confirms the file is in place, call `auth_status` again to verify.

## First OAuth authorization (only when token_present is false)

Call any tool that hits Google (e.g. `get_spreadsheet` on a spreadsheet the user gives you). The server will:

- Open the user's default browser to a Google consent screen.
- Listen on `http://localhost:3456` for the callback.
- Persist `gdrive-token.json` on success.

Warn the user before the call: "A browser tab will open. Click Allow on the Google consent screen, then return here." Do **not** retry the tool repeatedly while waiting — one call is enough; the OAuth flow blocks until the user authorizes.

## Service account setup (only when in service account mode and key missing)

1. Google Cloud Console → **IAM & Admin → Service Accounts → Create service account**. Any name, no project roles needed.
2. Open the new service account → **Keys → Add Key → JSON**. Download the file.
3. Save it where `GOOGLE_APPLICATION_CREDENTIALS` points (or update the env var to match).
4. **Critical**: every spreadsheet the user wants the server to touch must be shared with the service account's `client_email` (visible inside the key JSON, also returned by `auth_status` after step 3). The bot only sees what's explicitly shared with it.

After step 3, call `auth_status` to verify `service_account_key_present: true` and read the `service_account_email` value to share with the user.

## Always-explicit spreadsheetId

Every tool that operates on a spreadsheet requires `spreadsheetId` as an explicit parameter. There is no implicit default. When the user says "the sheet" or pastes a URL:

- If a URL: call `resolve_url` to extract `spreadsheetId` + `gid`.
- If a name: call `search_spreadsheets` with `name_contains`. Disambiguate with the user if multiple matches.
- If nothing identifiable: ask the user for the URL.

Don't proceed without `spreadsheetId`.

## Tool selection guide

For typical operations, prefer the dedicated tool (clearer to the user, smaller payload):

| Want to... | Use |
| --- | --- |
| List tabs / inspect structure | `get_spreadsheet` |
| Read a range | `get_values` |
| Read many ranges | `batch_get_values` |
| Write a range | `update_values` |
| Write many ranges | `batch_update_values` |
| Append rows | `append_values` |
| Clear cells | `clear_values` |
| Add/delete/duplicate/rename tab | `add_sheet` / `delete_sheet` / `duplicate_sheet` / `rename_sheet` |
| Insert/delete rows or columns | `insert_rows` / `insert_columns` / `delete_rows` / `delete_columns` |
| Merge / unmerge / format / borders | `merge_cells` / `unmerge_cells` / `format_cells` / `set_borders` |
| Create new spreadsheet | `create_spreadsheet` |
| Find sheet by name | `search_spreadsheets` |
| Anything else (multi-step, exotic batchUpdate Request, Drive ops, analysis-then-write) | `run_sheets_script` |

`batch_update` accepts a raw Sheets API `Request[]` — use only if you know the exact JSON request schema. Otherwise `run_sheets_script` is friendlier (full Node, free composition).

## Using run_sheets_script

The escape hatch. Pre-injected scope: `sheets` (Sheets v4 client), `drive` (Drive v3 client), `google` (googleapis namespace), `auth` (OAuth2 client), `spreadsheetId` (string). Top-level `await` works. Assign `result = ...` to return a structured value.

Example: "merge all empty trailing rows of every tab".

```js
const meta = await sheets.spreadsheets.get({ spreadsheetId });
const requests = [];
for (const s of meta.data.sheets) {
  const props = s.properties;
  if (!props) continue;
  // ... build requests
}
if (requests.length) {
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}
result = { tabs_processed: meta.data.sheets.length };
```

Conventions:

- Don't `process.exit(0)` early — let the harness run and serialize `result`.
- `console.log` goes to stdout; `console.error` to stderr. Both are returned to you.
- The temp file is always deleted, so don't reference filesystem paths from one call to the next.

## Common failure modes

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `OAuth credentials not found at ...` | OAuth mode, step 6 of OAuth setup not done | Show OAuth setup |
| `Service account key file not found at ...` | SA mode, env var points at wrong path | Ask user to fix `GOOGLE_APPLICATION_CREDENTIALS` |
| 403 in **OAuth** mode | sheet not shared with user, or user authorized wrong Google account | Ask user to open the URL in their browser logged in with the right account |
| 403 in **service account** mode | sheet not shared with the bot email | Call `auth_status` to get `service_account_email`, tell the user to share the sheet with it as Editor |
| `EADDRINUSE :::3456` during first auth | something else on port 3456 | Ask user to close that process, retry |
| Token refresh failed | refresh token revoked | Delete `gdrive-token.json` and call any tool to re-trigger OAuth |
| `Sheet with name 'X' not found` from a tab-aware tool | tab renamed/missing | Call `get_spreadsheet` first, use exact title or numeric `sheet_id` |

## Don't

- Don't write spreadsheet IDs or OAuth tokens to chat, files, or memory persistence — they're per-user secrets.
- Don't call `clear_values` or `delete_*` tools without confirming with the user.
- Don't loop `auth_status` while waiting for the user to finish Cloud Console — wait for them to confirm completion.
- Don't suggest service accounts unless explicitly asked. The default flow is user OAuth.

## Verifying after install

Quick smoke test you can run without OAuth:

1. `auth_status` — returns paths, files presence.
2. `resolve_url` with a URL like `https://docs.google.com/spreadsheets/d/ABC123/edit#gid=42` — returns `{ spreadsheetId: "ABC123", gid: 42 }`.

If both succeed, the server is correctly registered.
