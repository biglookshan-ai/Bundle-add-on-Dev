import prisma from "../db.server";
import {
  ACC_METAFIELD_NAMESPACE,
  ACC_METAFIELD_KEY,
  EMPTY_ACC_CONFIG,
  discountedAccessories,
  parseAccConfig,
  type AccessoryConfig,
} from "./accessory-config";
import type { ProductSummary } from "./addon-config";

/** Read a product's accessory config + basic info (for the editor loader). */
export async function readAccConfig(
  admin: AdminGraphql,
  productId: string,
): Promise<{ product: ProductSummary | null; config: AccessoryConfig }> {
  const resp = await admin.graphql(
    `#graphql
      query AccProduct($id: ID!) {
        product(id: $id) {
          id
          title
          handle
          featuredImage { url }
          metafield(namespace: "${ACC_METAFIELD_NAMESPACE}", key: "${ACC_METAFIELD_KEY}") {
            value
          }
        }
      }`,
    { variables: { id: productId } },
  );
  const j = await resp.json();
  const p = j?.data?.product;
  if (!p?.id) return { product: null, config: { ...EMPTY_ACC_CONFIG } };
  return {
    product: {
      id: p.id,
      title: p.title ?? "",
      handle: p.handle ?? "",
      image: p.featuredImage?.url ?? null,
    },
    config: parseAccConfig(p.metafield?.value),
  };
}

/**
 * Server-only operations for the Function-FREE accessory config. Discounts are
 * NATIVE "Amount off products" automatic discounts (DiscountAutomaticBasic —
 * work on any plan). Each product gets ONE Basic node PER DISCOUNT LEVEL
 * (e.g. 5% off, 10% off, 100%/free), each listing every accessory at that %.
 *
 * Why Basic and not "Buy X Get Y": in BxGy the "customer buys" side (whether a
 * quantity OR a spend amount) is CONSUMED per discount, so two stacked BxGy
 * nodes each demand their own main — only one accessory ever gets discounted.
 * A Basic product discount instead discounts every matching line independently
 * and stacks cleanly. To approximate "only when the main is bought" we gate it
 * behind a minimum cart SUBTOTAL equal to the main's price (a non-consumed
 * qualification), so a lone accessory purchase doesn't qualify.
 */

type AdminGraphql = {
  graphql: (query: string, options?: { variables?: any }) => Promise<Response>;
};

function numericId(gid: string) {
  return gid.replace("gid://shopify/Product/", "");
}
/** Title encodes the product + level so we only ever touch our own nodes. */
function nodeTitle(productNumericId: string, pct: number) {
  return `CGP-ACC ${productNumericId}:${pct}`;
}

/**
 * Basic "amount off products" input: `pct`% off these accessories, but only when
 * the cart subtotal reaches `minSpend` (≈ the main is in the cart).
 */
function basicInput(giftIds: string[], pct: number, minSpend: number) {
  return {
    title: "", // filled by caller
    combinesWith: {
      orderDiscounts: true,
      productDiscounts: true, // stack with our other per-level nodes
      shippingDiscounts: true,
    },
    minimumRequirement: {
      subtotal: { greaterThanOrEqualToSubtotal: minSpend.toFixed(2) },
    },
    customerGets: {
      value: { percentage: Math.min(1, Math.max(0, pct / 100)) },
      items: { products: { productsToAdd: giftIds } },
    },
  };
}

/** The main product's lowest variant price — used as the qualifying subtotal. */
async function mainMinPrice(
  admin: AdminGraphql,
  mainId: string,
): Promise<number> {
  const resp = await admin.graphql(
    `#graphql
      query AccMainPrice($id: ID!) {
        product(id: $id) {
          priceRangeV2 { minVariantPrice { amount } }
        }
      }`,
    { variables: { id: mainId } },
  );
  const j = await resp.json();
  const amt = Number(
    j?.data?.product?.priceRangeV2?.minVariantPrice?.amount,
  );
  return Number.isFinite(amt) && amt > 0 ? amt : 0.01;
}

/**
 * Every existing CGP-ACC discount node id for this product, of ANY type
 * (Basic or the legacy Bxgy), matched by the title prefix — so we can wipe them
 * before recreating and cleanly migrate off the old BxGy nodes.
 */
