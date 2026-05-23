// Two auth modes:
//
//   1. OAuth Desktop (default)
//      - For interactive use (Claude Desktop, Claude Code, Cursor).
//      - User downloads an OAuth Client ID JSON from Google Cloud Console
//        ("Desktop app" type) and saves it to ~/.mcp-google-sheets/gdrive-credentials.json.
//      - First call opens the browser; token is persisted in gdrive-token.json.
//      - The script runs as the user — anything they can see, the server can see.
//
//   2. Service account (opt-in, headless)
//      - For CI / serverless / unattended automation.
//      - Set env var GOOGLE_APPLICATION_CREDENTIALS to the path of a service
//        account JSON key (downloaded from IAM & Admin → Service Accounts).
//      - The spreadsheet must be shared with the service account's
//        client_email (as Editor or Viewer) for it to be accessible.
//      - No browser flow, no per-user token.
//
// Selection logic: if GOOGLE_APPLICATION_CREDENTIALS is set and non-empty,
// service account mode is used; otherwise OAuth mode.
//
// Storage for OAuth files:
//   - directory configurable via env GSHEETS_CONFIG_DIR
//   - default: ~/.mcp-google-sheets

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { exec } from "node:child_process";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
];
const REDIRECT_PORT = 3456;
const REDIRECT = `http://localhost:${REDIRECT_PORT}`;

export type AuthMode = "oauth" | "service_account";

function configDir(): string {
  const env = process.env.GSHEETS_CONFIG_DIR?.trim();
  if (env) return env;
  return path.join(os.homedir(), ".mcp-google-sheets");
}

function credentialsPath(): string {
  return path.join(configDir(), "gdrive-credentials.json");
}

function tokenPath(): string {
  return path.join(configDir(), "gdrive-token.json");
}

function serviceAccountKeyPath(): string | null {
  const env = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  return env || null;
}

export function getAuthMode(): AuthMode {
  return serviceAccountKeyPath() ? "service_account" : "oauth";
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd);
}

async function authorizeInteractively(oauth2Client: OAuth2Client): Promise<void> {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
  console.error("[mcp-google-sheets] Opening browser for Google authorization...");
  console.error(`[mcp-google-sheets] If the browser does not open, visit: ${authUrl}`);
  openBrowser(authUrl);

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", REDIRECT);
        const code = url.searchParams.get("code");
        if (!code) {
          res.writeHead(400);
          res.end("Missing 'code' query parameter.");
          return;
        }
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        fs.mkdirSync(configDir(), { recursive: true });
        fs.writeFileSync(tokenPath(), JSON.stringify(tokens, null, 2));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h2>OK, puoi chiudere la finestra.</h2>");
        server.close();
        resolve();
      } catch (err) {
        res.writeHead(500);
        res.end("Auth error");
        server.close();
        reject(err);
      }
    });
    server.listen(REDIRECT_PORT, () =>
      console.error(`[mcp-google-sheets] Waiting for OAuth callback on ${REDIRECT} ...`),
    );
  });
}

export async function getOAuthClient(): Promise<OAuth2Client> {
  const credPath = credentialsPath();
  if (!fs.existsSync(credPath)) {
    throw new Error(
      `OAuth credentials not found at ${credPath}. ` +
        `Create an OAuth Client ID of type "Desktop app" in Google Cloud Console ` +
        `(with Sheets API and Drive API enabled) and save the downloaded JSON there. ` +
        `Override location via env GSHEETS_CONFIG_DIR. ` +
        `For unattended/CI use, set GOOGLE_APPLICATION_CREDENTIALS to a service account key path instead.`,
    );
  }
  const creds = JSON.parse(fs.readFileSync(credPath, "utf8"));
  const installed = creds.installed ?? creds.web;
  if (!installed?.client_id || !installed?.client_secret) {
    throw new Error(
      `Malformed OAuth credentials at ${credPath}: expected "installed" or "web" with client_id and client_secret.`,
    );
  }
  const oauth2Client = new google.auth.OAuth2(
    installed.client_id,
    installed.client_secret,
    REDIRECT,
  );

  const tokPath = tokenPath();
  let needsAuth = !fs.existsSync(tokPath);
  if (!needsAuth) {
    const token = JSON.parse(fs.readFileSync(tokPath, "utf8"));
    const scope: string = token.scope ?? "";
    if (!scope.includes("spreadsheets")) {
      needsAuth = true;
    } else {
      oauth2Client.setCredentials(token);
    }
  }

  if (needsAuth) {
    await authorizeInteractively(oauth2Client);
    return oauth2Client;
  }

  const token = JSON.parse(fs.readFileSync(tokPath, "utf8"));
  if (token.expiry_date && token.expiry_date < Date.now()) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
      fs.writeFileSync(tokPath, JSON.stringify(credentials, null, 2));
    } catch (err) {
      console.error(
        `[mcp-google-sheets] Refresh failed (${(err as Error).message}), re-running auth...`,
      );
      fs.unlinkSync(tokPath);
      await authorizeInteractively(oauth2Client);
    }
  }

  return oauth2Client;
}

async function getServiceAccountClient(): Promise<any> {
  const keyFile = serviceAccountKeyPath();
  if (!keyFile) {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS env var is required for service account mode.",
    );
  }
  if (!fs.existsSync(keyFile)) {
    throw new Error(
      `Service account key file not found at ${keyFile} ` +
        `(from GOOGLE_APPLICATION_CREDENTIALS). ` +
        `Download a JSON key from Google Cloud Console → IAM & Admin → Service Accounts → Keys.`,
    );
  }
  const ga = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
  return await ga.getClient();
}

let cachedAuth: Promise<any> | null = null;

export function getAuthCached(): Promise<any> {
  if (!cachedAuth) {
    cachedAuth =
      getAuthMode() === "service_account" ? getServiceAccountClient() : getOAuthClient();
  }
  return cachedAuth;
}

export async function getSheetsClient() {
  const auth = await getAuthCached();
  return google.sheets({ version: "v4", auth });
}

export async function getDriveClient() {
  const auth = await getAuthCached();
  return google.drive({ version: "v3", auth });
}

export function getConfigPaths() {
  const mode = getAuthMode();
  const saKey = serviceAccountKeyPath();
  return {
    auth_mode: mode,
    configDir: configDir(),
    credentialsPath: credentialsPath(),
    tokenPath: tokenPath(),
    service_account_key_path: saKey,
  };
}

export function getServiceAccountEmail(): string | null {
  const keyFile = serviceAccountKeyPath();
  if (!keyFile || !fs.existsSync(keyFile)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    return data.client_email ?? null;
  } catch {
    return null;
  }
}
