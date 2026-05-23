# mcp-google-sheets-full

> The Google Sheets MCP server that can do **anything** the Sheets API can.

26 tools spanning read/write, structural batchUpdate, Drive search, and an escape hatch (`run_sheets_script`) that executes arbitrary Node.js code with `sheets` / `drive` / `auth` / `spreadsheetId` pre-injected. Two auth modes: **OAuth** (default, your own Google account, zero per-sheet setup) or **service account** (opt-in, for headless / CI).

## Why this server

Most Google Sheets MCP servers expose a curated set of operations and stop there. If you need something they didn't anticipate (a particular conditional-format request, a multi-step migration, a Drive-side operation, an analysis-then-write workflow), you're stuck.

This server adds the missing primitive: **`run_sheets_script`**. Pass a snippet of Node code, get back the result. The Sheets v4 and Drive v3 clients are already authenticated and in scope. The temp file is always cleaned up.

| | **`mcp-google-sheets-full`** | `freema/mcp-gsheets` | `xing5/mcp-google-sheets` | `ringo380/claude-google-sheets-mcp` |
| --- | :-: | :-: | :-: | :-: |
| Read / write / append / clear | ✅ | ✅ | ✅ | ✅ |
| Structural `batchUpdate` (raw) | ✅ | partial | ❌ | ❌ |
| Granular tabs / rows / format / borders | ✅ | ✅ | partial | ❌ |
| Drive search (`list` / `search_spreadsheets`) | ✅ | ❌ | partial | ❌ |
| Arbitrary code execution (`run_sheets_script`) | ✅ | ❌ | ❌ | ❌ |
| Auth modes | ✅ OAuth default + service account opt-in | service-account-first | both | both |
| Language | TypeScript / Node | TypeScript / Node | Python | Python |

`spreadsheetId` is **always an explicit parameter** of every tool — there is no hidden default.

## Security model

`run_sheets_script` executes Node code on the machine where the MCP server runs, under your user account, against your OAuth token. The trust boundary is the same as any tool that lets Claude run code on your behalf (`Bash`, `Edit`, `Write`):

- The script can only do what the OAuth scopes allow (Sheets + Drive). It cannot touch your other Google services, your filesystem outside `tmpdir`, or the network in ways the host node process can't.
- Every script gets a fresh temp file in `os.tmpdir()`, executed via `node`, deleted on completion (success or failure).
- There is a per-call timeout (default 2 min, max 10 min).
- The token never leaves disk: the OAuth file lives in `~/.mcp-google-sheets/`.

If you're not comfortable with code execution, simply don't call `run_sheets_script` — the other 25 tools cover the common cases without it.

## For AI agents

If you're an AI agent (Claude Code, Cursor, etc.) installing or operating this server for a user, read [`AGENTS.md`](./AGENTS.md). It contains the canonical step-by-step setup flow, tool selection guide, common failure modes, and the trust/security expectations.

## Setup (one-time)

### 1. Install

```bash
npm install -g mcp-google-sheets-full
```

This places an `mcp-google-sheets-full` executable on your PATH. To update: re-run the same command. To remove: `npm uninstall -g mcp-google-sheets-full`.

For development: clone the repo and run `npm install && npm run build`.

### 2. Choose an auth mode

Two ways to authenticate the server. **Pick exactly one** depending on how you will use it.

| | OAuth (default) | Service account |
| --- | --- | --- |
| Best for | Claude Desktop / Code / Cursor on your laptop | CI, cron, serverless, headless automation |
| Setup effort | 1 file in `~/.mcp-google-sheets/` | 1 file anywhere + 1 env var |
| Acts as | **You** (your Google account) | A **bot identity** |
| Sees | Every sheet you can see | Only sheets explicitly shared with the bot email |
| Requires a browser? | Yes (once, on first call) | Never |
| Token refresh | Automatic | N/A |

Selection is automatic: if the env var `GOOGLE_APPLICATION_CREDENTIALS` is set, the server uses **service account** mode; otherwise it uses **OAuth** mode.

#### OAuth setup

1. Go to <https://console.cloud.google.com/>, create or select a project.
2. **APIs & Services → Library**: enable **Google Sheets API** and **Google Drive API**.
3. **APIs & Services → OAuth consent screen**: set up an "External" app (or "Internal" if you have a Workspace). Add yourself as a test user.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Desktop app**.
   - Name: anything.
5. Download the JSON.
6. Save it to:
   - Windows: `%USERPROFILE%\.mcp-google-sheets\gdrive-credentials.json`
   - macOS / Linux: `~/.mcp-google-sheets/gdrive-credentials.json`

   (Override the directory via env `GSHEETS_CONFIG_DIR`.)

The first time any tool runs, the server opens your browser to grant access. The resulting token is saved to `gdrive-token.json` next to the credentials. Subsequent runs refresh silently. If a refresh fails (e.g. the token was revoked), delete `gdrive-token.json` and the next call re-triggers the browser flow.

#### Service account setup (opt-in, headless)

1. In Google Cloud Console, enable **Google Sheets API** and **Google Drive API** on your project (same as OAuth).
2. **IAM & Admin → Service Accounts → Create service account**. Give it a name; no roles needed at the project level for our use case.
3. Open the service account → **Keys → Add Key → JSON**. Download the file.
4. Place the file anywhere readable (e.g. `~/.mcp-google-sheets/sa-key.json` or a CI secret path).
5. Set the env var when launching the server:
   - Shell: `export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/sa-key.json`
   - Claude config: add it under the server entry (see below).
6. **Share every spreadsheet you want the server to access with the service account's email** (visible inside the key JSON as `client_email`, looks like `xxx@yyy.iam.gserviceaccount.com`). Without this, calls return 403 even though the credentials are valid.

There is no token file in this mode; the server gets fresh access tokens on demand. No browser flow.

## Register the server

After global install the `mcp-google-sheets-full` binary is on PATH.

### Claude Code (project or user scope)

```bash
claude mcp add google-sheets -- mcp-google-sheets-full
```

### Claude Desktop (`claude_desktop_config.json`)

OAuth mode (default):

```json
{
  "mcpServers": {
    "google-sheets": {
      "command": "mcp-google-sheets-full"
    }
  }
}
```

Service account mode — add the env var to switch the server into headless auth:

```json
{
  "mcpServers": {
    "google-sheets": {
      "command": "mcp-google-sheets-full",
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "/absolute/path/to/sa-key.json"
      }
    }
  }
}
```

If Claude Desktop can't find the command (it sometimes ignores PATH on macOS/Windows), use the absolute path from `npm bin -g` followed by `/mcp-google-sheets-full` (or `.cmd` on Windows).

Recognized env vars:

- `GOOGLE_APPLICATION_CREDENTIALS` — if set to a service account JSON key path, the server switches to service account mode. If unset, OAuth mode.
- `GSHEETS_CONFIG_DIR` — override the directory where OAuth credentials/token live (default: `~/.mcp-google-sheets`).

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
