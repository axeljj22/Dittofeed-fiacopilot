/**
 * Codex OAuth Generator
 *
 * Uses the ChatGPT Plus subscription via OAuth to generate messages.
 * Auth tokens live in the path defined by CODEX_AUTH_FILE (default /root/.codex/auth.json).
 * Created by `npx @openai/codex login`.
 */
import fs from "fs";
import { config } from "../config";
import { logger } from "../logger";

interface CodexAuth {
  auth_mode: string;
  OPENAI_API_KEY: string | null;
  tokens: {
    id_token?: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
  };
  last_refresh?: string;
}

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

let _cachedAuth: CodexAuth | null = null;

function loadAuth(): CodexAuth | null {
  if (_cachedAuth) return _cachedAuth;
  try {
    const raw = fs.readFileSync(config.codex.authFilePath, "utf8");
    _cachedAuth = JSON.parse(raw) as CodexAuth;
    return _cachedAuth;
  } catch {
    return null;
  }
}

function saveAuth(auth: CodexAuth): void {
  _cachedAuth = auth; // update in-memory cache immediately
  try {
    fs.writeFileSync(config.codex.authFilePath, JSON.stringify(auth, null, 2));
  } catch (error) {
    logger.warn({ error }, "Could not save Codex auth");
  }
}

/** Decode JWT expiry (exp is in seconds, returns ms) */
function getJwtExpiry(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp?: number };
    return decoded.exp ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
}

function isTokenExpired(auth: CodexAuth): boolean {
  const exp = getJwtExpiry(auth.tokens.access_token);
  if (!exp) return false;
  return Date.now() > exp - 60_000; // refresh 1 min before expiry
}

async function refreshToken(auth: CodexAuth): Promise<CodexAuth | null> {
  try {
    const resp = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: auth.tokens.refresh_token,
      }),
    });

    if (!resp.ok) {
      logger.error({ status: resp.status }, "Codex token refresh failed");
      return null;
    }

    const data = (await resp.json()) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
    };

    if (!data.access_token) return null;

    const updated: CodexAuth = {
      ...auth,
      tokens: {
        ...auth.tokens,
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? auth.tokens.refresh_token,
        id_token: data.id_token ?? auth.tokens.id_token,
      },
      last_refresh: new Date().toISOString(),
    };

    saveAuth(updated);
    logger.info("Codex OAuth token refreshed");
    return updated;
  } catch (error) {
    logger.error({ error }, "Codex token refresh exception");
    return null;
  }
}

async function getValidAuth(): Promise<CodexAuth | null> {
  let auth = loadAuth();
  if (!auth) return null;

  if (isTokenExpired(auth)) {
    auth = await refreshToken(auth);
  }

  return auth;
}

/** Call after writing or deleting auth.json so the next request re-reads from disk. */
export function invalidateCodexAuthCache(): void {
  _cachedAuth = null;
}

export async function isCodexAvailable(): Promise<boolean> {
  const auth = loadAuth();
  return auth !== null && Boolean(auth.tokens?.access_token);
}

export async function generateWithCodexConversation(
  systemPrompt: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  newMessage: string,
): Promise<string | null> {
  const auth = await getValidAuth();
  if (!auth) return null;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.tokens.access_token}`,
    "Content-Type": "application/json",
    "ChatGPT-Account-Id": auth.tokens.account_id,
  };

  const historyInput = history.map((m) => ({
    role: m.role,
    content: [{ type: m.role === "user" ? "input_text" : "output_text", text: m.content }],
  }));

  const body = {
    model: config.codex.model,
    store: false,
    instructions: systemPrompt,
    input: [
      ...historyInput,
      { role: "user", content: [{ type: "input_text", text: newMessage }] },
    ],
  };

  try {
    const resp = await fetch(CODEX_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      logger.error({ status: resp.status, body: text.slice(0, 300) }, "Codex conversation API error");
      return null;
    }

    const data = (await resp.json()) as {
      output?: Array<{
        type: string;
        content?: Array<{ type: string; text: string }>;
      }>;
    };

    for (const item of data.output ?? []) {
      if (item.type === "message" && item.content) {
        for (const block of item.content) {
          if (block.type === "output_text" && block.text) {
            return block.text.trim();
          }
        }
      }
    }

    logger.error({ data: JSON.stringify(data).slice(0, 300) }, "No text in Codex conversation response");
    return null;
  } catch (error) {
    logger.error({ error }, "Codex conversation API call failed");
    return null;
  }
}

export async function generateWithCodex(
  systemPrompt: string,
  userMessage: string,
): Promise<string | null> {
  const auth = await getValidAuth();
  if (!auth) {
    logger.debug("Codex auth not found — skipping");
    return null;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.tokens.access_token}`,
    "Content-Type": "application/json",
    "ChatGPT-Account-Id": auth.tokens.account_id,
  };

  const body = {
    model: config.codex.model,
    store: false,
    instructions: systemPrompt,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: userMessage }],
      },
    ],
  };

  try {
    const resp = await fetch(CODEX_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      logger.error({ status: resp.status, body: text.slice(0, 300) }, "Codex API error");
      return null;
    }

    const data = (await resp.json()) as {
      output?: Array<{
        type: string;
        content?: Array<{ type: string; text: string }>;
      }>;
    };

    for (const item of data.output ?? []) {
      if (item.type === "message" && item.content) {
        for (const block of item.content) {
          if (block.type === "output_text" && block.text) {
            return block.text.trim();
          }
        }
      }
    }

    logger.error({ data: JSON.stringify(data).slice(0, 300) }, "No text in Codex response");
    return null;
  } catch (error) {
    logger.error({ error }, "Codex API call failed");
    return null;
  }
}
