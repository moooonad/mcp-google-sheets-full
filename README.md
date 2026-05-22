# mcp-google-sheets

MCP server that gives any Claude session full read/write access to Google Sheets via the user's own Google account (OAuth Desktop flow — no service account needed).

It exposes:

- **Convenience tools** for the common operations: `get_spreadsheet`, `get_values`, `batch_get_values`, `update_values`, `batch_update_values`, `append_values`, `clear_values`, `batch_update` (structural), `create_spreadsheet`, `resolve_url`, `auth_status`.
- **`run_sheets_script`** — escape hatch that runs an arbitrary Node.js script with authenticated `sheets` / `drive` / `google` / `auth` / `spreadsheetId` already in scope. The script is written to a temp file, executed with `node`, and always deleted. This is how the underlying `gsheet-editor` agent operated; the MCP server preserves that "do anything the Sheets API allows" capability.

`spreadsheetId` is **always an explicit parameter** of every tool — there is no default.

## Setup (one-time)

### 1. Install from the repo

Installs globally and puts an `mcp-google-sheets` executable in your PATH. The TypeScript build runs automatically via the `prepare` npm hook.

```bash
# SSH (you must have access to the GitLab repo)
npm install -g git+ssh://git@gitlab.com/webapp-srl/tools/mcp-google-sheets.git

# or HTTPS
npm install -g git+https://gitlab.com/webapp-srl/tools/mcp-google-sheets.git
```

To update later, run the same command again. To uninstall: `npm uninstall -g mcp-google-sheets`.

(For local development, clone the repo and run `npm install && npm run build`.)

### 2. Create an OAuth Client ID (Desktop app)

This replaces the service-account flow that most "Google Sheets MCP" servers require. You only do this once per machine.

1. Go to <https://console.cloud.google.com/>, create or select a project.
2. **APIs & Services → Library**: enable **Google Sheets API** and **Google Drive API**.
3. **APIs & Services → OAuth consent screen**: set up an "External" app (or "Internal" if you have a Workspace). Add yourself as a test user.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Desktop app**.
   - Name: anything (e.g. `mcp-google-sheets`).
5. Download the JSON.
6. Save it to:
   - Windows: `%USERPROFILE%\.mcp-google-sheets\gdrive-credentials.json`
   - macOS / Linux: `~/.mcp-google-sheets/gdrive-credentials.json`

   (Override the directory via env `GSHEETS_CONFIG_DIR`.)

### 3. First-run authorization

The first time any tool runs, the server opens your browser to grant access. The resulting token is saved to `gdrive-token.json` next to the credentials. Subsequent runs refresh silently.

If a refresh fails (e.g. the token was revoked), delete `gdrive-token.json` and the next call re-runs the browser flow.

## Register the server

After global install the `mcp-google-sheets` binary is on PATH.

### Claude Code (project or user scope)

```bash
claude mcp add google-sheets -- mcp-google-sheets
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "google-sheets": {
      "command": "mcp-google-sheets"
    }
  }
}
```

If the `mcp-google-sheets` command is not found by Claude Desktop (it sometimes ignores PATH on macOS/Windows), use the absolute path npm reported with `npm bin -g` plus `/mcp-google-sheets` (or `.cmd` on Windows).

Optional env:

- `GSHEETS_CONFIG_DIR` — override the directory where credentials/token live.

## Using `run_sheets_script`

When the caller needs to do something not covered by the convenience tools (multi-step operations, custom batchUpdate composition, Drive operations, ad-hoc analysis), it passes a chunk of Node code. The harness pre-creates an authenticated context, so the script body itself just uses `sheets`, `drive`, `spreadsheetId`. Assign to `result` to return a structured value.

Example body:

```js
// List all tabs and their first row
const meta = await sheets.spreadsheets.get({ spreadsheetId });
const headers = {};
for (const s of meta.data.sheets) {
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${s.properties.title}!1:1`,
  });
  headers[s.properties.title] = r.data.values?.[0] ?? [];
}
result = headers;
```

The harness wraps the code in an async IIFE, so top-level `await` works directly. Errors are reported with stack trace and non-zero exit code. The temp file is removed in every path.

## Provided tools

| Tool | Purpose |
| --- | --- |
| `auth_status` | Where the server looks for credentials/token and whether they exist. |
| `resolve_url` | Extract `spreadsheetId` + `gid` from a Google Sheets URL. |
| `list_spreadsheets` | List spreadsheets in the user's Drive (recent-first). |
| `search_spreadsheets` | Search spreadsheets by name substring or full-text content. |
| `get_spreadsheet` | Spreadsheet metadata (tabs, gridProperties). |
| `get_values` | Read one A1 range. |
| `batch_get_values` | Read multiple ranges. |
| `update_values` | Write a 2D array to a range. |
| `batch_update_values` | Write multiple ranges in one call. |
| `append_values` | Append rows to the end of a table. |
| `clear_values` | Clear one or more ranges. |
| `batch_update` | Structural changes (raw Sheets API `Request[]`) — escape hatch for any Request type not covered by a dedicated tool. |
| `create_spreadsheet` | Create a new spreadsheet owned by the user. |
| `add_sheet` / `delete_sheet` / `duplicate_sheet` / `rename_sheet` | Manage tabs (accept `sheet_id` gid or `sheet_name`). |
| `insert_rows` / `insert_columns` / `delete_rows` / `delete_columns` | Manage rows/columns by 0-based index ranges. |
| `merge_cells` / `unmerge_cells` | Merge ranges (MERGE_ALL / MERGE_COLUMNS / MERGE_ROWS). |
| `format_cells` | Apply a partial `CellFormat` to a range (background, textFormat, alignment, numberFormat, ...). |
| `set_borders` | Set borders on a range (top/bottom/left/right/innerHorizontal/innerVertical). |
| `run_sheets_script` | Run arbitrary Node code with pre-authenticated `sheets`/`drive`/`auth`/`spreadsheetId`. |

## Notes

- The OAuth flow listens on `http://localhost:3456` during initial authorization. Make sure that port is free.
- Scopes requested: `https://www.googleapis.com/auth/spreadsheets` and `https://www.googleapis.com/auth/drive`.
- `run_sheets_script` runs a fresh `node` process per call. It re-uses the same `~/.mcp-google-sheets/` credentials and token. There's a configurable timeout (default 2 min, max 10 min).
