# CineGearPro Add-ons & Bundles — Setup

A self-hosted custom Shopify app that adds a Moment-style **“Add On & Save”**
section to product pages and applies accessory discounts automatically.

## What's in here

| Part | Path | Role |
|---|---|---|
| Admin dashboard | `app/routes/app._index.tsx` | Lists every configured product (groups / accessories counts) |
| Product config editor | `app/routes/app.products.$id.tsx` | Attach add-on groups + discount to a main product |
| Discount activation | `app/routes/app.discount.tsx` | One-click create the automatic discount that runs the Function |
| Config data layer | `app/models/addon-config*.ts` | JSON metafield (source of truth) + Prisma index |
| Storefront block | `extensions/addon-block/` | Tabs, accessory cards, option modal, AJAX add-to-cart |
| Discount Function | `extensions/addon-discount/` | Applies each accessory's % off when bought with its main product |

## Data model

- **Source of truth:** product metafield `custom.addon_config` (type `json`).
  ```json
  {
    "version": 1,
    "groups": [
      {
        "id": "g_ab12cd34",
        "title": "T-Series Lenses",
        "type": "addon",
        "discountPercent": 25,
        "accessories": [
          { "productId": "gid://shopify/Product/123", "handle": "tele-58mm", "title": "Tele 58mm" }
        ]
      }
    ]
  }
  ```
- **Dashboard index:** `BundleConfig` table in the app DB — a mirror kept in sync on every save.

## How the discount works (no client-trusted pricing)

The storefront only *previews* the discounted price. The real discount is applied
by the product-discount **Function**, which:

1. Reads each cart line's product `custom.addon_config` metafield.
2. Treats any line that has a config as a *main product*; its listed accessories
   become eligible for that group's `discountPercent` — but only while the main
   product is in the cart.
3. Discounts any cart line whose product is an eligible accessory.

> Because the Function cross-references the metafield in the cart, line
> properties can't be tampered with to fake a discount.

## First-time setup

```bash
cd bundle-addon-app
npm install
npm run setup          # prisma generate + migrate deploy
npm run config:link    # link to your Partner app (creates client_id)
npm run deploy         # registers the Function + theme extension
npm run dev            # local dev with tunnel + embedded admin
```

Then, in the app:

1. Open **Discount settings → Activate discount** (one time).
2. In the **Online Store → Theme editor**, open a product template and add the
   **“Add On & Save”** app block where you want it (e.g. under Add to cart).
3. On the app **Home**, click **Configure a product**, pick a main product, add
   one or more groups, choose accessories, set the discount %, **Save**.

## Behaviour notes / current scope (v1)

- The accessory card shows the discounted **preview** price. The discount becomes
  real in the cart/checkout once **both** the accessory and its main product are
  in the cart (by design — discount only applies as a pair).
- `discountPercent: 100` = the accessory is **free** with the main product.
- A group with multiple-variant accessories opens a variant-picker modal before
  adding (Moment-style).
- Each group renders as a **tab**. One group = no tab bar.

## Not yet built (candidate Phase 4)

- Single “Add main + selected accessories” button (current flow adds accessories
  individually; main product uses the theme's own Add to cart).
- Tiered “spend $X unlock $Y off” kit-builder.
- Per-accessory discount override (currently discount is per group).

## Verifying the Function locally

```bash
cd extensions/addon-discount
npm run preview        # runs the Function against sample input
```

If `shopify app deploy` reports a build issue for the JS function, regenerate a
fresh scaffold with `shopify app generate extension` (type: product discount,
JavaScript) and drop in `src/run.js` + `src/run.graphql` from here — the logic is
self-contained.
