import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandHome,
  readCredentials,
  requestAppToken,
  getAppToken,
  getAuthStatus,
  apiBaseUrl,
  withTimeout,
  DEFAULT_SCOPE,
  INSIGHTS_SCOPE,
} from "./auth.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ebay-research-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeCredentialsFile(
  data: { client_id?: string; cert_id?: string; environment?: string }
): Promise<string> {
  const path = join(workDir, "credentials.json");
  await writeFile(path, JSON.stringify(data));
  return path;
}

function mockFetchOk(body: unknown) {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

function mockFetchError(status: number, body: unknown) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      statusText: "Bad Request",
      headers: { "Content-Type": "application/json" },
    });
}

describe("expandHome", () => {
  it("expands ~/ to home dir", () => {
    const result = expandHome("~/foo/bar");
    expect(result).not.toBe("~/foo/bar");
    expect(result.endsWith("/foo/bar")).toBe(true);
  });
  it("expands bare ~ to home dir", () => {
    const result = expandHome("~");
    expect(result.length).toBeGreaterThan(1);
  });
  it("leaves absolute paths alone", () => {
    expect(expandHome("/tmp/foo")).toBe("/tmp/foo");
  });
});

describe("apiBaseUrl", () => {
  it("returns sandbox base for sandbox env", () => {
    expect(apiBaseUrl("sandbox")).toBe("https://api.sandbox.ebay.com");
  });
  it("returns production base for production env", () => {
    expect(apiBaseUrl("production")).toBe("https://api.ebay.com");
  });
});

describe("readCredentials", () => {
  it("reads valid credentials and defaults environment to sandbox", async () => {
    const path = await writeCredentialsFile({ client_id: "cid", cert_id: "secret" });
    const creds = await readCredentials(path);
    expect(creds.client_id).toBe("cid");
    expect(creds.cert_id).toBe("secret");
    expect(creds.environment).toBe("sandbox");
  });
  it("honours explicit production environment", async () => {
    const path = await writeCredentialsFile({
      client_id: "cid",
      cert_id: "secret",
      environment: "production",
    });
    const creds = await readCredentials(path);
    expect(creds.environment).toBe("production");
  });
  it("throws when client_id is missing", async () => {
    const path = await writeCredentialsFile({ cert_id: "secret" });
    await expect(readCredentials(path)).rejects.toThrow(/client_id/);
  });
  it("throws when cert_id is missing", async () => {
    const path = await writeCredentialsFile({ client_id: "cid" });
    await expect(readCredentials(path)).rejects.toThrow(/cert_id/);
  });
});

