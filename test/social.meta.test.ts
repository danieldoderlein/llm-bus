// The public /p request page (the old shareable/viral surface) was RETIRED by decision 038, so there is no
// longer a server-rendered public page that opts into Open Graph + indexing. What remains load-bearing is the
// PRIVATE posture: admin pages must stay noindex and must NOT emit Open Graph (no unfurl/indexing of the
// signed-in surface). loadConfig runs during render (gaHead), so DATABASE_URL must validate; no connection.
process.env.DATABASE_URL ??= "postgres://127.0.0.1:5440/llm_bus";

const { layout } = await import("../src/admin/html.js");

const errors: string[] = [];
function check(c: boolean, m: string): void {
  if (!c) errors.push(m);
}

// Private admin pages stay noindex and carry NO Open Graph (not for public unfurl/indexing).
const admin = layout("Dashboard", "<p>x</p>");
check(/<meta name="robots" content="noindex">/.test(admin), "admin pages must stay noindex");
check(!/property="og:/.test(admin), "admin pages must not emit Open Graph tags");
check(!/name="twitter:/.test(admin), "admin pages must not emit Twitter card tags");

if (errors.length) {
  console.error(`FAIL social.meta:\n  - ${errors.join("\n  - ")}`);
  process.exit(1);
}
console.log(
  "OK social.meta: with the public /p page retired (decision 038), admin pages stay noindex and carry no " +
    "Open Graph / Twitter meta (private posture preserved).",
);
