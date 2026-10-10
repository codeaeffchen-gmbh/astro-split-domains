# @codeaeffchen/astro-split-domains

**One static Astro build, one output folder per domain.**

Put your German site on `example.de` and your English site on `example.com` – from a single Astro project, with plain static hosting and no server runtime.

```
dist/
├── de/   → https://example.de    (default locale, no prefix)
└── en/   → https://example.com   (was /en/, prefix removed)
```

## Why

Astro's built-in [`i18n.domains`](https://docs.astro.build/en/reference/configuration-reference/#i18ndomains) maps locales to domains, but it requires `output: "server"` with no prerendered pages. If your site is fully static – a marketing site, a blog, documentation – there is no built-in way to serve each language from its own domain.

This integration closes that gap. It runs after `astro build` and turns the usual output (default locale at the root, other locales under `/en/`, `/fr/`, …) into one self-contained folder per domain that you can upload anywhere.

We built it for [codeaeffchen.de](https://codeaeffchen.de) / [codeaeffchen.com](https://codeaeffchen.com), where it splits more than 400 pages on every deploy. How that site is set up: [case study](https://codeaeffchen.com/projects/codeaeffchen/).

## What it does

For every non-default locale:

- **Copies shared assets** (`_astro/` and every folder from `public/`) and root files like `robots.txt` into the locale's folder, so each domain is self-contained.
- **Removes the path prefix** from `href`, `src` and `action` attributes: `/en/contact/` → `/contact/`.
- **Rewrites absolute URLs** – canonical, hreflang, Open Graph, JSON-LD – to the locale's own domain, whether they were written with Astro's `site` (`https://example.de/en/…`) or the locale domain (`https://example.com/en/…`).
- **Splits the sitemaps** by `<loc>`: each domain lists only its own URLs, on its own host.
- **Points `robots.txt`** at the right sitemap, with an optional hook for locale-specific rules.
- **Moves the 404 page** from `en/404/index.html` to `en/404.html`, where web servers expect it.

For the default locale:

- Drops the other locales from its sitemaps.
- Turns root-relative links into another locale (`href="/en/"`) into absolute links to the other domain – otherwise they would point to a path that no longer exists.

Optional, for Apache: one `.htaccess` in `public/` can carry blocks for each domain, marked with `# @split:<marker>:start` / `:end`. Each domain keeps only its own block.

## Install

```sh
npm install @codeaeffchen/astro-split-domains
```

## Usage

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import splitDomains from '@codeaeffchen/astro-split-domains';

export default defineConfig({
  site: 'https://example.de',
  integrations: [
    sitemap(),
    // After the sitemap integration, so it can split its output.
    splitDomains({
      // Split only when asked, so `astro build` still produces the normal
      // flat output for local preview and link checks.
      enabled: process.env.SPLIT_DOMAINS === '1',
      defaultLocale: { code: 'de', site: 'https://example.de' },
      locales: [{ code: 'en', site: 'https://example.com' }],
    }),
  ],
});
```

```sh
SPLIT_DOMAINS=1 astro build
# dist/de → upload to example.de, dist/en → upload to example.com
```

English pages live in `src/pages/en/` as usual. Write links the normal way (`/en/contact/`); the integration fixes them for the English domain.

## Options

| Option | Default | |
|---|---|---|
| `defaultLocale` | – | `{ code, site }` – the locale built at the root. `code` is the output folder name. |
| `locales` | – | `[{ code, site, prefix? }]` – every other locale. `prefix` is the path Astro builds it under, defaults to `code`. |
| `enabled` | `true` | Set to `false` to skip the split (e.g. for local builds). |
| `localeOnlyFiles` | `[]` | Root files each locale builds itself (e.g. `llms.txt` from `src/pages/en/llms.txt.ts`). Never copied from the default locale. |
| `sitemapIndex` | `false` | Rename `sitemap-index.xml`, e.g. to `sitemaps.xml`. |
| `robots` | `{}` | Extra `robots.txt` transform per locale code: `{ en: (text) => text.replace('/impressum', '/imprint') }`. |
| `notFoundPage` | `true` | Move `<locale>/404/index.html` to `<locale>/404.html`. |
| `apacheMarkers` | `<code>-only` | Marker name per locale code for `.htaccess` blocks, e.g. `{ de: 'de-only', en: 'com-only' }`. |
| `sharedDirs` | `_astro` + folders in `public/` | Override the folders copied into every locale. |

The splitting logic is also available without the integration hook, e.g. for a custom build script:

```js
import { splitBuild } from '@codeaeffchen/astro-split-domains/split';
splitBuild('/abs/path/to/dist', { defaultLocale: …, locales: […] });
```

## Limits

- Static output only. Pages rendered on demand are not touched.
- hreflang tags are yours to write – the integration rewrites their URLs, it does not create them.
- It rewrites attributes and absolute URLs in HTML, sitemaps and `robots.txt`. URLs built at runtime in client-side JavaScript are not rewritten.
- Errors instead of guessing: a missing locale folder or a half-marked `.htaccess` fails the build.

## Deutsch, kurz

Eine statische Astro-Seite, zwei (oder mehr) Domains: Deutsch auf `.de`, Englisch auf `.com`, aus einem Build, ohne Server. Gebaut und im Einsatz bei [Codeäffchen](https://codeaeffchen.de) – Fragen und Fehler gern als [Issue](https://github.com/codeaeffchen-gmbh/astro-split-domains/issues).

## License

MIT © Codeäffchen UG
