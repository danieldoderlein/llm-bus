import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { setOauthState, getOauthState, clearOauthState } from "./session.js";

// In-app Google/GitHub OAuth for the human admin plane (decision 010). Used only when
// ADMIN_AUTH_SOURCE=oauth; the live header-mode (oauth2-proxy) path never imports this. The flow is
// a plain authorization-code exchange followed by a direct call to the provider's userinfo/user API
// over TLS - so we trust the verified email without parsing a self-issued id_token, and we add no
// OAuth-library dependency. The email-extraction steps are pure and unit-tested.

export type Provider = "google" | "github";

export function oauthEnabled(config: Config): boolean {
  return config.ADMIN_AUTH_SOURCE === "oauth";
}

export function asProvider(s: string): Provider | null {
  return s === "google" || s === "github" ? s : null;
}

interface ProviderConf {
  authUrl: string;
  tokenUrl: string;
  scope: string;
  clientId: string;
  clientSecret: string;
}

function providerConf(provider: Provider, config: Config): ProviderConf | null {
  if (provider === "google") {
    if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) return null;
    return {
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scope: "openid email",
      clientId: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
    };
  }
  if (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET) return null;
  return {
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
    clientId: config.GITHUB_CLIENT_ID,
    clientSecret: config.GITHUB_CLIENT_SECRET,
  };
}

function redirectBase(config: Config): string {
  return (config.OAUTH_REDIRECT_BASE ?? config.PUBLIC_URL).replace(/\/+$/, "");
}

export function callbackUrl(provider: Provider, config: Config): string {
  return `${redirectBase(config)}/admin/auth/${provider}/callback`;
}

/**
 * Build the provider authorization URL and stash the CSRF `state` (and an optional invite token) on
 * the session. Returns null if the provider is not configured.
 */
export function beginLogin(
  provider: Provider,
  sid: string,
  config: Config,
  opts?: { inviteToken?: string },
): string | null {
  const pc = providerConf(provider, config);
  if (!pc) return null;
  const state = randomUUID();
  setOauthState(sid, { provider, state, inviteToken: opts?.inviteToken });
  const u = new URL(pc.authUrl);
  u.searchParams.set("client_id", pc.clientId);
  u.searchParams.set("redirect_uri", callbackUrl(provider, config));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", pc.scope);
  u.searchParams.set("state", state);
  if (provider === "google") {
    u.searchParams.set("prompt", "select_account");
    u.searchParams.set("access_type", "online");
  }
  return u.toString();
}

export interface VerifiedIdentity {
  email: string;
  subject: string;
}

/** Google userinfo payload -> verified identity. Rejects an unverified email. Pure (network-free). */
export function googleIdentity(info: {
  email?: unknown;
  email_verified?: unknown;
  sub?: unknown;
}): VerifiedIdentity | null {
  const verified = info.email_verified === true || info.email_verified === "true";
  if (!verified) return null;
  if (typeof info.email !== "string" || !info.email) return null;
  if (typeof info.sub !== "string" || !info.sub) return null;
  return { email: info.email.toLowerCase(), subject: info.sub };
}

/** GitHub /user/emails payload -> the primary, verified email. Pure (network-free). */
export function githubPrimaryEmail(
  emails: Array<{ email?: unknown; primary?: unknown; verified?: unknown }>,
): string | null {
  if (!Array.isArray(emails)) return null;
  for (const e of emails) {
    if (e.primary === true && e.verified === true && typeof e.email === "string" && e.email) {
      return e.email.toLowerCase();
    }
  }
  return null;
}

export interface OauthResult {
  provider: Provider;
  email: string;
  subject: string;
  inviteToken?: string;
}

type FetchLike = typeof fetch;

/**
 * Complete the OAuth callback: validate the session-bound `state`, exchange the code, fetch the
 * verified email from the provider, and return the identity (or null on any failure). `fetchImpl` is
 * injectable for tests. Single-use: the stashed state is cleared on entry.
 */
export async function handleCallback(
  provider: Provider,
  sid: string,
  params: URLSearchParams,
  config: Config,
  fetchImpl: FetchLike = fetch,
): Promise<OauthResult | null> {
  const st = getOauthState(sid);
  clearOauthState(sid);
  if (!st || st.provider !== provider) return null;
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state || state !== st.state) return null;
  const pc = providerConf(provider, config);
  if (!pc) return null;

  const tokenResp = await fetchImpl(pc.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: pc.clientId,
      client_secret: pc.clientSecret,
      redirect_uri: callbackUrl(provider, config),
    }).toString(),
  });
  if (!tokenResp.ok) return null;
  const tokenJson = (await tokenResp.json()) as { access_token?: unknown };
  const accessToken = typeof tokenJson.access_token === "string" ? tokenJson.access_token : null;
  if (!accessToken) return null;

  const ghHeaders = {
    authorization: `Bearer ${accessToken}`,
    "user-agent": "llm-bus",
    accept: "application/vnd.github+json",
  };

  let identity: VerifiedIdentity | null = null;
  if (provider === "google") {
    const ui = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!ui.ok) return null;
    identity = googleIdentity((await ui.json()) as Record<string, unknown>);
  } else {
    const [userResp, emailsResp] = await Promise.all([
      fetchImpl("https://api.github.com/user", { headers: ghHeaders }),
      fetchImpl("https://api.github.com/user/emails", { headers: ghHeaders }),
    ]);
    if (!userResp.ok || !emailsResp.ok) return null;
    const user = (await userResp.json()) as { id?: unknown };
    const email = githubPrimaryEmail((await emailsResp.json()) as Array<Record<string, unknown>>);
    const subject = user.id != null ? String(user.id) : null;
    if (email && subject) identity = { email, subject };
  }
  if (!identity) return null;
  return { provider, email: identity.email, subject: identity.subject, inviteToken: st.inviteToken };
}
