// Esegue uno script Node "scratch" fornito dall'utente del tool.
// Scrive il codice in un file temporaneo, lo lancia con `node`, cattura
// stdout/stderr, ed elimina sempre il file temporaneo.
//
// Lo script ha accesso a:
//   - `sheets`         (client googleapis Sheets v4 autenticato)
//   - `drive`          (client googleapis Drive v3 autenticato)
//   - `google`         (namespace googleapis)
//   - `spreadsheetId`  (string, passato dal chiamante)
//   - `auth`           (AuthClient autenticato — OAuth2Client o ServiceAccount)
//   - tutto il runtime Node (`require`, `process`, ecc.)
//
// Convenzione: lo script può stampare con console.log; per "ritornare" un valore
// strutturato, assegna a `result = ...`. Il runner stamperà il JSON di `result`
// alla fine. In alternativa termina con `process.exit(0)`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { getConfigPaths, getAuthMode } from "./auth.js";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  result?: unknown;
}

const HARNESS_PREFIX = `
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');

const __AUTH_MODE = process.env.__MCP_GSHEETS_AUTH_MODE;
const __SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];
const spreadsheetId = process.env.__MCP_GSHEETS_ID;

let auth, sheets, drive, result;
const __RESULT_SENTINEL = '__MCP_GSHEETS_RESULT__::';

(async () => {
  try {
    if (__AUTH_MODE === 'service_account') {
      const ga = new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        scopes: __SCOPES,
      });
      auth = await ga.getClient();
    } else {
      const __CFG_DIR = process.env.__MCP_GSHEETS_CFG_DIR;
      const __CRED = JSON.parse(fs.readFileSync(path.join(__CFG_DIR, 'gdrive-credentials.json'), 'utf8'));
      const __TOK = JSON.parse(fs.readFileSync(path.join(__CFG_DIR, 'gdrive-token.json'), 'utf8'));
      const __installed = __CRED.installed || __CRED.web;
      auth = new google.auth.OAuth2(__installed.client_id, __installed.client_secret, 'http://localhost:3456');
      auth.setCredentials(__TOK);
    }
    sheets = google.sheets({ version: 'v4', auth });
    drive = google.drive({ version: 'v3', auth });
`;

const HARNESS_SUFFIX = `
  } catch (err) {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  }
  if (typeof result !== 'undefined') {
    try { process.stdout.write('\\n' + __RESULT_SENTINEL + JSON.stringify(result) + '\\n'); }
    catch (e) { process.stdout.write('\\n' + __RESULT_SENTINEL + JSON.stringify(String(result)) + '\\n'); }
  }
})();
`;

const RESULT_SENTINEL = "__MCP_GSHEETS_RESULT__::";

export async function runUserScript(
  userCode: string,
  spreadsheetId: string,
  opts: { timeoutMs?: number } = {},
): Promise<RunResult> {
  const cfg = getConfigPaths();
  const tmpName = `.tmp-mcp-gsheets-${crypto.randomBytes(6).toString("hex")}.js`;
  const tmpPath = path.join(os.tmpdir(), tmpName);
  const full = HARNESS_PREFIX + "\n" + userCode + "\n" + HARNESS_SUFFIX;
  fs.writeFileSync(tmpPath, full, "utf8");

  const child = spawn(process.execPath, [tmpPath], {
    env: {
      ...process.env,
      __MCP_GSHEETS_AUTH_MODE: getAuthMode(),
      __MCP_GSHEETS_CFG_DIR: cfg.configDir,
      __MCP_GSHEETS_ID: spreadsheetId,
      NODE_PATH: nodePathForChild(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b) => (stdout += b.toString()));
  child.stderr.on("data", (b) => (stderr += b.toString()));

  const timeoutMs = opts.timeoutMs ?? 120_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  const exitCode: number | null = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
  clearTimeout(timer);

  try {
    fs.unlinkSync(tmpPath);
  } catch {
    /* best effort */
  }

  if (timedOut) {
    stderr += `\n[mcp-google-sheets] script killed after ${timeoutMs}ms timeout`;
  }

  // Estrai result se presente
  let result: unknown = undefined;
  let cleanedStdout = stdout;
  const idx = stdout.lastIndexOf(RESULT_SENTINEL);
  if (idx >= 0) {
    const after = stdout.slice(idx + RESULT_SENTINEL.length);
    const nl = after.indexOf("\n");
    const jsonStr = nl >= 0 ? after.slice(0, nl) : after;
    try {
      result = JSON.parse(jsonStr);
      cleanedStdout = stdout.slice(0, idx).replace(/\n$/, "");
    } catch {
      /* leave result undefined, keep stdout intact */
    }
  }

  return { stdout: cleanedStdout, stderr, exitCode, result };
}

// Permette allo script figlio di risolvere `googleapis` dal node_modules
// del MCP server (così l'utente non deve installarlo separatamente).
function nodePathForChild(): string {
  // dist/runner.js -> ../node_modules
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const guess1 = path.resolve(here, "..", "node_modules");
  const guess2 = path.resolve(here, "..", "..", "node_modules");
  const existing = [guess1, guess2].filter((p) => fs.existsSync(p));
  const extra = existing.join(path.delimiter);
  return process.env.NODE_PATH ? extra + path.delimiter + process.env.NODE_PATH : extra;
}
