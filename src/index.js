// @codeaeffchen/astro-split-domains
//
// Astro integration: one static build, one output folder per domain.
// See README.md for usage and src/split.js for what happens to the files.

import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitBuild } from './split.js';

export { splitBuild } from './split.js';

/**
 * @param {import('./split.js').SplitOptions & { enabled?: boolean }} options
 * @returns {import('astro').AstroIntegration}
 */
export default function splitDomains(options) {
  const { enabled = true, ...splitOptions } = options ?? {};
  let config;

  return {
    name: '@codeaeffchen/astro-split-domains',
    hooks: {
      'astro:config:done': ({ config: c, logger }) => {
        config = c;
        if (enabled && c.output !== 'static') {
          logger.warn('Only static output is supported — pages rendered on demand are not split.');
        }
      },
      'astro:build:done': ({ dir, logger }) => {
        if (!enabled) return;
        const outDir = fileURLToPath(dir);

        // Every folder from public/ ends up at the build root and is needed on
        // every domain, as is Astro's asset folder (_astro by default). Derived
        // instead of listed, so a new folder in public/ can't silently go
        // missing on the second domain.
        const publicDir = fileURLToPath(config.publicDir);
        const fromPublic = existsSync(publicDir)
          ? readdirSync(publicDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
          : [];
        const sharedDirs = splitOptions.sharedDirs ?? [config.build.assets, ...fromPublic];

        splitBuild(outDir, {
          ...splitOptions,
          sharedDirs,
          logger: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
        });
      },
    },
  };
}
