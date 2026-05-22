// OAuth Desktop flow per Google Sheets + Drive.
// Porting di C:\dev\vari\gsheet-editor\sheets-auth.js, senza loadSpreadsheetId
// (lo spreadsheetId arriva sempre come parametro dei tool).
//
// Posizione credenziali / token:
//   - cartella configurabile via env GSHEETS_CONFIG_DIR
//   - default: ~/.mcp-google-sheets
// File attesi nella cartella:
//   - gdrive-credentials.json  (OAuth Client ID tipo "Desktop", scaricato da Google Cloud Console)
//   - gdrive-token.json        (generato automaticamente al primo avvio)

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
        `Override location via env GSHEETS_CONFIG_DIR.`,
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

let cachedAuth: Promise<OAuth2Client> | null = null;

export function getAuthCached(): Promise<OAuth2Client> {
  if (!cachedAuth) cachedAuth = getOAuthClient();
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
  return {
    configDir: configDir(),
    credentialsPath: credentialsPath(),
    tokenPath: tokenPath(),
  };
}
