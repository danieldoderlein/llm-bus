import net from "node:net";
import tls from "node:tls";

// Minimal dependency-free SMTP sender, sized for the Google Workspace SMTP relay (IP-allowlisted, no
// auth). Plain-text messages only (funding alerts). 587 + opportunistic STARTTLS. Throws on any
// non-2xx/3xx step; the caller (notify.ts) catches and falls back to logging. No new npm dependency,
// in keeping with the hand-rolled HTTP server.

export interface SmtpConfig {
  host: string;
  port: number;
  from: string; // e.g. "LLM Bus <support@llm-bus.com>"
}

/** Build an RFC-5322 plain-text message (pure, testable). CRLF line endings; dot-stuffed body. */
export function buildMessage(from: string, to: string, subject: string, body: string, date: string): string {
  const safeBody = body.replace(/\r?\n/g, "\r\n").replace(/\r\n\./g, "\r\n..");
  return [
    `From: ${from}`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    safeBody,
  ].join("\r\n");
}

/** The bare address from a "Name <addr>" or "addr" string. */
export function addressOf(s: string): string {
  return s.match(/<([^>]+)>/)?.[1] ?? s.trim();
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

/** Send one plain-text message. Rejects on connection error, timeout, or any unexpected SMTP code. */
export async function sendMail(cfg: SmtpConfig, to: string, subject: string, body: string): Promise<void> {
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
    }

    active.write(`MAIL FROM:<${addressOf(cfg.from)}>\r\n`);
    await expect([250]);
    active.write(`RCPT TO:<${to}>\r\n`);
    await expect([250, 251]);
    active.write("DATA\r\n");
    await expect([354]);
    active.write(buildMessage(cfg.from, to, subject, body, new Date().toUTCString()) + "\r\n.\r\n");
    await expect([250]);
    active.write("QUIT\r\n");
  } finally {
    active.end();
    sock.destroy();
  }
}
