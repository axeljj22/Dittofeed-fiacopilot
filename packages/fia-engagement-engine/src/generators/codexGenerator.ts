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
import { parseCodexToolEvents, type CodexToolTurn } from "./codexToolParse";

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

/** Parse SSE response body and accumulate output_text deltas */
function parseSSEText(sseBody: string): string | null {
  let result = "";
  for (const line of sseBody.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const raw = line.slice(6).trim();
    if (raw === "[DONE]") break;
    try {
      const event = JSON.parse(raw) as { type?: string; delta?: string; text?: string };
      if (event.type === "response.output_text.delta" && event.delta) {
        result += event.delta;
      }
    } catch { /* skip non-JSON lines */ }
  }
  return result.trim() || null;
}

/**
 * Fallback generator via the OpenAI Chat Completions API (uses OPENAI_API_KEY). Kicks in when
 * Codex (ChatGPT OAuth) is unavailable/expired, so Sofía never goes silent. Returns null if no
 * key or on failure (caller then tries its own next fallback / template).
 */
async function generateWithOpenAIChat(
  systemPrompt: string,
  userMessage: string,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
): Promise<string | null> {
  if (!config.openai.apiKey) return null;
  try {
    const messages = [
      { role: "system", content: systemPrompt },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userMessage },
    ];
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openai.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.openai.chatModel, messages, max_tokens: 600, temperature: 0.7 }),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status, body: (await resp.text()).slice(0, 200) }, "OpenAI chat fallback failed");
      return null;
    }
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (text) logger.info("Generated via OpenAI chat fallback (Codex unavailable)");
    return text || null;
  } catch (error) {
    logger.warn({ error: (error as Error).message }, "OpenAI chat fallback error");
    return null;
  }
}

export async function generateWithCodexConversation(
  systemPrompt: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  newMessage: string,
): Promise<string | null> {
  const auth = await getValidAuth();
  if (!auth) return generateWithOpenAIChat(systemPrompt, newMessage, history);

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
    stream: true,
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
      logger.error({ status: resp.status, body: text.slice(0, 300) }, "Codex conversation API error — OpenAI fallback");
      return generateWithOpenAIChat(systemPrompt, newMessage, history);
    }

    const sseText = await resp.text();
    const text = parseSSEText(sseText);
    if (!text) {
      logger.error({ preview: sseText.slice(0, 200) }, "No text in Codex conversation SSE response — OpenAI fallback");
      return generateWithOpenAIChat(systemPrompt, newMessage, history);
    }
    return text;
  } catch (error) {
    logger.error({ error }, "Codex conversation API call failed — OpenAI fallback");
    return generateWithOpenAIChat(systemPrompt, newMessage, history);
  }
}

/**
 * Tool-use turn over the Codex Responses API (Sofía 2.0, Phase 3). Sends `input` (message + prior
 * function_call/output items) plus `tools`, returns the accumulated text + any finalized tool calls.
 * Returns null when Codex is unavailable or the request fails — the caller then degrades (context
 * injection or plain generation). Does NOT touch the existing text-only generators.
 */
export async function generateWithCodexTools(
  systemPrompt: string,
  input: Array<Record<string, unknown>>,
  tools: Array<Record<string, unknown>>,
): Promise<CodexToolTurn | null> {
  const auth = await getValidAuth();
  if (!auth) return null;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.tokens.access_token}`,
    "Content-Type": "application/json",
    "ChatGPT-Account-Id": auth.tokens.account_id,
  };

  const body = {
    model: config.codex.model,
    stream: true,
    store: false,
    instructions: systemPrompt,
    input,
    tools,
    tool_choice: "auto",
  };

  try {
    const resp = await fetch(CODEX_ENDPOINT, { method: "POST", headers, body: JSON.stringify(body) });
    if (!resp.ok) {
      logger.error({ status: resp.status, body: (await resp.text()).slice(0, 300) }, "Codex tools API error");
      return null;
    }
    return parseCodexToolEvents(await resp.text());
  } catch (error) {
    logger.error({ error }, "Codex tools API call failed");
    return null;
  }
}

export async function generateWithCodex(
  systemPrompt: string,
  userMessage: string,
): Promise<string | null> {
  const auth = await getValidAuth();
  if (!auth) {
    logger.debug("Codex auth not found — OpenAI fallback");
    return generateWithOpenAIChat(systemPrompt, userMessage);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.tokens.access_token}`,
    "Content-Type": "application/json",
    "ChatGPT-Account-Id": auth.tokens.account_id,
  };

  const body = {
    model: config.codex.model,
    stream: true,
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
      logger.error({ status: resp.status, body: text.slice(0, 300) }, "Codex API error — OpenAI fallback");
      return generateWithOpenAIChat(systemPrompt, userMessage);
    }

    const sseText = await resp.text();
    const text = parseSSEText(sseText);
    if (!text) {
      logger.error({ preview: sseText.slice(0, 200) }, "No text in Codex SSE response — OpenAI fallback");
      return generateWithOpenAIChat(systemPrompt, userMessage);
    }
    return text;
  } catch (error) {
    logger.error({ error }, "Codex API call failed — OpenAI fallback");
    return generateWithOpenAIChat(systemPrompt, userMessage);
  }
}