async function existingNodeIds(
  admin: AdminGraphql,
  productNumericId: string,
): Promise<string[]> {
  const resp = await admin.graphql(
    `#graphql
      query AccNodes {
        discountNodes(first: 250) {
          nodes {
            id
            discount {
              __typename
              ... on DiscountAutomaticBasic { title }
              ... on DiscountAutomaticBxgy { title }
            }
          }
        }
      }`,
  );
  const json = await resp.json();
  const prefix = `CGP-ACC ${productNumericId}:`;
  const ids: string[] = [];
  for (const n of json?.data?.discountNodes?.nodes ?? []) {
    const title = n?.discount?.title;
    if (typeof title === "string" && title.startsWith(prefix)) {
      const numeric = String(n.id).split("/").pop();
      ids.push(`gid://shopify/DiscountAutomaticNode/${numeric}`);
    }
  }
  return ids;
}

/** Make this product's discount nodes match its config (wipe + recreate). */
export async function reconcileAccessoryDiscounts(
  admin: AdminGraphql,
  product: ProductSummary,
  config: AccessoryConfig,
): Promise<string[]> {
  const errors: string[] = [];
  const pid = numericId(product.id);

  // One entry per accessory (highest %), grouped into discount levels.
  const byPct = new Map<number, string[]>();
  for (const { productId, percent } of discountedAccessories(config)) {
    const list = byPct.get(percent) ?? [];
    list.push(productId);
    byPct.set(percent, list);
  }

  // Wipe our existing nodes (any type) first — clean migration + no stale levels.
  for (const nodeId of await existingNodeIds(admin, pid)) {
    const resp = await admin.graphql(
      `#graphql
        mutation AccDelete($id: ID!) {
          discountAutomaticDelete(id: $id) { userErrors { message } }
        }`,
      { variables: { id: nodeId } },
    );
    const j = await resp.json();
    for (const e of j?.data?.discountAutomaticDelete?.userErrors ?? [])
      errors.push(e.message);
  }

  if (byPct.size === 0) return errors;

  const minSpend = await mainMinPrice(admin, product.id);
  for (const [pct, giftIds] of byPct) {
    if (!giftIds.length) continue;
    const input = {
      ...basicInput(giftIds, pct, minSpend),
      title: nodeTitle(pid, pct),
      startsAt: new Date().toISOString(), // required by Shopify automatic discounts
    };
    const resp = await admin.graphql(
      `#graphql
        mutation AccCreate($d: DiscountAutomaticBasicInput!) {
          discountAutomaticBasicCreate(automaticBasicDiscount: $d) {
            userErrors { message }
          }
        }`,
      { variables: { d: input } },
    );
    const j = await resp.json();
    for (const e of j?.data?.discountAutomaticBasicCreate?.userErrors ?? [])
      errors.push(e.message);
  }

  return errors;
}

/** Write the metafield (source of truth read by the storefront) + BxGy discounts. */
export async function saveAccessoryConfig(
  admin: AdminGraphql,
  shop: string,
  product: ProductSummary,
  config: AccessoryConfig,
): Promise<{ ok: boolean; errors: string[] }> {
  const live = config.groups.filter((g) => !g.archived && g.accessories.length);
  const errors: string[] = [];

  if (live.length === 0) {
    await admin.graphql(
      `#graphql
        mutation AccClear($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) { userErrors { message } }
        }`,
      {
        variables: {
          metafields: [
            {
              ownerId: product.id,
              namespace: ACC_METAFIELD_NAMESPACE,
              key: ACC_METAFIELD_KEY,
            },
          ],
        },
      },
    );
  } else {
    const resp = await admin.graphql(
      `#graphql
        mutation AccSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { userErrors { message } }
        }`,
      {
        variables: {
          metafields: [
            {
              ownerId: product.id,
              namespace: ACC_METAFIELD_NAMESPACE,
              key: ACC_METAFIELD_KEY,
              type: "json",
              value: JSON.stringify(config),
            },
          ],
        },
      },
    );
    const j = await resp.json();
    for (const e of j?.data?.metafieldsSet?.userErrors ?? []) errors.push(e.message);
  }

  errors.push(...(await reconcileAccessoryDiscounts(admin, product, config)));

  // Dashboard index row.
  await prisma.bundleConfig.upsert({
    where: { shop_productId: { shop, productId: product.id } },
    create: {
      shop,
      productId: product.id,
      productTitle: product.title,
      productHandle: product.handle,
      productImage: product.image ?? null,
      groupCount: live.length,
      accessoryCount: live.reduce((s, g) => s + g.accessories.length, 0),
      groupsJson: "[]",
    },
    update: {
      productTitle: product.title,
      productHandle: product.handle,
      productImage: product.image ?? null,
      groupCount: live.length,
      accessoryCount: live.reduce((s, g) => s + g.accessories.length, 0),
    },
  });

  return { ok: errors.length === 0, errors };
}
