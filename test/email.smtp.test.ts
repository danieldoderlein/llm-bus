import net from "node:net";
import { sendMail, buildMessage, addressOf } from "../src/email/smtp.js";

// The dependency-free SMTP sender, against an in-process fake relay (plaintext path; the fake EHLO
// does not advertise STARTTLS). Network-free (loopback). Validates the handshake + message framing.

const errors: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) errors.push(msg);
}

interface Captured {
  mailFrom?: string;
  rcptTo?: string;
  data?: string;
}

function fakeRelay(captured: Captured): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = "";
      let inData = false;
      sock.write("220 fake ESMTP\r\n");
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end >= 0) {
            captured.data = buf.slice(0, end);
            inData = false;
            buf = "";
            sock.write("250 Queued\r\n");
          }
          return;
        }
        let idx: number;
        while ((idx = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const up = line.toUpperCase();
          if (up.startsWith("EHLO")) sock.write("250 OK\r\n"); // no STARTTLS -> plaintext path
          else if (up.startsWith("MAIL FROM")) (captured.mailFrom = line), sock.write("250 OK\r\n");
          else if (up.startsWith("RCPT TO")) (captured.rcptTo = line), sock.write("250 OK\r\n");
          else if (up.startsWith("DATA")) {
            inData = true;
            sock.write("354 Go ahead\r\n");
            break;
          } else if (up.startsWith("QUIT")) sock.write("221 Bye\r\n");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}

async function main(): Promise<void> {
  // pure helpers
  check(addressOf("LLM Bus <support@llm-bus.com>") === "support@llm-bus.com", "addressOf extracts a bracketed address");
  check(addressOf("a@b.com") === "a@b.com", "addressOf passes a bare address through");
  const msg = buildMessage("LLM Bus <support@llm-bus.com>", "u@x.com", "Hi", "l1\n.dot\nl2", "Mon, 01 Jan 2026 00:00:00 GMT");
  check(msg.includes("Subject: Hi") && msg.includes("\r\n..dot"), "buildMessage uses CRLF + dot-stuffs leading dots");

  // integration against a fake relay
  const captured: Captured = {};
  const srv = await fakeRelay(captured);
  await sendMail(
    { host: "127.0.0.1", port: srv.port, from: "LLM Bus <support@llm-bus.com>" },
    "user@example.com",
    "Low balance",
    "Top up please",
  );
  srv.close();
  check(captured.mailFrom === "MAIL FROM:<support@llm-bus.com>", `MAIL FROM wrong: ${captured.mailFrom}`);
  check(captured.rcptTo === "RCPT TO:<user@example.com>", `RCPT TO wrong: ${captured.rcptTo}`);
  check(
    !!captured.data && captured.data.includes("Subject: Low balance") && captured.data.includes("Top up please"),
    "DATA missing the subject/body",
  );

  finish();
}

function finish(): void {
  if (errors.length) {
    console.error(`FAIL email.smtp:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("OK email.smtp: addressOf/buildMessage pure helpers; full EHLO/MAIL/RCPT/DATA handshake to a fake relay.");
}

main().catch((err) => {
  console.error("email.smtp test errored:", err);
  process.exit(1);
});
