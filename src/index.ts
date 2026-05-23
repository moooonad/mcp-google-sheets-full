#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  getSheetsClient,
  getDriveClient,
  getConfigPaths,
  getServiceAccountEmail,
} from "./auth.js";
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

function escapeDriveLiteral(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// Build a field mask for repeatCell.fields based on the keys provided in a
// partial object. E.g. buildFieldMask("userEnteredFormat", { textFormat: { bold: true }, backgroundColor: {} })
// -> "userEnteredFormat.textFormat,userEnteredFormat.backgroundColor"
function buildFieldMask(prefix: string, obj: Record<string, unknown>): string {
  const parts = Object.keys(obj).map((k) => `${prefix}.${k}`);
  return parts.join(",");
}

const SPREADSHEET_ID_DESC =
  "Google Sheets spreadsheet ID (the string between /d/ and /edit in the URL). Always required and explicit — there is no default.";

// Resolve a sheet (tab) identifier: prefer numeric sheet_id, otherwise look up by name.
async function resolveSheetId(
  spreadsheetId: string,
  sheetId: number | undefined,
  sheetName: string | undefined,
): Promise<number> {
  if (typeof sheetId === "number") return sheetId;
  if (!sheetName) {
    throw new Error("Provide either sheet_id (numeric gid) or sheet_name.");
  }
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))",
  });
  const found = meta.data.sheets?.find((s) => s.properties?.title === sheetName);
  if (!found?.properties?.sheetId && found?.properties?.sheetId !== 0) {
    throw new Error(`Sheet with name '${sheetName}' not found in spreadsheet ${spreadsheetId}.`);
  }
  return found.properties.sheetId as number;
}

async function runRequests(spreadsheetId: string, requests: any[]) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
  return res.data;
}

