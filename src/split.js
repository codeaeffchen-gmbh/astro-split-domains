// Core of @codeaeffchen/astro-split-domains.
//
// Takes the output of a normal static Astro build — default locale at the
// root, every other locale under its own path prefix (/en/, /fr/, …) — and
// turns it into one self-contained folder per domain:
//
//   dist/de/  → https://example.de   (default locale, no prefix)
//   dist/en/  → https://example.com  (was /en/, prefix removed)
//
// Pure file-system work, no Astro APIs, so it can be tested on a plain
// directory and run from a script as well as from the integration hook.

import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * @typedef {object} DefaultLocale
 * @property {string} code   Folder name of the output, e.g. "de".
 * @property {string} site   Origin of its domain, e.g. "https://example.de".
 *
 * @typedef {object} Locale
 * @property {string} code   Folder name of the output, e.g. "en".
 * @property {string} site   Origin of its domain, e.g. "https://example.com".
 * @property {string} [prefix] Path prefix in the build, without slashes. Defaults to `code`.
 *
 * @typedef {object} SplitOptions
 * @property {DefaultLocale} defaultLocale
 * @property {Locale[]} locales                Every locale except the default one.
 * @property {string[]} [sharedDirs]           Root folders copied into every locale (assets).
 * @property {string[]} [localeOnlyFiles]      Root files each locale builds itself (e.g. "llms.txt") —
 *                                             never copied from the default locale.
 * @property {string|false} [sitemapIndex]     Rename `sitemap-index.xml` to this name. false = keep.
 * @property {boolean} [notFoundPage]          Move `<locale>/404/index.html` to `<locale>/404.html`.
 * @property {Record<string,string>} [apacheMarkers] Marker name per locale code for `.htaccess`
 *                                             blocks (`# @split:<marker>:start` … `:end`).
 *                                             Defaults to `<code>-only`.
 * @property {Record<string,(text:string)=>string>} [robots] Extra robots.txt transform per locale code.
 * @property {{info:Function, warn:Function}} [logger]
 */

const trimSlash = (s) => s.replace(/\/+$/, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @param {string} dir @param {(file:string)=>void} fn */
function walk(dir, fn) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, fn);
    else fn(full);
  }
}

/**
 * Rewrite one HTML document of a non-default locale for its own domain.
 * Exported for tests.
 */
export function rewriteLocaleHtml(html, { defaultSite, site, prefix }) {
  const p = esc(prefix);
  // Absolute URLs of the locale — canonical, hreflang, JSON-LD, og:url.
  // Both spellings: Astro's `site` (default domain) + prefix, and the
  // locale's own domain + prefix. Neither path exists after the split.
  for (const origin of [defaultSite, site]) {
    html = html.replace(new RegExp(`${esc(origin)}/${p}/`, 'g'), `${site}/`);
    html = html.replace(new RegExp(`${esc(origin)}/${p}(?=["'<\\s])`, 'g'), `${site}/`);
  }
  // Root-relative attributes: /en/foo → /foo, /en → /
  html = html.replace(new RegExp(`((?:href|src|action|poster|content)=["'])/${p}/`, 'g'), '$1/');
  html = html.replace(new RegExp(`((?:href|src|action)=["'])/${p}(?=["'])`, 'g'), '$1/');
  return html;
}

/**
 * Rewrite one HTML document of the default locale: root-relative links into
 * another locale would point to a path that no longer exists on this domain,
 * so they become absolute links to the other domain. Exported for tests.
 */
export function rewriteDefaultHtml(html, locales) {
  for (const { site, prefix } of locales) {
    const p = esc(prefix);
    html = html.replace(new RegExp(`((?:href|action)=["'])/${p}/`, 'g'), `$1${site}/`);
    html = html.replace(new RegExp(`((?:href|action)=["'])/${p}(?=["'])`, 'g'), `$1${site}/`);
  }
  return html;
}

/**
 * Keep only the `.htaccess` block meant for one locale. Blocks are marked
 *   # @split:<marker>:start
 *   …
 *   # @split:<marker>:end
 * A file without any marker is left alone; a file with markers for some
 * locales but not others is an error — that is a broken file, not a choice.
 * Exported for tests.
 */
