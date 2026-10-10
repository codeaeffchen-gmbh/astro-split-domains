# Changelog

## 0.1.0 — 2026-10-11

First release, extracted from the build of codeaeffchen.de / codeaeffchen.com.

- Split a static Astro build into one folder per domain.
- Prefix removal in `href`, `src`, `action`; absolute URLs (canonical, hreflang, JSON-LD) rewritten to the locale domain, including URLs built from Astro's `site` + prefix.
- Sitemaps split by `<loc>`, optional rename of the sitemap index.
- `robots.txt` sitemap URL per domain, optional per-locale transform.
- Locale 404 page moved to the docroot.
- Optional `.htaccess` blocks per domain via `# @split:<marker>:start/end`.
- Root-relative links from the default locale into another locale become absolute.
