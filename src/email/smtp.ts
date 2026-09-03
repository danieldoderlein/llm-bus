import net from "node:net";
import tls from "node:tls";

// Minimal dependency-free SMTP sender, sized for the Google Workspace SMTP relay (IP-allowlisted, no
// auth). Plain-text messages only (funding alerts). 587 + opportunistic STARTTLS. Throws on any
// non-2xx/3xx step; the caller (notify.ts) catches and falls back to logging. No new npm dependency,
// in keeping with the hand-rolled HTTP server.

export interface SmtpConfig {
  host: string;
  port: number;
  from: string; // e.g. "LLM Bus <bus@example.com>"
  user?: string; // optional SMTP AUTH user (e.g. bus@example.com); enables AUTH LOGIN over TLS
  pass?: string; // optional SMTP AUTH password (a Gmail app password, from Secret Manager)
}

export interface MessageOpts {
  contentType?: string; // defaults to text/plain; the digest passes multipart/alternative
  headers?: Record<string, string>; // extra headers (e.g. List-Unsubscribe); CRLF-stripped like the rest
}

/** Build an RFC-5322 message (pure, testable). CRLF line endings; dot-stuffed body. Defaults to plain
 *  text; `opts` allows a different Content-Type (e.g. multipart/alternative) and extra headers. */
export function buildMessage(
  from: string,
  to: string,
  subject: string,
  body: string,
  date: string,
  opts: MessageOpts = {},
): string {
  // Strip CR/LF from header fields: a header value cannot span lines, so this prevents header injection
  // via any user-controlled value that reaches a header (e.g. a project name or handle in the subject).
  const hdr = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();
  const safeBody = body.replace(/\r?\n/g, "\r\n").replace(/\r\n\./g, "\r\n..");
  // Extra headers: both key AND value pass through the CRLF-strip (defense against an injected header
  // name or value); the digest's List-Unsubscribe URL is token-only, but harden the path regardless.
  const extra = Object.entries(opts.headers ?? {}).map(([k, v]) => `${hdr(k)}: ${hdr(v)}`);
  return [
    `From: ${hdr(from)}`,
    `To: <${hdr(to)}>`,
    `Subject: ${hdr(subject)}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    ...extra,
    `Content-Type: ${hdr(opts.contentType ?? "text/plain; charset=utf-8")}`,
    ``,
    safeBody,
  ].join("\r\n");
}

/** The bare address from a "Name <addr>" or "addr" string. */
export function addressOf(s: string): string {
  return s.match(/<([^>]+)>/)?.[1] ?? s.trim();
}

/** SMTP AUTH LOGIN: send the command, then base64(user), then base64(pass), expecting 334/334/235.
 *  Pure over its write/expect callbacks so it is testable without a TLS socket. The caller only
 *  invokes this AFTER STARTTLS, so the base64 credentials never cross a plaintext channel. */
export async function authLogin(
  write: (s: string) => void,
  expect: (codes: number[]) => Promise<string>,
  user: string,
  pass: string,
): Promise<void> {
  write("AUTH LOGIN\r\n");
  await expect([334]);
  write(Buffer.from(user, "utf8").toString("base64") + "\r\n");
  await expect([334]);
  write(Buffer.from(pass, "utf8").toString("base64") + "\r\n");
  await expect([235]);
}

/** A reply reader: resolves the next complete SMTP reply (handles multi-line NNN- continuations). */
function makeReader(sock: net.Socket): () => Promise<string> {
  let buf = "";
  let waiting: ((reply: string) => void) | null = null;
  const flush = (): void => {
    if (!waiting) return;
    const lines = buf.split("\r\n");
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i])) {
        const reply = lines.slice(0, i + 1).join("\r\n");
        buf = lines.slice(i + 1).join("\r\n");
        const w = waiting;
        waiting = null;
        w(reply);
        return;
      }
    }
  };
  sock.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    flush();
  });
  return () => new Promise<string>((res) => ((waiting = res), flush()));
}

/** Send one message. Rejects on connection error, timeout, or any unexpected SMTP code. `opts` allows a
 *  non-text Content-Type + extra headers (e.g. the digest's multipart body + List-Unsubscribe). */
export async function sendMail(
  cfg: SmtpConfig,
  to: string,
  subject: string,
  body: string,
  opts: MessageOpts = {},
): Promise<void> {
  const sock = net.connect(cfg.port, cfg.host);
  sock.setTimeout(15000);
  await new Promise<void>((res, rej) => {
    sock.once("connect", res);
    sock.once("error", rej);
    sock.once("timeout", () => rej(new Error("SMTP connect timeout")));
  });

  let read = makeReader(sock);
  let active: net.Socket = sock;
  const expect = async (codes: number[]): Promise<string> => {
    const reply = await read();
    const code = Number(reply.slice(0, 3));
    if (!codes.includes(code)) throw new Error(`SMTP unexpected reply: ${reply}`);
    return reply;
  };

  try {
    await expect([220]);
    active.write("EHLO llm-bus\r\n");
    const ehlo = await expect([250]);

    if (/STARTTLS/i.test(ehlo)) {
      active.write("STARTTLS\r\n");
      await expect([220]);
      const secure = tls.connect({ socket: sock, servername: cfg.host });
      await new Promise<void>((res, rej) => {
        secure.once("secureConnect", res);
        secure.once("error", rej);
      });
      active = secure;
      read = makeReader(secure);
      active.write("EHLO llm-bus\r\n");
      await expect([250]);

      // AUTH LOGIN only over TLS, and only when credentials are configured (authenticated send as
      // support@ for deliverability). Unset = the IP-allowlisted relay path runs unchanged.
      if (cfg.user && cfg.pass) {
        await authLogin((s) => active.write(s), expect, cfg.user, cfg.pass);
      }
    }

    // Strip CR/LF from the SMTP envelope addresses too (defense in depth; `to` is already regex-validated
    // upstream and `from` is config, but this matches the header-field hardening in buildMessage).
    const env = (s: string): string => s.replace(/[\r\n]+/g, "");
    active.write(`MAIL FROM:<${env(addressOf(cfg.from))}>\r\n`);
    await expect([250]);
    active.write(`RCPT TO:<${env(to)}>\r\n`);
    await expect([250, 251]);
    active.write("DATA\r\n");
    await expect([354]);
    active.write(buildMessage(cfg.from, to, subject, body, new Date().toUTCString(), opts) + "\r\n.\r\n");
    await expect([250]);
    active.write("QUIT\r\n");
  } finally {
    active.end();
    sock.destroy();
  }
}
