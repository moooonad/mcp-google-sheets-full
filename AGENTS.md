# AGENTS.md

Instructions for AI agents (Claude Code, Cursor, etc.) installing or operating `mcp-google-sheets-full` on behalf of a user. Imperative, no marketing. Read top-to-bottom on first contact.

## Install + register (idempotent)

```bash
npm install -g mcp-google-sheets-full
claude mcp add google-sheets -- mcp-google-sheets-full --scope user
```

Replace the second line with the equivalent for the current MCP client (Cursor: edit `mcp.json`; Claude Desktop: edit `claude_desktop_config.json`). After registering, ask the user to restart the MCP client so the server is loaded.

## First call: detect setup state

Always call `auth_status` first when starting a session against this server. The response tells you exactly what is missing:

```json
{
  "configDir": "C:\\Users\\<user>\\.mcp-google-sheets",
  "credentialsPath": ".../gdrive-credentials.json",
  "tokenPath": ".../gdrive-token.json",
  "credentials_present": true|false,
  "token_present": true|false
}
```

- `credentials_present: false` → go to **OAuth setup** below.
- `credentials_present: true, token_present: false` → go to **First authorization** below.
- Both `true` → ready to operate.

## OAuth setup (only when credentials_present is false)

This step is **manual and required**: there is no API to create OAuth clients programmatically. Print these instructions verbatim to the user; do not invent shortcuts.

1. Open <https://console.cloud.google.com/>. Create a project (any name) or pick an existing one.
2. **APIs & Services → Library**: enable **Google Sheets API** and **Google Drive API**.
3. **APIs & Services → OAuth consent screen**: "External", add the user's own Google email under "Test users".
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**: application type **Desktop app**. Any name.
5. Download the JSON.
6. Save it as the `credentialsPath` from `auth_status` (typically `~/.mcp-google-sheets/gdrive-credentials.json`).

After the user confirms the file is in place, call `auth_status` again to verify.

## First authorization (only when token_present is false)

Call any tool that hits Google (e.g. `get_spreadsheet` on a spreadsheet the user gives you). The server will:

- Open the user's default browser to a Google consent screen.
- Listen on `http://localhost:3456` for the callback.
- Persist `gdrive-token.json` on success.

Warn the user before the call: "A browser tab will open. Click Allow on the Google consent screen, then return here." Do **not** retry the tool repeatedly while waiting — one call is enough; the OAuth flow blocks until the user authorizes.

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
| `OAuth credentials not found at ...` | step 4 of OAuth setup not done | Show OAuth setup |
| 403 `The caller does not have permission` | OAuth scopes ok but file/sheet not shared with this Google account, or user opened wrong Google account in consent screen | Ask user to verify access to the URL in their browser, logged in with the same account |
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