export function trimHtaccess(text, keepMarker, allMarkers) {
  const has = (m) => text.includes(`# @split:${m}:start`) && text.includes(`# @split:${m}:end`);
  const present = allMarkers.filter(has);
  if (present.length === 0) return text;
  const missing = allMarkers.filter((m) => !has(m));
  if (missing.length) {
    throw new Error(`.htaccess: marker(s) ${missing.map((m) => `@split:${m}`).join(', ')} missing.`);
  }
  for (const m of allMarkers) {
    if (m === keepMarker) {
      text = text.replace(new RegExp(`^# @split:${esc(m)}:(start|end).*$\\n?`, 'gm'), '');
    } else {
      text = text.replace(new RegExp(`# @split:${esc(m)}:start[\\s\\S]*?# @split:${esc(m)}:end\\n?`, 'g'), '');
    }
  }
  return text;
}

/**
 * Filter a sitemap to the URLs of one domain. Decided by <loc> only, so
 * hreflang alternates inside a <url> block don't move it to the wrong side.
 * Exported for tests.
 */
export function splitSitemap(xml, keep, rewrite) {
  const first = xml.indexOf('<url>');
  if (first === -1) return xml;
  const head = xml.slice(0, first);
  const tail = xml.slice(xml.lastIndexOf('</url>') + '</url>'.length);
  const blocks = [...xml.matchAll(/<url>[\s\S]*?<\/url>/g)].map((m) => m[0]);
  const kept = blocks
    .filter((b) => keep((b.match(/<loc>([\s\S]*?)<\/loc>/) || [])[1] || ''))
    .map(rewrite);
  return head + kept.join('') + tail;
}

/**
 * Split a finished build directory in place.
 * @param {string} outDir absolute path of the Astro output directory
 * @param {SplitOptions} options
 */
