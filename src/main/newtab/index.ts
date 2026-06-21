/**
 * The Harbor start page, served dynamically over the `harbor://newtab` scheme.
 *
 * Rendering it server-side (in the main process) lets us inject the user's
 * most-visited sites without giving the page any privileged bridge — it stays a
 * plain HTML document whose links and search form just navigate the tab. No
 * remote code, no external requests (tiles use letter avatars, not favicons).
 */
export interface TopSite {
  readonly title: string;
  readonly url: string;
}

const FALLBACK: readonly TopSite[] = [
  { title: 'DuckDuckGo', url: 'https://duckduckgo.com/' },
  { title: 'Wikipedia', url: 'https://en.wikipedia.org/' },
  { title: 'GitHub', url: 'https://github.com/' },
];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function tile(site: TopSite): string {
  const label = (site.title || hostOf(site.url)).trim() || hostOf(site.url);
  const initial = escapeHtml(label.slice(0, 1).toUpperCase());
  return `<a class="tile" href="${escapeHtml(site.url)}" title="${escapeHtml(site.url)}">
    <span class="ico">${initial}</span>
    <span class="name">${escapeHtml(hostOf(site.url))}</span>
  </a>`;
}

export function renderNewTabPage(topSites: readonly TopSite[]): string {
  const sites = topSites.length > 0 ? topSites : FALLBACK;
  const heading = topSites.length > 0 ? 'Most visited' : 'Quick links';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action https:;" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>New Tab</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; align-items: center; justify-content: flex-start; padding-top: 13vh; gap: 26px;
    font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #e2e8f0;
    background: radial-gradient(1200px 600px at 50% -10%, #14304f 0%, transparent 60%), #0b1220; user-select: none; }
  .mark { display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .logo { width: 76px; height: 76px; border-radius: 20px; background: linear-gradient(160deg, #38bdf8, #075985);
    display: grid; place-items: center; box-shadow: 0 12px 40px rgba(56,189,248,.25); }
  .logo svg { width: 46px; height: 46px; fill: #f8fafc; }
  .wordmark { font-size: 27px; font-weight: 700; letter-spacing: .06em; }
  form { width: min(620px, 86vw); }
  input { width: 100%; padding: 14px 20px; border-radius: 28px; border: 1px solid #1e293b; background: #0f172a;
    color: #e2e8f0; font-size: 16px; outline: none; user-select: text; }
  input:focus { border-color: #38bdf8; box-shadow: 0 0 0 4px rgba(56,189,248,.12); }
  .grid-wrap { width: min(720px, 90vw); }
  .grid-head { color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; margin: 0 4px 10px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .tile { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px 8px; border-radius: 14px;
    background: #0f172a; border: 1px solid #1e293b; color: #cbd5e1; text-decoration: none; }
  .tile:hover { border-color: #334155; color: #fff; }
  .ico { width: 40px; height: 40px; border-radius: 12px; background: linear-gradient(160deg, #38bdf8, #0369a1);
    display: grid; place-items: center; color: #04121f; font-weight: 700; font-size: 18px; }
  .name { font-size: 12px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style></head>
<body>
  <div class="mark">
    <div class="logo"><svg viewBox="0 0 256 256">
      <circle cx="128" cy="58" r="17" fill="none" stroke="#f8fafc" stroke-width="14" />
      <rect x="120" y="64" width="16" height="134" /><rect x="84" y="92" width="88" height="16" />
      <path d="M66 150 a62 62 0 0 0 124 0" fill="none" stroke="#f8fafc" stroke-width="16" />
      <path d="M44 150 l30 6 l-14 28 z" /><path d="M212 150 l-30 6 l14 28 z" />
    </svg></div>
    <div class="wordmark">Harbor</div>
  </div>
  <form action="https://duckduckgo.com/" method="get" autocomplete="off">
    <input type="text" name="q" placeholder="Search privately or type a URL in the address bar" autofocus spellcheck="false" />
  </form>
  <div class="grid-wrap">
    <div class="grid-head">${heading}</div>
    <div class="grid">${sites.map(tile).join('')}</div>
  </div>
</body></html>`;
}
