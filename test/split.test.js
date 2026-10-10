import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rewriteDefaultHtml, rewriteLocaleHtml, splitBuild, splitSitemap, trimHtaccess } from '../src/split.js';

const DE = 'https://example.de';
const COM = 'https://example.com';

function write(root, path, content) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** A miniature of what `astro build` produces for de (root) + en (/en/). */
function fixture() {
  const out = mkdtempSync(join(tmpdir(), 'split-'));
  write(out, 'index.html', `<a href="/en/">EN</a><a href="/kontakt/">Kontakt</a><link rel="canonical" href="${DE}/">`);
  write(out, 'kontakt/index.html', '<form action="/api/contact.php"></form>');
  write(out, '404.html', 'Seite nicht gefunden');
  write(out, 'en/index.html', `<link rel="canonical" href="${DE}/en/"><link rel="alternate" hreflang="en" href="${COM}/en/"><a href="/en/contact/">Contact</a><a href="/en">Home</a><a href="/kontakt/">DE</a>`);
  write(out, 'en/contact/index.html', `<form action="/en/api/x"></form><script type="application/ld+json">{"url":"${DE}/en/contact/"}</script>`);
  write(out, 'en/404/index.html', 'Page not found');
  write(out, 'en/llms.txt', 'english llms');
  write(out, 'llms.txt', 'deutsche llms');
  write(out, '_astro/app.js', 'js');
  write(out, 'images/logo.svg', '<svg/>');
  write(out, 'robots.txt', `User-agent: *\nSitemap: ${DE}/sitemaps.xml\nDisallow: /impressum\n`);
  write(out, 'sitemap-index.xml', `<sitemapindex><sitemap><loc>${DE}/sitemap-0.xml</loc></sitemap></sitemapindex>`);
  write(out, 'sitemap-0.xml', `<urlset><url><loc>${DE}/</loc></url><url><loc>${DE}/en/</loc></url><url><loc>${DE}/en/contact/</loc></url><url><loc>${DE}/kontakt/</loc></url></urlset>`);
  write(out, '.htaccess', 'ErrorDocument 404 /404.html\n# @split:de-only:start\nRedirect 301 /alt/ /neu/\n# @split:de-only:end\n# @split:com-only:start\nRedirect 301 /old/ /new/\n# @split:com-only:end\n');
  return out;
}

const options = {
  defaultLocale: { code: 'de', site: DE },
  locales: [{ code: 'en', site: COM }],
  sharedDirs: ['_astro', 'images'],
  localeOnlyFiles: ['llms.txt'],
  sitemapIndex: 'sitemaps.xml',
  apacheMarkers: { de: 'de-only', en: 'com-only' },
  robots: { en: (t) => t.replace('/impressum', '/imprint') },
  logger: { info() {}, warn() {} },
};

test('root holds only one folder per domain', () => {
  const out = fixture();
  splitBuild(out, options);
  assert.deepEqual(readdirSync(out).sort(), ['de', 'en']);
});

test('assets and shared root files reach every domain, locale-only files do not', () => {
  const out = fixture();
  splitBuild(out, options);
  for (const d of ['de', 'en']) {
    assert.ok(existsSync(join(out, d, '_astro/app.js')), `${d}: _astro`);
    assert.ok(existsSync(join(out, d, 'images/logo.svg')), `${d}: images`);
    assert.ok(existsSync(join(out, d, 'robots.txt')), `${d}: robots`);
  }
  assert.equal(readFileSync(join(out, 'en/llms.txt'), 'utf8'), 'english llms');
  assert.equal(readFileSync(join(out, 'de/llms.txt'), 'utf8'), 'deutsche llms');
  assert.ok(!existsSync(join(out, 'de/en')), 'no English pages on the German domain');
});

test('English HTML loses the /en/ prefix and points at its own domain', () => {
  const out = fixture();
  splitBuild(out, options);
  const home = readFileSync(join(out, 'en/index.html'), 'utf8');
  assert.match(home, new RegExp(`canonical" href="${COM}/"`), 'canonical from Astro site + prefix');
  assert.match(home, new RegExp(`hreflang="en" href="${COM}/"`), 'own domain + prefix');
  assert.match(home, /href="\/contact\/"/);
  assert.match(home, /href="\/">Home/);
  assert.match(home, /href="\/kontakt\/"/, 'links without the prefix are untouched');
  const contact = readFileSync(join(out, 'en/contact/index.html'), 'utf8');
  assert.match(contact, /action="\/api\/x"/);
  assert.match(contact, new RegExp(`"url":"${COM}/contact/"`), 'JSON-LD');
  assert.ok(!contact.includes('/en/'));
});

