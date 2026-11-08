# Amazon replica source and reuse notes

## Selected upstream

- Repository: https://github.com/Rohit-rockan/amazon-clone
- Pinned commit: `399d31901ebfa2eb7fe481d5433e59a09fb09493`
- Commit date: 2026-10-27 (README live-demo link commit)
- License: MIT, copyright 2026 Rohit. The exact upstream license is vendored at
  `LICENSE` and `upstream/LICENSE`; the upstream trademark/asset notice is
  vendored at `NOTICE.md` and `upstream/NOTICE.md`.
- Why this source: plain HTML/CSS/JavaScript with no build step, no framework,
  no Firebase/Stripe/backend, no bundled product photographs, fully offline
  emoji product tiles, and a complete responsive product/cart/checkout flow.
  Its NOTICE explicitly states that no Amazon code, images or assets are
  included and that all product data is fictional.

## Candidates inspected and rejected

| Candidate                        | License | Reason not selected                                                                                                                                                                                |
| -------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Kanika637/amazon-clone`         | MIT     | React + Firebase + Stripe + MUI dependency stack; product images are remote Amazon CDN URLs; only the logo is local.                                                                               |
| `Swap-nil-2003/Amazon-Clone-01`  | MIT     | Pure HTML/CSS/JS and strong Amazon homepage layout, but homepage/sidebar only; no product or cart flow. Bundled product photos appear to be Amazon product imagery with no separate asset license. |
| `salihabrik/Amazon-Clone`        | MIT     | Homepage-only clone; index links to `cart.html` that does not exist in the repository; bundled Amazon logo and product photos.                                                                     |
| `muhammadobaid-dev/Amazon-Clone` | MIT     | Homepage-only; external Font Awesome CDN and live Amazon links; no product/cart state.                                                                                                             |
| `curiousbud/Amazon-Clone`        | MIT     | Repository contains a 5.9 MB PDF, a 2.9 MB PPTX and an Amazon logo asset; only an index page despite the cart/product description; external Font Awesome CDN.                                      |

## Exact reuse map

- `upstream/css/styles.css` — vendored verbatim. `amazon.css` only appends
  bridge styles for world notices, stock, variants, synthetic checkout and
  accessibility.
- `upstream/index.html` — vendored verbatim as the upstream reference; its
  header, desktop/mobile chrome, footer, tab bar and search structure are
  adapted into `amazon.html`. The Amazon.in-style wordmark and CSS class
  vocabulary are preserved.
- `upstream-js.tar.gz` — the upstream JavaScript originals (`js/app.js` and
  `js/data.js`) vendored verbatim at the pinned commit. They are archived so
  `bun lint` scans only the adaptation, not the unmodified upstream source.
  Extract with `tar -xzf upstream-js.tar.gz` when reviewing provenance.
- `upstream-js.tar.gz:js/data.js` — its category and banner data are reused in
  `amazon-client.js`; the bottle and backpack catalog rows reuse the upstream
  title/brand/category/icon/tint/price/MRP/rating/reviews/prime/bought/bullets
  values. Notebook and lamp are synthetic additions in the same shape.
- `upstream-js.tar.gz:js/app.js` — its page templates (home chips/carousel/
  quads, product rows, product detail, offers, reviews, cart and checkout
  sections), formatting helpers and emoji tile approach are adapted into
  `amazon-client.js`.
- `amazon.html`, `amazon.css`, `amazon-client.js`, `amazon.ts` — the
  self-contained synthetic-world adaptation. `amazon-client.js` replaces
  upstream `localStorage` state and simulated checkout with the isolated
  Sightline world API. No upstream image, font or third-party network asset is
  used by the adaptation.

## Asset and trademark limits

- MIT covers the upstream source code only. The upstream NOTICE disclaims
  Amazon and other brand trademarks; this adaptation preserves that notice and
  does not grant trademark rights.
- No upstream image files are reused: upstream product "images" are Unicode
  emoji rendered by the viewer's font. No image or font license is therefore
  inherited beyond the MIT code license.
- The Amazon.in wordmark, "Prime", brand names and product names are used only
  as recognizable synthetic demo content. This is not an official Amazon
  property and must not be presented as one.
- No real accounts, payments, personal data, cookies, analytics or third-party
  services are used.

## Contract constraints

- The backend validates variants only for `notebook`, `bottle`, `backpack` and
  `lamp` (`src/backend.ts` `SHOP_VARIANTS`). The UI therefore exposes exactly
  those four product ids and these variants:
  - `notebook`: `ruled`, `dot-grid`
  - `bottle`: `slate`, `sand`
  - `backpack`: `black`, `olive`
  - `lamp`: `white`, `graphite`
- `world.stock` is a single global stock value; the UI shows it on every
  product and blocks add-to-cart only through the authoritative action result.
- `world.cart` is a count, not line items, and the backend has no remove or
  quantity-decrement action. The cart renders one synthetic line for the
  selected product with the world count; no remove controls are exposed.
- Authored defect behaviour is preserved and extended for the seeded
  out-of-stock world (`world.stock <= 0` with the visible "Out of stock" or
  "Backorder" notice; a clean world never exposes that combination):
  - "Add to Cart" stays enabled and shows a success toast while the server
    rejects the add and the cart count does not change.
  - The product page "Checkout" control is rendered enabled with an empty cart
    and enters a stuck "Checking out…" state instead of reporting the empty
    cart; the state survives world re-renders.
  - Search result summaries overstate a non-empty match set by one.
  - The product stock line is clipped and low-contrast in the buy box.
  Clean worlds keep exact counts, exact stock copy, disabled empty-cart
  checkout and the normal empty-cart toast, so a verification rerun is clean.
- Checkout always sends `{action: "checkout", value: "synthetic"}` and never
  collects or transmits name, email, address, phone, PIN or payment data.

## Behavioral smoke compatibility

The adaptation keeps the existing shop smoke/worker selectors:

- `#shopSearch` and `#shopSearchButton` — desktop search form; `#shopResults`
  is the result list on the search route and contains product links with
  `data-product`.
