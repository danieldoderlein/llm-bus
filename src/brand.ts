// Design tokens - NEUTRAL in the open-source build.
//
// The hosted service ships its own palette here; this is a plain, accessible default so a self-hosted
// admin looks finished rather than unstyled. Change these values and every surface follows, which is
// the point of the module (decision 026): one source of truth for front and back.
export const TOKENS = `:root{
  --ink:#111315; --ink-soft:#4a5057; --line:#e3e6e9; --bg:#ffffff; --bg-soft:#f6f7f9;
  --accent:#2f6f6b; --accent-soft:#e7f1f0; --warn:#8a6d3b; --warn-soft:#fdf6e7;
  --ok:#2c6e49; --ok-soft:#e8f3ec; --danger:#9b2c2c; --danger-soft:#fbeaea;
  --radius:8px; --shadow:0 1px 2px rgba(17,19,21,.06),0 1px 8px rgba(17,19,21,.04);
  --font:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}`;
export const BADGE_INK = "#111315";
export const BADGE_TEAL = "#2f6f6b";