test('German HTML links into the other locale become absolute', () => {
  const out = fixture();
  splitBuild(out, options);
  assert.match(readFileSync(join(out, 'de/index.html'), 'utf8'), new RegExp(`href="${COM}/">EN`));
});

test('sitemaps are split by <loc> and the index is renamed', () => {
  const out = fixture();
  splitBuild(out, options);
  const de = readFileSync(join(out, 'de/sitemap-0.xml'), 'utf8');
  const en = readFileSync(join(out, 'en/sitemap-0.xml'), 'utf8');
  assert.equal(de, `<urlset><url><loc>${DE}/</loc></url><url><loc>${DE}/kontakt/</loc></url></urlset>`);
  assert.equal(en, `<urlset><url><loc>${COM}/</loc></url><url><loc>${COM}/contact/</loc></url></urlset>`);
  assert.ok(existsSync(join(out, 'de/sitemaps.xml')));
  assert.match(readFileSync(join(out, 'en/sitemaps.xml'), 'utf8'), new RegExp(`${COM}/sitemap-0.xml`));
});

test('robots.txt points at the right sitemap and takes custom rules', () => {
  const out = fixture();
  splitBuild(out, options);
  const en = readFileSync(join(out, 'en/robots.txt'), 'utf8');
  assert.match(en, new RegExp(`Sitemap: ${COM}/sitemaps.xml`));
  assert.match(en, /Disallow: \/imprint/);
  assert.match(readFileSync(join(out, 'de/robots.txt'), 'utf8'), /Disallow: \/impressum/);
});

test('each domain keeps only its own .htaccess block', () => {
  const out = fixture();
  splitBuild(out, options);
  assert.equal(readFileSync(join(out, 'de/.htaccess'), 'utf8'), 'ErrorDocument 404 /404.html\nRedirect 301 /alt/ /neu/\n');
  assert.equal(readFileSync(join(out, 'en/.htaccess'), 'utf8'), 'ErrorDocument 404 /404.html\nRedirect 301 /old/ /new/\n');
});

test('the English 404 page moves to the docroot', () => {
  const out = fixture();
  splitBuild(out, options);
  assert.equal(readFileSync(join(out, 'en/404.html'), 'utf8'), 'Page not found');
  assert.ok(!existsSync(join(out, 'en/404')));
  assert.equal(readFileSync(join(out, 'de/404.html'), 'utf8'), 'Seite nicht gefunden');
});

test('a prefix that differs from the folder name', () => {
  const out = fixture();
  splitBuild(out, { ...options, locales: [{ code: 'com', prefix: 'en', site: COM }], apacheMarkers: { de: 'de-only', com: 'com-only' } });
  assert.deepEqual(readdirSync(out).sort(), ['com', 'de']);
  assert.match(readFileSync(join(out, 'com/index.html'), 'utf8'), /href="\/contact\/"/);
});

test('errors instead of guessing', () => {
  assert.throws(() => splitBuild(fixture(), { ...options, locales: [{ code: 'fr', site: 'https://example.fr' }] }), /fr not found/);
  assert.throws(() => trimHtaccess('# @split:de-only:start\nx\n# @split:de-only:end\n', 'de-only', ['de-only', 'com-only']), /com-only/);
  assert.throws(() => splitBuild(fixture(), { ...options, defaultLocale: undefined }), /defaultLocale/);
});

test('.htaccess without markers is left untouched', () => {
  assert.equal(trimHtaccess('ErrorDocument 404 /404.html\n', 'de-only', ['de-only', 'com-only']), 'ErrorDocument 404 /404.html\n');
});

test('prefix matching does not catch longer path segments', () => {
  const html = rewriteLocaleHtml('<a href="/engineering/">x</a><a href="/en/x/">y</a>', { defaultSite: DE, site: COM, prefix: 'en' });
  assert.equal(html, '<a href="/engineering/">x</a><a href="/x/">y</a>');
  assert.equal(rewriteDefaultHtml('<a href="/engineering/">x</a>', [{ site: COM, prefix: 'en' }]), '<a href="/engineering/">x</a>');
});

test('hreflang alternates inside a sitemap entry do not move it', () => {
  const xml = `<urlset><url><loc>${DE}/</loc><xhtml:link href="${DE}/en/"/></url></urlset>`;
  assert.equal(splitSitemap(xml, (loc) => !loc.includes('/en/'), (b) => b), xml);
});
