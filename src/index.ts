#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getSheetsClient, getDriveClient, getConfigPaths } from "./auth.js";
import { runUserScript } from "./runner.js";

function ok(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

const SPREADSHEET_ID_DESC =
  "Google Sheets spreadsheet ID (the string between /d/ and /edit in the URL). Always required and explicit — there is no default.";

const tools = [
  {
    name: "get_spreadsheet",
    description:
      "Return spreadsheet metadata: title, list of sheets (tabs) with sheetId/title/index/gridProperties. Use this first when working on an unknown spreadsheet to discover tab names and gids. Set include_grid_data=true to also return cell data (large).",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        include_grid_data: { type: "boolean", description: "Include full grid data. Default false." },
        ranges: {
          type: "array",
          items: { type: "string" },
          description: "Optional A1 ranges to limit returned data.",
        },
      },
      required: ["spreadsheetId"],
    },
    zod: z.object({
      spreadsheetId: z.string(),
      include_grid_data: z.boolean().optional(),
      ranges: z.array(z.string()).optional(),
    }),
    handler: async (a: any) => {
      const sheets = await getSheetsClient();
      const res = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
        includeGridData: a.include_grid_data ?? false,
        ranges: a.ranges,
      });
      return ok(res.data);
    },
  },
  {
    name: "get_values",
    description:
      "Read values from an A1 range (e.g. 'Sheet1!A1:D100'). Returns a 2D array of cell values.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        range: { type: "string", description: "A1 range, e.g. 'Sheet1!A1:D100'." },
        value_render_option: {
          type: "string",
          enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"],
          description: "Default FORMATTED_VALUE.",
        },
      },
      required: ["spreadsheetId", "range"],
    },
    zod: z.object({
      spreadsheetId: z.string(),
      range: z.string(),
      value_render_option: z.enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"]).optional(),
    }),
    handler: async (a: any) => {
      const sheets = await getSheetsClient();
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: a.spreadsheetId,
        range: a.range,
        valueRenderOption: a.value_render_option,
      });
      return ok(res.data);
    },
  },
  {
    name: "batch_get_values",
    description: "Read multiple A1 ranges in one call.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        ranges: { type: "array", items: { type: "string" } },
        value_render_option: {
          type: "string",
          enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"],
        },
      },
      required: ["spreadsheetId", "ranges"],
    },
    zod: z.object({
      spreadsheetId: z.string(),
      ranges: z.array(z.string()),
      value_render_option: z.enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"]).optional(),
    }),
    handler: async (a: any) => {
      const sheets = await getSheetsClient();
      const res = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: a.spreadsheetId,
        ranges: a.ranges,
        valueRenderOption: a.value_render_option,
      });
      return ok(res.data);
    },
  },
  {
    name: "update_values",
    description:
      "Write a 2D array of values into an A1 range. Use value_input_option='USER_ENTERED' to evaluate formulas, 'RAW' to write literal strings.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        range: { type: "string" },
        values: {
          type: "array",
          items: { type: "array", items: {} },
          description: "2D array of cell values (rows of columns).",
        },
        value_input_option: {
          type: "string",
          enum: ["USER_ENTERED", "RAW"],
          description: "Default USER_ENTERED.",
        },
      },
      required: ["spreadsheetId", "range", "values"],
    },
    zod: z.object({
      spreadsheetId: z.string(),
      range: z.string(),
      values: z.array(z.array(z.any())),
      value_input_option: z.enum(["USER_ENTERED", "RAW"]).optional(),
    }),
    handler: async (a: any) => {
      const sheets = await getSheetsClient();
      const res = await sheets.spreadsheets.values.update({
        spreadsheetId: a.spreadsheetId,
        range: a.range,
        valueInputOption: a.value_input_option ?? "USER_ENTERED",
        requestBody: { values: a.values },
      });
      return ok(res.data);
    },
  },
  {
    name: "batch_update_values",
    description: "Update multiple A1 ranges in one call. Each item is { range, values }.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        data: {
          type: "array",
          items: {
            type: "object",
            properties: {
              range: { type: "string" },
              values: { type: "array", items: { type: "array", items: {} } },
            },
            required: ["range", "values"],
          },
        },
        value_input_option: { type: "string", enum: ["USER_ENTERED", "RAW"] },
      },
      required: ["spreadsheetId", "data"],
    },
    zod: z.object({
      spreadsheetId: z.string(),
      data: z.array(z.object({ range: z.string(), values: z.array(z.array(z.any())) })),
      value_input_option: z.enum(["USER_ENTERED", "RAW"]).optional(),
    }),
    handler: async (a: any) => {
      const sheets = await getSheetsClient();
      const res = await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: {
          valueInputOption: a.value_input_option ?? "USER_ENTERED",
          data: a.data,
        },
      });
      return ok(res.data);
    },
  },
  {
    name: "append_values",
    description: "Append rows to the end of a table. The range is used as the search hint.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        range: { type: "string" },
        values: { type: "array", items: { type: "array", items: {} } },
        value_input_option: { type: "string", enum: ["USER_ENTERED", "RAW"] },
        insert_data_option: { type: "string", enum: ["OVERWRITE", "INSERT_ROWS"] },
      },
      required: ["spreadsheetId", "range", "values"],
    },
    zod: z.object({
      spreadsheetId: z.string(),
      range: z.string(),
      values: z.array(z.array(z.any())),
      value_input_option: z.enum(["USER_ENTERED", "RAW"]).optional(),
      insert_data_option: z.enum(["OVERWRITE", "INSERT_ROWS"]).optional(),
    }),
    handler: async (a: any) => {
      const sheets = await getSheetsClient();
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId: a.spreadsheetId,
        range: a.range,
        valueInputOption: a.value_input_option ?? "USER_ENTERED",
        insertDataOption: a.insert_data_option,
        requestBody: { values: a.values },
      });
      return ok(res.data);
    },
  },
  {
    name: "clear_values",
    description: "Clear all values from one or more A1 ranges. Pass a single range or use ranges[].",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        range: { type: "string" },
        ranges: { type: "array", items: { type: "string" } },
      },
      required: ["spreadsheetId"],
    },
    zod: z.object({
      spreadsheetId: z.string(),
      range: z.string().optional(),
      ranges: z.array(z.string()).optional(),
    }),
    handler: async (a: any) => {
      const sheets = await getSheetsClient();
      if (a.ranges?.length) {
        const res = await sheets.spreadsheets.values.batchClear({
          spreadsheetId: a.spreadsheetId,
          requestBody: { ranges: a.ranges },
        });
        return ok(res.data);
      }
      if (!a.range) {
        throw new Error("Provide either 'range' or 'ranges'.");
      }
      const res = await sheets.spreadsheets.values.clear({
        spreadsheetId: a.spreadsheetId,
        range: a.range,
      });
      return ok(res.data);
    },
  },
  {
    name: "batch_update",
    description:
      "Run a structural batchUpdate on the spreadsheet (add/delete sheets, formatting, merges, freeze, conditional formatting, etc.). 'requests' is the Google Sheets API batchUpdate request array. See https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/request.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        requests: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Array of Request objects per the Sheets API.",
        },
        include_spreadsheet_in_response: { type: "boolean" },
        response_ranges: { type: "array", items: { type: "string" } },
        response_include_grid_data: { type: "boolean" },
      },
      required: ["spreadsheetId", "requests"],
    },
    zod: z.object({
      spreadsheetId: z.string(),
      requests: z.array(z.record(z.any())),
      include_spreadsheet_in_response: z.boolean().optional(),
      response_ranges: z.array(z.string()).optional(),
      response_include_grid_data: z.boolean().optional(),
    }),
    handler: async (a: any) => {
      const sheets = await getSheetsClient();
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: {
          requests: a.requests,
          includeSpreadsheetInResponse: a.include_spreadsheet_in_response,
          responseRanges: a.response_ranges,
          responseIncludeGridData: a.response_include_grid_data,
        },
      });
      return ok(res.data);
    },
  },
  {
    name: "create_spreadsheet",
    description: "Create a new spreadsheet owned by the authenticated user. Returns the new spreadsheetId and URL.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        sheet_titles: {
          type: "array",
          items: { type: "string" },
          description: "Optional initial tab names. If omitted, one default sheet is created.",
        },
      },
      required: ["title"],
    },
    zod: z.object({
      title: z.string(),
      sheet_titles: z.array(z.string()).optional(),
    }),
    handler: async (a: any) => {
      const sheets = await getSheetsClient();
      const res = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title: a.title },
          sheets: a.sheet_titles?.map((t: string) => ({ properties: { title: t } })),
        },
      });
      return ok({
        spreadsheetId: res.data.spreadsheetId,
        spreadsheetUrl: res.data.spreadsheetUrl,
        sheets: res.data.sheets?.map((s) => s.properties),
      });
    },
  },
  {
    name: "run_sheets_script",
    description:
      "Escape hatch: execute an arbitrary Node.js script with full Google Sheets/Drive access. Use when no dedicated tool covers the operation, or when multiple coordinated calls are needed. The script runs in a fresh Node process with these globals already prepared: `sheets` (Sheets v4 client), `drive` (Drive v3 client), `google` (googleapis namespace), `auth` (OAuth2Client), `spreadsheetId` (string). Use `await` freely — the harness wraps your code in an async IIFE. To return a structured value to the caller, assign to `result` (e.g. `result = { rows: 12 };`). console.log output is captured as stdout. The temp file is always deleted, even on error.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        code: {
          type: "string",
          description:
            "Node.js source code. Has access to: sheets, drive, google, auth, spreadsheetId. Use top-level await. Assign to `result` to return a value.",
        },
        timeout_ms: { type: "number", description: "Default 120000 (2 min). Max 600000." },
      },
      required: ["spreadsheetId", "code"],
    },
    zod: z.object({
      spreadsheetId: z.string(),
      code: z.string(),
      timeout_ms: z.number().int().positive().max(600_000).optional(),
    }),
    handler: async (a: any) => {
      // Garantisce che il token esista/sia fresco prima di lanciare il child.
      await getSheetsClient();
      const r = await runUserScript(a.code, a.spreadsheetId, { timeoutMs: a.timeout_ms });
      if (r.exitCode !== 0) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                `Script exited with code ${r.exitCode}.\n` +
                `--- stdout ---\n${r.stdout}\n` +
                `--- stderr ---\n${r.stderr}`,
            },
          ],
        };
      }
      return ok({
        exitCode: r.exitCode,
        result: r.result,
        stdout: r.stdout,
        stderr: r.stderr,
      });
    },
  },
  {
    name: "resolve_url",
    description:
      "Parse a Google Sheets URL and extract spreadsheetId and gid (tab id). Convenience helper so the user can paste a URL and the caller can grab the IDs.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    zod: z.object({ url: z.string() }),
    handler: async (a: any) => {
      const m = a.url.match(/\/d\/([a-zA-Z0-9-_]+)/);
      const gidMatch = a.url.match(/[?#&]gid=(\d+)/);
      if (!m) throw new Error("URL does not look like a Google Sheets URL (missing /d/<id>).");
      return ok({
        spreadsheetId: m[1],
        gid: gidMatch ? Number(gidMatch[1]) : null,
      });
    },
  },
  {
    name: "auth_status",
    description:
      "Report the current auth configuration: where credentials/token are expected on disk and whether they exist. Use to debug setup problems.",
    inputSchema: { type: "object", properties: {} },
    zod: z.object({}),
    handler: async () => {
      const fs = await import("node:fs");
      const cfg = getConfigPaths();
      return ok({
        ...cfg,
        credentials_present: fs.existsSync(cfg.credentialsPath),
        token_present: fs.existsSync(cfg.tokenPath),
      });
    },
  },
];

const server = new Server(
  { name: "mcp-google-sheets", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
  const args = tool.zod.parse(req.params.arguments ?? {});
  try {
    return await tool.handler(args);
  } catch (e: any) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: e?.message ?? String(e) }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("mcp-google-sheets ready");