describe("requestAppToken", () => {
  it("posts to the sandbox token endpoint with HTTP Basic auth", async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    let capturedBody = "";
    const fetchMock = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedAuth = (init.headers as Record<string, string>).Authorization;
      capturedBody = (init.body as URLSearchParams).toString();
      return new Response(
        JSON.stringify({
          access_token: "abc123",
          token_type: "Application Access Token",
          expires_in: 7200,
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const token = await requestAppToken(
      { client_id: "cid", cert_id: "secret", environment: "sandbox" },
      fetchMock
    );
    expect(capturedUrl).toBe("https://api.sandbox.ebay.com/identity/v1/oauth2/token");
    expect(capturedAuth).toBe(`Basic ${Buffer.from("cid:secret").toString("base64")}`);
    expect(capturedBody).toContain("grant_type=client_credentials");
    expect(capturedBody).toContain("scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope");
    expect(token.access_token).toBe("abc123");
    expect(token.environment).toBe("sandbox");
    const expiresInMs = Date.parse(token.expires_at) - Date.now();
    expect(expiresInMs).toBeGreaterThan(7_100_000);
    expect(expiresInMs).toBeLessThan(7_300_000);
  });

  it("throws a descriptive error on auth failure", async () => {
    const fetchMock = mockFetchError(401, {
      error: "invalid_client",
      error_description: "client authentication failed",
    }) as unknown as typeof fetch;
    await expect(
      requestAppToken(
        { client_id: "bad", cert_id: "wrong", environment: "sandbox" },
        fetchMock
      )
    ).rejects.toThrow(/invalid_client.*client authentication failed/);
  });
});

describe("getAppToken caching", () => {
  it("fetches a fresh token when no cache exists", async () => {
    const credsPath = await writeCredentialsFile({ client_id: "cid", cert_id: "secret" });
    const tokenPath = join(workDir, "token.json");
    let calls = 0;
    const fetchMock = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ access_token: "t1", token_type: "App", expires_in: 7200 }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const token = await getAppToken(
      { credentialsPath: credsPath, tokenPath },
      { fetchImpl: fetchMock }
    );
    expect(calls).toBe(1);
    expect(token.access_token).toBe("t1");
    const onDisk = JSON.parse(await readFile(tokenPath, "utf8"));
    expect(onDisk.access_token).toBe("t1");
  });

  it("reuses a fresh cached token without re-fetching", async () => {
    const credsPath = await writeCredentialsFile({ client_id: "cid", cert_id: "secret" });
    const tokenPath = join(workDir, "token.json");
    await writeFile(
      tokenPath,
      JSON.stringify({
        access_token: "cached",
        token_type: "App",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        environment: "sandbox",
        scopes: ["https://api.ebay.com/oauth/api_scope"],
      })
    );
    let calls = 0;
    const fetchMock = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const token = await getAppToken(
      { credentialsPath: credsPath, tokenPath },
      { fetchImpl: fetchMock }
    );
    expect(calls).toBe(0);
    expect(token.access_token).toBe("cached");
  });

  it("refreshes when the cached token is about to expire", async () => {
    const credsPath = await writeCredentialsFile({ client_id: "cid", cert_id: "secret" });
    const tokenPath = join(workDir, "token.json");
    await writeFile(
      tokenPath,
      JSON.stringify({
        access_token: "stale",
        token_type: "App",
        expires_at: new Date(Date.now() + 5_000).toISOString(),
        environment: "sandbox",
        scopes: ["https://api.ebay.com/oauth/api_scope"],
      })
    );
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({ access_token: "refreshed", token_type: "App", expires_in: 7200 }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const token = await getAppToken(
      { credentialsPath: credsPath, tokenPath },
      { fetchImpl: fetchMock }
    );
    expect(token.access_token).toBe("refreshed");
  });

  it("refreshes when the cached token is for a different environment", async () => {
    const credsPath = await writeCredentialsFile({
      client_id: "cid",
      cert_id: "secret",
      environment: "production",
    });
    const tokenPath = join(workDir, "token.json");
    await writeFile(
      tokenPath,
      JSON.stringify({
        access_token: "sandbox-token",
        token_type: "App",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        environment: "sandbox",
        scopes: ["https://api.ebay.com/oauth/api_scope"],
      })
    );
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({ access_token: "prod-token", token_type: "App", expires_in: 7200 }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const token = await getAppToken(
      { credentialsPath: credsPath, tokenPath },
      { fetchImpl: fetchMock }
    );
    expect(token.access_token).toBe("prod-token");
    expect(token.environment).toBe("production");
  });
});

describe("getAuthStatus", () => {
  it("reports credentials-not-configured when credentials file is missing", async () => {
    const status = await getAuthStatus({
      credentialsPath: join(workDir, "does-not-exist.json"),
      tokenPath: join(workDir, "token.json"),
    });
    expect(status.connected).toBe(false);
    expect(status.credentials_present).toBe(false);
    expect(status.reason).toMatch(/Credentials not configured/);
  });

  it("reports connected when credentials + fresh cached token exist", async () => {
    const credsPath = await writeCredentialsFile({ client_id: "cid", cert_id: "secret" });
    const tokenPath = join(workDir, "token.json");
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await writeFile(
      tokenPath,
      JSON.stringify({
        access_token: "abc",
        token_type: "App",
        expires_at: expiresAt,
        environment: "sandbox",
        scopes: ["https://api.ebay.com/oauth/api_scope"],
      })
    );
    const status = await getAuthStatus({
      credentialsPath: credsPath,
      tokenPath,
    });
    expect(status.connected).toBe(true);
    expect(status.environment).toBe("sandbox");
    expect(status.expires_at).toBe(expiresAt);
    expect(status.credentials_present).toBe(true);
    expect(status.scopes).toContain("https://api.ebay.com/oauth/api_scope");
  });

  it("does not echo the access_token in the status response", async () => {
    const credsPath = await writeCredentialsFile({ client_id: "cid", cert_id: "secret" });
    const tokenPath = join(workDir, "token.json");
    const tokenValue = "SECRET_VALUE_DO_NOT_LEAK";
    await writeFile(
      tokenPath,
      JSON.stringify({
        access_token: tokenValue,
        token_type: "App",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        environment: "sandbox",
        scopes: ["https://api.ebay.com/oauth/api_scope"],
      })
    );
    const status = await getAuthStatus({
      credentialsPath: credsPath,
      tokenPath,
    });
    expect(JSON.stringify(status)).not.toContain(tokenValue);
  });

  it("reports not-connected-but-credentials-present when token is expired", async () => {
    const credsPath = await writeCredentialsFile({ client_id: "cid", cert_id: "secret" });
    const tokenPath = join(workDir, "token.json");
    await writeFile(
      tokenPath,
      JSON.stringify({
        access_token: "expired",
        token_type: "App",
        expires_at: new Date(Date.now() - 1_000).toISOString(),
        environment: "sandbox",
        scopes: [],
      })
    );
    const status = await getAuthStatus({
      credentialsPath: credsPath,
      tokenPath,
    });
    expect(status.connected).toBe(false);
    expect(status.credentials_present).toBe(true);
  });
});

describe("getAppToken with custom scopes", () => {
  it("requests space-joined scopes in the token body", async () => {
    const credsPath = await writeCredentialsFile({ client_id: "cid", cert_id: "secret" });
    const tokenPath = join(workDir, "token.json");
    let capturedBody = "";
    const fetchMock = (async (_url: string, init: RequestInit) => {
      capturedBody = (init.body as URLSearchParams).toString();
      return new Response(
        JSON.stringify({ access_token: "broad", token_type: "App", expires_in: 7200 }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const token = await getAppToken(
      { credentialsPath: credsPath, tokenPath },
      { fetchImpl: fetchMock, scopes: [DEFAULT_SCOPE, INSIGHTS_SCOPE] }
    );
    // application/x-www-form-urlencoded uses `+` for spaces; decode with that in mind.
    const decoded = decodeURIComponent(capturedBody).replace(/\+/g, " ");
    expect(decoded).toContain(`${DEFAULT_SCOPE} ${INSIGHTS_SCOPE}`);
    expect(token.scopes).toEqual([DEFAULT_SCOPE, INSIGHTS_SCOPE]);
  });

  it("refreshes when cached token is missing a required scope", async () => {
    const credsPath = await writeCredentialsFile({ client_id: "cid", cert_id: "secret" });
    const tokenPath = join(workDir, "token.json");
    await writeFile(
      tokenPath,
      JSON.stringify({
        access_token: "narrow",
        token_type: "App",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        environment: "sandbox",
        scopes: [DEFAULT_SCOPE],
      })
    );
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({ access_token: "broad", token_type: "App", expires_in: 7200 }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const token = await getAppToken(
      { credentialsPath: credsPath, tokenPath },
      { fetchImpl: fetchMock, scopes: [DEFAULT_SCOPE, INSIGHTS_SCOPE] }
    );
    expect(token.access_token).toBe("broad");
    expect(token.scopes).toContain(INSIGHTS_SCOPE);
  });

  it("reuses a cached token that has a superset of requested scopes", async () => {
    const credsPath = await writeCredentialsFile({ client_id: "cid", cert_id: "secret" });
    const tokenPath = join(workDir, "token.json");
    await writeFile(
      tokenPath,
      JSON.stringify({
        access_token: "broad",
        token_type: "App",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        environment: "sandbox",
        scopes: [DEFAULT_SCOPE, INSIGHTS_SCOPE],
      })
    );
    let calls = 0;
    const fetchMock = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const token = await getAppToken(
      { credentialsPath: credsPath, tokenPath },
      { fetchImpl: fetchMock, scopes: [DEFAULT_SCOPE] }
    );
    expect(calls).toBe(0);
    expect(token.access_token).toBe("broad");
  });
});

describe("withTimeout", () => {
  it("resolves when the wrapped promise resolves in time", async () => {
    const result = await withTimeout(Promise.resolve(42), "test", 1_000);
    expect(result).toBe(42);
  });
  it("rejects with a labeled error when the wrapped promise hangs", async () => {
    const hanging = new Promise<never>(() => {});
    await expect(withTimeout(hanging, "slow-thing", 25)).rejects.toThrow(
      /slow-thing timed out after 25ms/
    );
  });
});

// Touch unused mock helper to silence lint.
void mockFetchOk;
