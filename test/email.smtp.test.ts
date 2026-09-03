import net from "node:net";
import { sendMail, buildMessage, addressOf, authLogin } from "../src/email/smtp.js";

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
  check(addressOf("LLM Bus <bus@example.com>") === "bus@example.com", "addressOf extracts a bracketed address");
  check(addressOf("a@b.com") === "a@b.com", "addressOf passes a bare address through");
  const msg = buildMessage("LLM Bus <bus@example.com>", "u@x.com", "Hi", "l1\n.dot\nl2", "Mon, 01 Jan 2026 00:00:00 GMT");
  check(msg.includes("Subject: Hi") && msg.includes("\r\n..dot"), "buildMessage uses CRLF + dot-stuffs leading dots");
  // Header injection: CR/LF in a user-controlled subject (e.g. a project name) must NOT create new headers.
  const inj = buildMessage("LLM Bus <s@example.com>", "u@x.com", 'Proj"\r\nBcc: evil@x.com', "body", "Mon, 01 Jan 2026 00:00:00 GMT");
  check(!/\r\nBcc:/i.test(inj), "buildMessage must strip CR/LF from the subject (no header injection)");

  // Digest email (decision 025): extra headers (List-Unsubscribe) + a custom Content-Type (multipart),
  // with CRLF stripped from any injected header value.
  const withHdrs = buildMessage("LLM Bus <s@example.com>", "u@x.com", "Your brief", "multi\r\nbody", "Mon, 01 Jan 2026 00:00:00 GMT", {
    contentType: 'multipart/alternative; boundary="=_b"',
    headers: { "List-Unsubscribe": "<https://admin.example.com/u>", "X-Evil": "a\r\nBcc: e@x.com" },
  });
  check(withHdrs.includes("List-Unsubscribe: <https://admin.example.com/u>"), "extra headers are emitted");
  check(withHdrs.includes('Content-Type: multipart/alternative; boundary="=_b"'), "a custom Content-Type is set");
  check(!/\r\nBcc:/i.test(withHdrs), "extra header values are CRLF-stripped (no injection via a header value)");

  // integration against a fake relay
  const captured: Captured = {};
  const srv = await fakeRelay(captured);
  await sendMail(
    { host: "127.0.0.1", port: srv.port, from: "LLM Bus <bus@example.com>" },
    "user@example.com",
    "Low balance",
    "Top up please",
  );
  srv.close();
  check(captured.mailFrom === "MAIL FROM:<bus@example.com>", `MAIL FROM wrong: ${captured.mailFrom}`);
  check(captured.rcptTo === "RCPT TO:<user@example.com>", `RCPT TO wrong: ${captured.rcptTo}`);
  check(
    !!captured.data && captured.data.includes("Subject: Low balance") && captured.data.includes("Top up please"),
    "DATA missing the subject/body",
  );

  // AUTH LOGIN branch (decision 020): records the writes, feeds canned 334/334/235. Proves the
  // command + base64(user) + base64(pass) sequence; the relay path above proves AUTH is skipped when
  // user/pass are unset (no AUTH line ever sent).
  {
    const writes: string[] = [];
    const replies = ["334 VXNlcm5hbWU6", "334 UGFzc3dvcmQ6", "235 Accepted"];
    let i = 0;
    await authLogin((s) => writes.push(s), async () => replies[i++], "bus@example.com", "app-pw-123");
    check(writes[0] === "AUTH LOGIN\r\n", `AUTH LOGIN command wrong: ${writes[0]}`);
    check(
      writes[1] === Buffer.from("bus@example.com", "utf8").toString("base64") + "\r\n",
      "user should be base64-encoded",
    );
    check(
      writes[2] === Buffer.from("app-pw-123", "utf8").toString("base64") + "\r\n",
      "password should be base64-encoded",
    );
    check(!captured.data!.includes("AUTH"), "the relay (no-cred) path must never send AUTH");
  }

  finish();
}

function finish(): void {
  if (errors.length) {
    console.error(`FAIL email.smtp:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("OK email.smtp: addressOf/buildMessage pure helpers; full EHLO/MAIL/RCPT/DATA handshake; AUTH LOGIN base64 sequence (skipped on the no-cred relay path).");
}

main().catch((err) => {
  console.error("email.smtp test errored:", err);
  process.exit(1);
});
