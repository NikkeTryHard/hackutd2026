import { readFileSync } from 'node:fs';

/**
 * Amazon.in-style synthetic shop presentation.
 *
 * Upstream: https://github.com/Rohit-rockan/amazon-clone
 * Pinned commit: 399d31901ebfa2eb7fe481d5433e59a09fb09493
 * License: MIT (see LICENSE and NOTICE.md in this directory).
 *
 * The upstream CSS, catalog shape and page templates are vendored under
 * `upstream/` and adapted by `amazon.html`, `amazon.css` and
 * `amazon-client.js`. The client speaks only to Sightline's isolated
 * `/api/world/:agentId` contract; it has no localStorage, account, payment,
 * analytics or third-party network dependency.
 *
 * Integration: return `amazonShopHtml()` for the `shop` scenario from
 * `src/replica.ts`. The assets are read synchronously relative to this module,
 * which is compatible with the Bun-run replica server. If this module is ever
 * bundled without its sibling assets, inline the four files at build time.
 */
export const AMAZON_UPSTREAM = {
  repo: 'https://github.com/Rohit-rockan/amazon-clone',
  commit: '399d31901ebfa2eb7fe481d5433e59a09fb09493',
  license: 'MIT',
} as const;

export function amazonShopHtml(): string {
  const style = `${readFileSync(new URL('./upstream/css/styles.css', import.meta.url), 'utf8')}\n${readFileSync(new URL('./amazon.css', import.meta.url), 'utf8')}`;
  const client = readFileSync(new URL('./amazon-client.js', import.meta.url), 'utf8');
  const shell = readFileSync(new URL('./amazon.html', import.meta.url), 'utf8');
  return shell
    .replace('/*__AMAZON_STYLE__*/', () => style)
    .replace('/*__AMAZON_CLIENT__*/', () => client);
}