export function splitBuild(outDir, options) {
  const {
    defaultLocale,
    locales,
    sharedDirs = ['_astro'],
    localeOnlyFiles = [],
    sitemapIndex = false,
    notFoundPage = true,
    apacheMarkers = {},
    robots = {},
    logger = { info: () => {}, warn: console.warn },
  } = options;

  if (!defaultLocale?.code || !defaultLocale?.site) throw new Error('splitDomains: defaultLocale.code and .site are required.');
  if (!Array.isArray(locales) || locales.length === 0) throw new Error('splitDomains: at least one entry in locales is required.');

  const defaultSite = trimSlash(defaultLocale.site);
  const others = locales.map((l) => ({ code: l.code, site: trimSlash(l.site), prefix: (l.prefix ?? l.code).replace(/^\/|\/$/g, '') }));
  const prefixes = new Set(others.map((l) => l.prefix));
  const codes = [defaultLocale.code, ...others.map((l) => l.code)];
  const marker = (code) => apacheMarkers[code] ?? `${code}-only`;

  for (const l of others) {
    if (!existsSync(join(outDir, l.prefix))) {
      throw new Error(`splitDomains: ${join(outDir, l.prefix)} not found — is "${l.prefix}" the prefix Astro builds this locale under?`);
    }
  }

  // 1. Sitemap index under the name robots.txt points to.
  if (sitemapIndex && existsSync(join(outDir, 'sitemap-index.xml'))) {
    renameSync(join(outDir, 'sitemap-index.xml'), join(outDir, sitemapIndex));
  }

  // 2. Snapshot of the root before anything moves.
  const rootEntries = readdirSync(outDir);
  const rootFiles = rootEntries.filter((e) => statSync(join(outDir, e)).isFile());

  // 3. Default locale: everything at the root except the other locales' trees.
  const defaultDir = join(outDir, defaultLocale.code);
  if (prefixes.has(defaultLocale.code)) throw new Error('splitDomains: default locale code collides with a locale prefix.');
  rmSync(defaultDir, { recursive: true, force: true });
  mkdirSync(defaultDir, { recursive: true });
  for (const entry of rootEntries) {
    if (prefixes.has(entry) || entry === defaultLocale.code) continue;
    cpSync(join(outDir, entry), join(defaultDir, entry), { recursive: true });
  }

  // 4. Other locales: add shared assets and root files, then rewrite.
  for (const l of others) {
    const dir = join(outDir, l.prefix);
    for (const d of sharedDirs) {
      if (existsSync(join(outDir, d))) cpSync(join(outDir, d), join(dir, d), { recursive: true });
    }
    for (const f of rootFiles) {
      if (f.endsWith('.html') || localeOnlyFiles.includes(f)) continue;
      cpSync(join(outDir, f), join(dir, f));
    }

    walk(dir, (file) => {
      if (!file.endsWith('.html')) return;
      writeFileSync(file, rewriteLocaleHtml(readFileSync(file, 'utf8'), { defaultSite, site: l.site, prefix: l.prefix }));
    });

    const robotsFile = join(dir, 'robots.txt');
    if (existsSync(robotsFile)) {
      let r = readFileSync(robotsFile, 'utf8').replaceAll(`${defaultSite}/`, `${l.site}/`);
      if (robots[l.code]) r = robots[l.code](r);
      writeFileSync(robotsFile, r);
    }

    if (notFoundPage) {
      const nested = join(dir, '404', 'index.html');
      if (existsSync(nested)) {
        cpSync(nested, join(dir, '404.html'));
        rmSync(join(dir, '404'), { recursive: true, force: true });
      } else {
        logger.warn(`${l.prefix}/404/index.html not found — ${l.site} has no own error page.`);
      }
    }

    // Sitemaps: only this locale's URLs, on this locale's domain.
    const inLocale = (loc) => loc.startsWith(`${defaultSite}/${l.prefix}/`) || loc === `${defaultSite}/${l.prefix}`;
    const toLocale = (s) => s.replaceAll(`${defaultSite}/${l.prefix}/`, `${l.site}/`).replaceAll(`${defaultSite}/${l.prefix}<`, `${l.site}/<`);
    for (const f of readdirSync(dir)) {
      if (/^sitemap-\d+\.xml$/.test(f)) {
        const path = join(dir, f);
        writeFileSync(path, splitSitemap(readFileSync(path, 'utf8'), inLocale, toLocale));
      } else if (f === 'sitemap-index.xml' || f === sitemapIndex) {
        const path = join(dir, f);
        writeFileSync(path, readFileSync(path, 'utf8').replaceAll(`${defaultSite}/`, `${l.site}/`));
      }
    }
    logger.info(`${l.prefix}/ → ${l.site}`);
  }

  // 5. Default locale: drop the other locales from its sitemaps, point
  //    root-relative cross-locale links at the other domains.
  for (const f of readdirSync(defaultDir)) {
    if (!/^sitemap-\d+\.xml$/.test(f)) continue;
    const path = join(defaultDir, f);
    const foreign = (loc) => others.some((l) => loc.startsWith(`${defaultSite}/${l.prefix}/`) || loc === `${defaultSite}/${l.prefix}`);
    writeFileSync(path, splitSitemap(readFileSync(path, 'utf8'), (loc) => !foreign(loc), (b) => b));
  }
  walk(defaultDir, (file) => {
    if (file.endsWith('.html')) writeFileSync(file, rewriteDefaultHtml(readFileSync(file, 'utf8'), others));
  });
  logger.info(`${defaultLocale.code}/ → ${defaultSite}`);

  // 6. .htaccess: each domain keeps only its own block.
  const allMarkers = codes.map(marker);
  for (const code of codes) {
    const dir = code === defaultLocale.code ? defaultDir : join(outDir, others.find((l) => l.code === code).prefix);
    const file = join(dir, '.htaccess');
    if (existsSync(file)) writeFileSync(file, trimHtaccess(readFileSync(file, 'utf8'), marker(code), allMarkers));
  }

  // 7. Root: only the per-domain folders remain. A locale whose prefix
  //    differs from its code is moved to its code.
  for (const entry of readdirSync(outDir)) {
    if (entry === defaultLocale.code || prefixes.has(entry)) continue;
    rmSync(join(outDir, entry), { recursive: true, force: true });
  }
  for (const l of others) {
    if (l.prefix !== l.code) renameSync(join(outDir, l.prefix), join(outDir, l.code));
  }
}
