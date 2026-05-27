import { readFile, writeFile, chmod, stat } from "node:fs/promises";
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

export const DEFAULT_SCOPE = "https://api.ebay.com/oauth/api_scope";
export const INSIGHTS_SCOPE =
  "https://api.ebay.com/oauth/api_scope/buy.marketplace.insights";

const SANDBOX_BASE = "https://api.sandbox.ebay.com";
const PRODUCTION_BASE = "https://api.ebay.com";

const REFRESH_SAFETY_WINDOW_MS = 60_000;

export function apiBaseUrl(env: EbayEnvironment): string {
  return env === "sandbox" ? SANDBOX_BASE : PRODUCTION_BASE;
}

const MARKETPLACE_CURRENCY: Record<string, string> = {
  EBAY_US: "USD",
  EBAY_CA: "CAD",
  EBAY_GB: "GBP",
  EBAY_IE: "EUR",
  EBAY_DE: "EUR",
  EBAY_AT: "EUR",
  EBAY_BE: "EUR",
  EBAY_CH: "CHF",
  EBAY_ES: "EUR",
  EBAY_FR: "EUR",
  EBAY_IT: "EUR",
  EBAY_NL: "EUR",
  EBAY_PL: "PLN",
  EBAY_AU: "AUD",
  EBAY_HK: "HKD",
  EBAY_MY: "MYR",
  EBAY_PH: "PHP",
  EBAY_SG: "SGD",
};

export function currencyForMarketplace(marketplaceId: string): string {
  return MARKETPLACE_CURRENCY[marketplaceId] ?? "USD";
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
  const path = expandHome(tokenPath);
  await writeFile(path, JSON.stringify(token, null, 2), { mode: 0o600 });
  // writeFile only applies `mode` when creating the file; if an existing
  // file had looser perms (e.g. 0644 from a prior version), they'd be
  // preserved silently. Always chmod after write to enforce 0600.
  await chmod(path, 0o600);
}

export async function fileModeIsRestrictive(
  filePath: string
): Promise<boolean | null> {
  try {
    const s = await stat(expandHome(filePath));
    return (s.mode & 0o077) === 0;
  } catch {
    return null;
  }
}

function isTokenFresh(
  token: CachedAppToken,
  env: EbayEnvironment,
  requiredScopes: string[],
  now: number = Date.now()
): boolean {
  if (token.environment !== env) return false;
  const expiresAt = Date.parse(token.expires_at);
  if (Number.isNaN(expiresAt)) return false;
  if (expiresAt - now <= REFRESH_SAFETY_WINDOW_MS) return false;
  const cached = new Set(token.scopes);
  for (const scope of requiredScopes) {
    if (!cached.has(scope)) return false;
  }
  return true;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

interface TokenError {
  error: string;
  error_description?: string;
}

export async function requestAppToken(
  creds: Credentials,
  fetchImpl: typeof fetch = fetch,
  scopes: string[] = [DEFAULT_SCOPE]
): Promise<CachedAppToken> {
  const tokenUrl = `${apiBaseUrl(creds.environment)}/identity/v1/oauth2/token`;
  const basic = Buffer.from(`${creds.client_id}:${creds.cert_id}`).toString(
    "base64"
  );
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: scopes.join(" "),
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
  // eBay returns the actually-granted scopes in the `scope` field. If a
  // requested scope wasn't granted (e.g. buy.marketplace.insights without
  // approved access), eBay silently downgrades — we'd otherwise cache a
  // token tagged with INSIGHTS_SCOPE that has no Insights access, and
  // every subsequent call would 401-then-refresh-then-401 forever.
  // Trust what eBay says was granted, not what we asked for.
  const grantedScopes = data.scope
    ? data.scope.split(/\s+/).filter(Boolean)
    : scopes;
  for (const requested of scopes) {
    if (!grantedScopes.includes(requested)) {
      const hint =
        requested === INSIGHTS_SCOPE
          ? " (hint: your eBay app may not yet have Marketplace Insights access; apply via the eBay Developer portal at https://developer.ebay.com/)"
          : "";
      throw new Error(
        `eBay token response did not include the requested scope ${requested}. Granted: [${grantedScopes.join(", ")}].${hint}`
      );
    }
  }
  return {
    access_token: data.access_token,
    token_type: data.token_type,
    expires_at: expiresAt,
    environment: creds.environment,
    scopes: grantedScopes,
  };
}

export async function getAppToken(
  config: AuthConfig,
  options: {
    force?: boolean;
    fetchImpl?: typeof fetch;
    scopes?: string[];
  } = {}
): Promise<CachedAppToken> {
  const creds = await readCredentials(config.credentialsPath);
  const scopes = options.scopes ?? [DEFAULT_SCOPE];
  if (!options.force) {
    const cached = await readCachedToken(config.tokenPath);
    if (cached && isTokenFresh(cached, creds.environment, scopes)) {
      return cached;
    }
  }
  const fresh = await requestAppToken(creds, options.fetchImpl, scopes);
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
  warnings: string[];
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
      warnings: [],
      reason: `Credentials not configured: ${message}`,
    };
  }
  const warnings: string[] = [];
  const credsRestrictive = await fileModeIsRestrictive(config.credentialsPath);
  if (credsRestrictive === false) {
    warnings.push(
      `Credentials file at ${config.credentialsPath} has permissions wider than 0600. Run: chmod 600 ${config.credentialsPath}`
    );
  }
  const cached = await readCachedToken(config.tokenPath);
  if (cached && isTokenFresh(cached, creds.environment, [DEFAULT_SCOPE])) {
    return {
      connected: true,
      environment: cached.environment,
      scopes: cached.scopes,
      expires_at: cached.expires_at,
      credentials_present: true,
      warnings,
    };
  }
  return {
    connected: false,
    environment: creds.environment,
    scopes: [],
    expires_at: cached?.expires_at ?? null,
    credentials_present: true,
    warnings,
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