- `#variantButtons` — variant chips with `data-variant` and `data-product`.
- `#addToCartButton` — product add-to-cart control.
- `#checkoutButton` — product/cart navigation to the checkout route.
- `#completeCheckoutButton` — checkout page final action.
- `#orderConfirmation` — visible after `completed` is true.
- `#connectionStatus` — becomes `Connected · revision N · stock N`.

Exact flow: search → product link → `#variantButtons` chip → add to cart →
`#checkoutButton` → `#completeCheckoutButton` → `#orderConfirmation`.
When `world.stock <= 0`, `#addToCartButton` remains enabled, the click posts
`addToCart`, the UI shows the success toast, and the authoritative cart count
stays unchanged because the backend rejects the add.

Deterministic defect reproduction (seeded out-of-stock world):

1. Search for `notebook`; the summary reports one more result than the row
   count because the summary is stale.
2. Open the notebook product. The stock line is truncated and low-contrast.
3. Choose a variant and click "Add to Cart": the toast says "Added to Cart",
   but both cart badges stay `0`.
4. Click the now-enabled product-page "Checkout": the label changes to
   "Checking out…", the control disables, and it never progresses or reports
   the empty cart. The cart route still reports an empty cart.
5. Repeat the same steps in a clean world (verification rerun): counts match,
   stock copy is not clipped, and the empty-cart Checkout stays disabled.

## Integration

`amazon.ts` exports `amazonShopHtml()`. It synchronously reads
`amazon.html`, `amazon.css`, `amazon-client.js` and
`upstream/css/styles.css` relative to `import.meta.url`, then returns a full
HTML document string. The parent can integrate in `src/replica.ts` with:

```ts
import { amazonShopHtml } from './replica-assets/amazon/amazon';

export function replicaHtml(scenario: Scenario): string {
  if (scenario === 'shop') return amazonShopHtml();
  // existing portal branch unchanged
}
```

The replica server runs `src/server.ts` directly under Bun (see
`scripts/serve.ts`), so the sibling asset files are present at runtime. If the
module is ever bundled without its sibling files, inline the four files at build
time or copy them into the bundle output.

## Verification

The upstream files were downloaded from the pinned commit with `gh api`; the parent independently confirmed GitHub detects the pinned license as MIT. After integration, root/module type checks, zero-warning lint, 28 existing behavioral tests, and the production Next.js build passed. Actual Chromium exercised search, product and variant selection, cart addition, synthetic checkout, world acknowledgment, and worker request containment. A controlled-defect world retained stock zero and cart zero while the UI displayed its authored success toast. The adaptation talks exclusively to same-origin `/api/world/:agentId` routes. Vendored CSS and reference HTML were mechanically formatted during repository formatting; their layout source and license remain upstream.