const SHEET_REF_PROPS = {
  sheet_id: { type: "number", description: "Numeric sheet (tab) ID, i.e. the gid. Preferred." },
  sheet_name: { type: "string", description: "Tab name (used only if sheet_id is omitted)." },
};
const sheetRefZod = z.object({
  sheet_id: z.number().int().optional(),
  sheet_name: z.string().optional(),
});

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
    name: "list_spreadsheets",
    description:
      "List Google Sheets files in the user's Drive (most-recently-modified first). Returns id, name, modifiedTime, webViewLink. Use this when the user mentions a sheet by name without giving the ID.",
    inputSchema: {
      type: "object",
      properties: {
        page_size: { type: "number", description: "Max results (1-1000, default 50)." },
        order_by: {
          type: "string",
          description:
            "Drive 'orderBy' string, e.g. 'modifiedTime desc' (default), 'name', 'createdTime desc'.",
        },
        include_shared_drives: {
          type: "boolean",
          description: "Include items in Shared Drives. Default true.",
        },
      },
    },
    zod: z.object({
      page_size: z.number().int().min(1).max(1000).optional(),
      order_by: z.string().optional(),
      include_shared_drives: z.boolean().optional(),
    }),
    handler: async (a: any) => {
      const drive = await getDriveClient();
      const includeShared = a.include_shared_drives ?? true;
      const res = await drive.files.list({
        q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
        pageSize: a.page_size ?? 50,
        orderBy: a.order_by ?? "modifiedTime desc",
        fields: "files(id,name,modifiedTime,createdTime,owners(emailAddress,displayName),webViewLink,driveId)",
        includeItemsFromAllDrives: includeShared,
        supportsAllDrives: includeShared,
      });
      return ok(res.data.files ?? []);
    },
  },
  {
    name: "search_spreadsheets",
    description:
      "Search spreadsheets in the user's Drive by name (substring, case-insensitive) and/or full-text content. At least one of `name_contains` or `full_text` is required. Use this when the user refers to a sheet by part of its title.",
    inputSchema: {
      type: "object",
      properties: {
        name_contains: { type: "string", description: "Substring of the file name." },
        full_text: { type: "string", description: "Full-text search across spreadsheet content." },
        page_size: { type: "number", description: "Max results (1-1000, default 50)." },
        order_by: { type: "string", description: "Drive orderBy, default 'modifiedTime desc'." },
        include_shared_drives: { type: "boolean", description: "Default true." },
      },
    },
    zod: z
      .object({
        name_contains: z.string().optional(),
        full_text: z.string().optional(),
        page_size: z.number().int().min(1).max(1000).optional(),
        order_by: z.string().optional(),
        include_shared_drives: z.boolean().optional(),
      })
      .refine((v) => v.name_contains || v.full_text, {
        message: "Provide at least one of name_contains or full_text.",
      }),
    handler: async (a: any) => {
      const drive = await getDriveClient();
      const includeShared = a.include_shared_drives ?? true;
      const clauses = [
        "mimeType='application/vnd.google-apps.spreadsheet'",
        "trashed=false",
      ];
      if (a.name_contains) {
        clauses.push(`name contains '${escapeDriveLiteral(a.name_contains)}'`);
      }
      if (a.full_text) {
        clauses.push(`fullText contains '${escapeDriveLiteral(a.full_text)}'`);
      }
      const res = await drive.files.list({
        q: clauses.join(" and "),
        pageSize: a.page_size ?? 50,
        orderBy: a.order_by ?? "modifiedTime desc",
        fields: "files(id,name,modifiedTime,createdTime,owners(emailAddress,displayName),webViewLink,driveId)",
        includeItemsFromAllDrives: includeShared,
        supportsAllDrives: includeShared,
      });
      return ok(res.data.files ?? []);
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
    name: "add_sheet",
    description: "Add a new tab (sheet) to the spreadsheet. Returns the new sheetId.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        title: { type: "string", description: "Tab name." },
        index: { type: "number", description: "Optional 0-based position." },
        row_count: { type: "number", description: "Optional initial row count." },
        column_count: { type: "number", description: "Optional initial column count." },
      },
      required: ["spreadsheetId", "title"],
    },
    zod: z.object({
      spreadsheetId: z.string(),
      title: z.string(),
      index: z.number().int().min(0).optional(),
      row_count: z.number().int().min(1).optional(),
      column_count: z.number().int().min(1).optional(),
    }),
    handler: async (a: any) => {
      const props: any = { title: a.title };
      if (typeof a.index === "number") props.index = a.index;
      if (a.row_count || a.column_count) {
        props.gridProperties = {
          rowCount: a.row_count,
          columnCount: a.column_count,
        };
      }
      const res = await runRequests(a.spreadsheetId, [{ addSheet: { properties: props } }]);
      const added = (res.replies?.[0] as any)?.addSheet?.properties;
      return ok(added ?? res);
    },
  },
  {
    name: "delete_sheet",
    description: "Delete a tab. Pass either sheet_id (gid) or sheet_name.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        ...SHEET_REF_PROPS,
      },
      required: ["spreadsheetId"],
    },
    zod: sheetRefZod.extend({ spreadsheetId: z.string() }),
    handler: async (a: any) => {
      const sheetId = await resolveSheetId(a.spreadsheetId, a.sheet_id, a.sheet_name);
      return ok(await runRequests(a.spreadsheetId, [{ deleteSheet: { sheetId } }]));
    },
  },
  {
    name: "duplicate_sheet",
    description: "Duplicate a tab within the same spreadsheet. Returns the new sheetId.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        ...SHEET_REF_PROPS,
        new_title: { type: "string", description: "Title for the duplicated tab." },
        insert_index: { type: "number", description: "Optional 0-based position of the copy." },
      },
      required: ["spreadsheetId", "new_title"],
    },
    zod: sheetRefZod.extend({
      spreadsheetId: z.string(),
      new_title: z.string(),
      insert_index: z.number().int().min(0).optional(),
    }),
    handler: async (a: any) => {
      const sourceSheetId = await resolveSheetId(a.spreadsheetId, a.sheet_id, a.sheet_name);
      const req: any = {
        duplicateSheet: {
          sourceSheetId,
          newSheetName: a.new_title,
        },
      };
      if (typeof a.insert_index === "number") req.duplicateSheet.insertSheetIndex = a.insert_index;
      const res = await runRequests(a.spreadsheetId, [req]);
      const dup = (res.replies?.[0] as any)?.duplicateSheet?.properties;
      return ok(dup ?? res);
    },
  },
  {
    name: "rename_sheet",
    description: "Rename a tab.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        ...SHEET_REF_PROPS,
        new_title: { type: "string" },
      },
      required: ["spreadsheetId", "new_title"],
    },
    zod: sheetRefZod.extend({ spreadsheetId: z.string(), new_title: z.string() }),
    handler: async (a: any) => {
      const sheetId = await resolveSheetId(a.spreadsheetId, a.sheet_id, a.sheet_name);
      return ok(
        await runRequests(a.spreadsheetId, [
          {
            updateSheetProperties: {
              properties: { sheetId, title: a.new_title },
              fields: "title",
            },
          },
        ]),
      );
    },
  },
  {
    name: "insert_rows",
    description: "Insert N empty rows starting at start_index (0-based, half-open: rows [start_index, start_index+count) are inserted).",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        ...SHEET_REF_PROPS,
        start_index: { type: "number", description: "0-based row index where insertion begins." },
        count: { type: "number", description: "Number of rows to insert." },
        inherit_from_before: { type: "boolean", description: "If true, formatting inherited from row above. Default false." },
      },
      required: ["spreadsheetId", "start_index", "count"],
    },
    zod: sheetRefZod.extend({
      spreadsheetId: z.string(),
      start_index: z.number().int().min(0),
      count: z.number().int().min(1),
      inherit_from_before: z.boolean().optional(),
    }),
    handler: async (a: any) => {
      const sheetId = await resolveSheetId(a.spreadsheetId, a.sheet_id, a.sheet_name);
      return ok(
        await runRequests(a.spreadsheetId, [
          {
            insertDimension: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex: a.start_index,
                endIndex: a.start_index + a.count,
              },
              inheritFromBefore: a.inherit_from_before ?? false,
            },
          },
        ]),
      );
    },
  },
  {
    name: "insert_columns",
    description: "Insert N empty columns starting at start_index (0-based).",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        ...SHEET_REF_PROPS,
        start_index: { type: "number" },
        count: { type: "number" },
        inherit_from_before: { type: "boolean" },
      },
      required: ["spreadsheetId", "start_index", "count"],
    },
    zod: sheetRefZod.extend({
      spreadsheetId: z.string(),
      start_index: z.number().int().min(0),
      count: z.number().int().min(1),
      inherit_from_before: z.boolean().optional(),
    }),
    handler: async (a: any) => {
      const sheetId = await resolveSheetId(a.spreadsheetId, a.sheet_id, a.sheet_name);
      return ok(
        await runRequests(a.spreadsheetId, [
          {
            insertDimension: {
              range: {
                sheetId,
                dimension: "COLUMNS",
                startIndex: a.start_index,
                endIndex: a.start_index + a.count,
              },
              inheritFromBefore: a.inherit_from_before ?? false,
            },
          },
        ]),
      );
    },
  },
  {
    name: "delete_rows",
    description: "Delete rows in range [start_index, end_index) (0-based, half-open).",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        ...SHEET_REF_PROPS,
        start_index: { type: "number" },
        end_index: { type: "number" },
      },
      required: ["spreadsheetId", "start_index", "end_index"],
    },
    zod: sheetRefZod.extend({
      spreadsheetId: z.string(),
      start_index: z.number().int().min(0),
      end_index: z.number().int().min(1),
    }),
    handler: async (a: any) => {
      const sheetId = await resolveSheetId(a.spreadsheetId, a.sheet_id, a.sheet_name);
      return ok(
        await runRequests(a.spreadsheetId, [
          {
            deleteDimension: {
              range: { sheetId, dimension: "ROWS", startIndex: a.start_index, endIndex: a.end_index },
            },
          },
        ]),
      );
    },
  },
  {
    name: "delete_columns",
    description: "Delete columns in range [start_index, end_index) (0-based, half-open).",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        ...SHEET_REF_PROPS,
        start_index: { type: "number" },
        end_index: { type: "number" },
      },
      required: ["spreadsheetId", "start_index", "end_index"],
    },
    zod: sheetRefZod.extend({
      spreadsheetId: z.string(),
      start_index: z.number().int().min(0),
      end_index: z.number().int().min(1),
    }),
    handler: async (a: any) => {
      const sheetId = await resolveSheetId(a.spreadsheetId, a.sheet_id, a.sheet_name);
      return ok(
        await runRequests(a.spreadsheetId, [
          {
            deleteDimension: {
              range: { sheetId, dimension: "COLUMNS", startIndex: a.start_index, endIndex: a.end_index },
            },
          },
        ]),
      );
    },
  },
  {
    name: "merge_cells",
    description:
      "Merge a cell range. merge_type controls how: MERGE_ALL (default), MERGE_COLUMNS (merge each column), MERGE_ROWS (merge each row).",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        ...SHEET_REF_PROPS,
        start_row: { type: "number", description: "0-based inclusive." },
        end_row: { type: "number", description: "0-based exclusive." },
        start_column: { type: "number" },
        end_column: { type: "number" },
        merge_type: { type: "string", enum: ["MERGE_ALL", "MERGE_COLUMNS", "MERGE_ROWS"] },
      },
      required: ["spreadsheetId", "start_row", "end_row", "start_column", "end_column"],
    },
    zod: sheetRefZod.extend({
      spreadsheetId: z.string(),
      start_row: z.number().int().min(0),
      end_row: z.number().int().min(1),
      start_column: z.number().int().min(0),
      end_column: z.number().int().min(1),
      merge_type: z.enum(["MERGE_ALL", "MERGE_COLUMNS", "MERGE_ROWS"]).optional(),
    }),
    handler: async (a: any) => {
      const sheetId = await resolveSheetId(a.spreadsheetId, a.sheet_id, a.sheet_name);
      return ok(
        await runRequests(a.spreadsheetId, [
          {
            mergeCells: {
              range: {
                sheetId,
                startRowIndex: a.start_row,
                endRowIndex: a.end_row,
                startColumnIndex: a.start_column,
                endColumnIndex: a.end_column,
              },
              mergeType: a.merge_type ?? "MERGE_ALL",
            },
          },
        ]),
      );
    },
  },
  {
    name: "unmerge_cells",
    description: "Unmerge all merges within the given cell range.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        ...SHEET_REF_PROPS,
        start_row: { type: "number" },
        end_row: { type: "number" },
        start_column: { type: "number" },
        end_column: { type: "number" },
      },
      required: ["spreadsheetId", "start_row", "end_row", "start_column", "end_column"],
    },
    zod: sheetRefZod.extend({
      spreadsheetId: z.string(),
      start_row: z.number().int().min(0),
      end_row: z.number().int().min(1),
      start_column: z.number().int().min(0),
      end_column: z.number().int().min(1),
    }),
    handler: async (a: any) => {
      const sheetId = await resolveSheetId(a.spreadsheetId, a.sheet_id, a.sheet_name);
      return ok(
        await runRequests(a.spreadsheetId, [
          {
            unmergeCells: {
              range: {
                sheetId,
                startRowIndex: a.start_row,
                endRowIndex: a.end_row,
                startColumnIndex: a.start_column,
                endColumnIndex: a.end_column,
              },
            },
          },
        ]),
      );
    },
  },
  {
    name: "format_cells",
    description:
      "Apply a CellFormat to a range. Pass a partial CellFormat object as 'format' (e.g. { backgroundColor: { red: 1 }, textFormat: { bold: true, fontSize: 12 }, horizontalAlignment: 'CENTER', numberFormat: { type: 'NUMBER', pattern: '#,##0.00' } }). Only the provided keys are updated. See https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/cells#CellFormat.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        ...SHEET_REF_PROPS,
        start_row: { type: "number" },
        end_row: { type: "number" },
        start_column: { type: "number" },
        end_column: { type: "number" },
        format: {
          type: "object",
          additionalProperties: true,
          description: "Partial CellFormat. The keys you set determine the update mask.",
        },
      },
      required: ["spreadsheetId", "start_row", "end_row", "start_column", "end_column", "format"],
    },
    zod: sheetRefZod.extend({
      spreadsheetId: z.string(),
      start_row: z.number().int().min(0),
      end_row: z.number().int().min(1),
      start_column: z.number().int().min(0),
      end_column: z.number().int().min(1),
      format: z.record(z.any()),
    }),
    handler: async (a: any) => {
      const sheetId = await resolveSheetId(a.spreadsheetId, a.sheet_id, a.sheet_name);
      const fields = buildFieldMask("userEnteredFormat", a.format);
      return ok(
        await runRequests(a.spreadsheetId, [
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: a.start_row,
                endRowIndex: a.end_row,
                startColumnIndex: a.start_column,
                endColumnIndex: a.end_column,
              },
              cell: { userEnteredFormat: a.format },
              fields,
            },
          },
        ]),
      );
    },
  },
  {
    name: "set_borders",
    description:
      "Set borders on a range. Pass per-side Border objects in 'borders' (top/bottom/left/right/innerHorizontal/innerVertical). Each Border = { style: 'SOLID'|'DOTTED'|'DASHED'|'SOLID_MEDIUM'|'SOLID_THICK'|'DOUBLE'|'NONE', color?: { red,green,blue,alpha } }.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: SPREADSHEET_ID_DESC },
        ...SHEET_REF_PROPS,
        start_row: { type: "number" },
        end_row: { type: "number" },
        start_column: { type: "number" },
        end_column: { type: "number" },
        borders: {
          type: "object",
          additionalProperties: true,
          description: "Object with optional keys: top, bottom, left, right, innerHorizontal, innerVertical.",
        },
      },
      required: ["spreadsheetId", "start_row", "end_row", "start_column", "end_column", "borders"],
    },
    zod: sheetRefZod.extend({
      spreadsheetId: z.string(),
      start_row: z.number().int().min(0),
      end_row: z.number().int().min(1),
      start_column: z.number().int().min(0),
      end_column: z.number().int().min(1),
      borders: z.record(z.any()),
    }),
    handler: async (a: any) => {
      const sheetId = await resolveSheetId(a.spreadsheetId, a.sheet_id, a.sheet_name);
      return ok(
        await runRequests(a.spreadsheetId, [
          {
            updateBorders: {
              range: {
                sheetId,
                startRowIndex: a.start_row,
                endRowIndex: a.end_row,
                startColumnIndex: a.start_column,
                endColumnIndex: a.end_column,
              },
              ...a.borders,
            },
          },
        ]),
      );
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
      "Report the current auth configuration. Two modes: 'oauth' (default, interactive user account) or 'service_account' (GOOGLE_APPLICATION_CREDENTIALS env set, headless). Returns mode, expected file paths, and which files are present. Use to debug setup problems.",
    inputSchema: { type: "object", properties: {} },
    zod: z.object({}),
    handler: async () => {
      const fs = await import("node:fs");
      const cfg = getConfigPaths();
      const out: Record<string, unknown> = { ...cfg };
      if (cfg.auth_mode === "oauth") {
        out.credentials_present = fs.existsSync(cfg.credentialsPath);
        out.token_present = fs.existsSync(cfg.tokenPath);
      } else {
        out.service_account_key_present = !!cfg.service_account_key_path && fs.existsSync(cfg.service_account_key_path);
        out.service_account_email = getServiceAccountEmail();
      }
      return ok(out);
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
