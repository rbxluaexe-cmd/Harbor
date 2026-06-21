/**
 * Reader mode.
 *
 * Extracts the main article from a page (via a heuristic script run in the
 * page) and serves a clean, typographic version over `harbor://reader`. The
 * served page has a strict CSP (no scripts at all) and the extracted HTML is
 * additionally stripped of scripts/handlers — defence in depth, since the
 * content is untrusted.
 */
import { randomUUID } from 'node:crypto';

export interface ReaderArticle {
  readonly title: string;
  readonly byline: string;
  readonly html: string;
}

/** Runs in the page's main world; returns the best article candidate. */
export const READER_EXTRACT_SCRIPT = `(() => {
  try {
    const doc = document.cloneNode(true);
    doc.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,iframe,svg,button,input').forEach((e) => e.remove());
    let best = null, bestScore = 0;
    doc.querySelectorAll('article, main, [role="main"], section, div').forEach((el) => {
      const text = (el.innerText || '').trim();
      const score = text.length + el.querySelectorAll('p').length * 200;
      if (score > bestScore) { bestScore = score; best = el; }
    });
    const container = best || doc.body;
    const title = (document.title || (document.querySelector('h1') && document.querySelector('h1').innerText) || '').trim();
    const bylineEl = document.querySelector('[rel="author"], .byline, .author, [itemprop="author"]');
    const byline = (bylineEl && bylineEl.innerText || '').trim();
    return { title: title, byline: byline, html: container ? container.innerHTML : '' };
  } catch (e) {
    return { title: document.title || '', byline: '', html: '' };
  }
})()`;

function sanitize(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/ on\w+="[^"]*"/gi, '')
    .replace(/ on\w+='[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

export class ReaderManager {
  private readonly store = new Map<string, ReaderArticle>();

  create(article: ReaderArticle): string {
    const id = randomUUID();
    this.store.set(id, { title: article.title, byline: article.byline, html: sanitize(article.html) });
    if (this.store.size > 50) {
      const first = this.store.keys().next().value;
      if (first) this.store.delete(first);
    }
    return id;
  }

  render(id: string): string | null {
    const article = this.store.get(id);
    return article ? buildReaderPage(article) : null;
  }
}

function buildReaderPage(article: ReaderArticle): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; font-src data:;" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(article.title) || 'Reader'}</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; background: #0e1726; }
  body { color: #d7e0ec; font: 18px/1.7 Georgia, "Times New Roman", serif; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 56px 24px 120px; }
  .badge { font: 600 11px/1 system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; color: #38bdf8; margin-bottom: 18px; }
  h1 { font-size: 32px; line-height: 1.25; color: #f1f5f9; margin: 0 0 10px; }
  .byline { color: #8499b5; font: 14px/1.5 system-ui, sans-serif; margin-bottom: 28px; }
  article :is(p, li) { font-size: 18px; }
  article :is(h1, h2, h3) { color: #eef2f8; line-height: 1.3; font-family: system-ui, sans-serif; }
  article img { max-width: 100%; height: auto; border-radius: 8px; }
  article a { color: #7dd3fc; }
  article pre, article code { font-family: ui-monospace, monospace; background: #0b1220; border-radius: 6px; }
  article pre { padding: 14px; overflow-x: auto; }
  hr { border: none; border-top: 1px solid #233248; margin: 28px 0; }
</style></head>
<body><div class="wrap">
  <div class="badge">Reader view · Harbor</div>
  ${article.title ? `<h1>${escapeHtml(article.title)}</h1>` : ''}
  ${article.byline ? `<div class="byline">${escapeHtml(article.byline)}</div>` : ''}
  <article>${article.html}</article>
</div></body></html>`;
}
