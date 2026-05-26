import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type EbayEnvironment = "sandbox" | "production";

export interface AuthConfig {
  credentialsPath: string;
  tokenPath: string;
}

export interface Credentials {
  client_id: string;
  cert_id: string;
  environment: EbayEnvironment;
}

export interface CachedAppToken {
  access_token: string;
  token_type: string;
  expires_at: string;
  environment: EbayEnvironment;
  scopes: string[];
}

const DEFAULT_SCOPE = "https://api.ebay.com/oauth/api_scope";

const SANDBOX_BASE = "https://api.sandbox.ebay.com";
const PRODUCTION_BASE = "https://api.ebay.com";

const REFRESH_SAFETY_WINDOW_MS = 60_000;

export function apiBaseUrl(env: EbayEnvironment): string {
  return env === "sandbox" ? SANDBOX_BASE : PRODUCTION_BASE;
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

export async function readCredentials(
  credentialsPath: string
): Promise<Credentials> {
  const raw = await readFile(expandHome(credentialsPath), "utf8");
  const parsed = JSON.parse(raw) as Partial<Credentials>;
  if (!parsed.client_id || !parsed.cert_id) {
    throw new Error(
      `Credentials file at ${credentialsPath} must contain "client_id" and "cert_id".`
    );
  }
  const environment: EbayEnvironment =
    parsed.environment === "production" ? "production" : "sandbox";
  return {
    client_id: parsed.client_id,
    cert_id: parsed.cert_id,
    environment,
  };
}

async function readCachedToken(
  tokenPath: string
): Promise<CachedAppToken | null> {
  try {
    const raw = await readFile(expandHome(tokenPath), "utf8");
    return JSON.parse(raw) as CachedAppToken;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeCachedToken(
  tokenPath: string,
  token: CachedAppToken
): Promise<void> {
  await writeFile(expandHome(tokenPath), JSON.stringify(token, null, 2), {
    mode: 0o600,
  });
}

function isTokenFresh(
  token: CachedAppToken,
  env: EbayEnvironment,
  now: number = Date.now()
): boolean {
  if (token.environment !== env) return false;
  const expiresAt = Date.parse(token.expires_at);
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt - now > REFRESH_SAFETY_WINDOW_MS;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface TokenError {
  error: string;
  error_description?: string;
}

export async function requestAppToken(
  creds: Credentials,
  fetchImpl: typeof fetch = fetch
): Promise<CachedAppToken> {
  const tokenUrl = `${apiBaseUrl(creds.environment)}/identity/v1/oauth2/token`;
  const basic = Buffer.from(`${creds.client_id}:${creds.cert_id}`).toString(
    "base64"
  );
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: DEFAULT_SCOPE,
  });
  const res = await withTimeout(
    fetchImpl(tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }),
    "ebay.identity.oauth2.token"
  );
  if (!res.ok) {
    const text = await res.text();
    let parsed: TokenError | undefined;
    try {
      parsed = JSON.parse(text) as TokenError;
    } catch {
      parsed = undefined;
    }
    const detail = parsed
      ? `${parsed.error}${parsed.error_description ? `: ${parsed.error_description}` : ""}`
      : text.slice(0, 200);
    throw new Error(
      `eBay token request failed (${res.status} ${res.statusText}): ${detail}`
    );
  }
  const data = (await res.json()) as TokenResponse;
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  return {
    access_token: data.access_token,
    token_type: data.token_type,
    expires_at: expiresAt,
    environment: creds.environment,
    scopes: [DEFAULT_SCOPE],
  };
}

export async function getAppToken(
  config: AuthConfig,
  options: { force?: boolean; fetchImpl?: typeof fetch } = {}
): Promise<CachedAppToken> {
  const creds = await readCredentials(config.credentialsPath);
  if (!options.force) {
    const cached = await readCachedToken(config.tokenPath);
    if (cached && isTokenFresh(cached, creds.environment)) {
      return cached;
    }
  }
  const fresh = await requestAppToken(creds, options.fetchImpl);
  await writeCachedToken(config.tokenPath, fresh);
  return fresh;
}

export async function getAuthStatus(
  config: AuthConfig
): Promise<{
  connected: boolean;
  environment: EbayEnvironment | null;
  scopes: string[];
  expires_at: string | null;
  credentials_present: boolean;
  reason?: string;
}> {
  let creds: Credentials;
  try {
    creds = await readCredentials(config.credentialsPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      connected: false,
      environment: null,
      scopes: [],
      expires_at: null,
      credentials_present: false,
      reason: `Credentials not configured: ${message}`,
    };
  }
  const cached = await readCachedToken(config.tokenPath);
  if (cached && isTokenFresh(cached, creds.environment)) {
    return {
      connected: true,
      environment: cached.environment,
      scopes: cached.scopes,
      expires_at: cached.expires_at,
      credentials_present: true,
    };
  }
  return {
    connected: false,
    environment: creds.environment,
    scopes: [],
    expires_at: cached?.expires_at ?? null,
    credentials_present: true,
    reason: cached
      ? "Cached app token is missing or expired. Next tool call will refresh."
      : "No cached app token yet. Next tool call will fetch one.",
  };
}

export async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  ms = 30_000
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
