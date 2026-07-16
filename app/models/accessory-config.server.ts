import prisma from "../db.server";
import {
  ACC_METAFIELD_NAMESPACE,
  ACC_METAFIELD_KEY,
  EMPTY_ACC_CONFIG,
  clampPct,
  offerAccessoryGids,
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
 * Server-only operations for the Function-FREE accessory config. The discount is
 * a single NATIVE "Buy X Get Y" automatic discount (works on any plan, no Plus):
 * buy the MAIN product (quantity 1) → get `offerQuantity` accessories at
 * `offerPercent`% off. Exactly ONE node per product, because BxGy consumes its
 * "buy" item — a second node would demand a second main. This is the strongest
 * thing native discounts can do WITHOUT the "any accessory in cart is discounted"
 * leak: the main is a real, non-optional condition, so there is no leak; the
 * trade-off is a single rate and a FIXED required quantity (Shopify's rule that
 * "customer gets N" needs exactly N eligible items in the cart).
 */

type AdminGraphql = {
  graphql: (query: string, options?: { variables?: any }) => Promise<Response>;
};

function numericId(gid: string) {
  return gid.replace("gid://shopify/Product/", "");
}
/** Title prefix scopes nodes to this product so we only ever touch our own. */
function nodeTitle(productNumericId: string) {
  return `CGP-ACC ${productNumericId}:offer`;
}

/** BxGy input: buy the main (qty 1) → get `qty` of these accessories `pct`% off. */
function bxgyInput(
  mainId: string,
  giftIds: string[],
  pct: number,
  qty: number,
) {
  return {
    title: "", // filled by caller
    combinesWith: {
      orderDiscounts: true,
      productDiscounts: true,
      shippingDiscounts: true,
    },
    customerBuys: {
      value: { quantity: "1" }, // must own the main — the anti-leak condition
      items: { products: { productsToAdd: [mainId] } },
    },
    customerGets: {
      value: {
        discountOnQuantity: {
          quantity: String(Math.max(1, qty)),
          effect: { percentage: Math.min(1, Math.max(0, pct / 100)) },
        },
      },
      items: { products: { productsToAdd: giftIds } },
    },
  };
}

/**
 * Every existing CGP-ACC discount node id for this product, of ANY type, matched
 * by the title prefix — so we can wipe them before recreating and cleanly migrate
 * off earlier Basic / multi-node versions.
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

/** Make this product's discount node match its config (wipe + recreate one BxGy). */
export async function reconcileAccessoryDiscounts(
  admin: AdminGraphql,
  product: ProductSummary,
  config: AccessoryConfig,
): Promise<string[]> {
  const errors: string[] = [];
  const pid = numericId(product.id);

  // Wipe our existing nodes (any type) first — clean migration + no stale nodes.
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

  // One BxGy per node we want to (re)create: { title, giftIds, pct, qty }.
  const nodes: { title: string; giftIds: string[]; pct: number; qty: number }[] =
    [];

  if (config.bundleMode) {
    // Each group is its OWN bundle → its own node (buy main → get all its
    // components at that bundle's rate). Multiple nodes coexist safely because
    // the customer only ever adds one bundle's components at a time, so only that
    // node's "get" items are in the cart and only it consumes the main.
    for (const g of config.groups) {
      if (g.archived) continue;
      const ids = [...new Set(g.accessories.map((a) => a.productId))];
      const pct = clampPct(g.bundlePercent ?? config.offerPercent ?? 0);
      if (pct <= 0 || ids.length === 0) continue;
      nodes.push({
        title: `CGP-ACC ${pid}:${g.id}`,
        giftIds: ids,
        pct,
        qty: ids.length, // the whole bundle is required
      });
    }
  } else {
    const giftIds = offerAccessoryGids(config);
    const pct = clampPct(config.offerPercent ?? 0);
    if (pct > 0 && giftIds.length > 0)
      nodes.push({
        title: nodeTitle(pid),
        giftIds,
        pct,
        qty: config.offerQuantity ?? 1,
      });
  }

  for (const n of nodes) {
    const input = {
      ...bxgyInput(product.id, n.giftIds, n.pct, n.qty),
      title: n.title,
      startsAt: new Date().toISOString(), // required by Shopify automatic discounts
    };
    const resp = await admin.graphql(
      `#graphql
        mutation AccCreate($d: DiscountAutomaticBxgyInput!) {
          discountAutomaticBxgyCreate(automaticBxgyDiscount: $d) {
            userErrors { message }
          }
        }`,
      { variables: { d: input } },
    );
    const j = await resp.json();
    for (const e of j?.data?.discountAutomaticBxgyCreate?.userErrors ?? [])
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

/** Remove a product's config entirely: metafield + discount nodes + index row. */
export async function deleteAccessoryConfig(
  admin: AdminGraphql,
  shop: string,
  productId: string,
): Promise<void> {
  const pid = numericId(productId);
  // Delete our discount nodes (any type) for this product.
  for (const nodeId of await existingNodeIds(admin, pid)) {
    await admin.graphql(
      `#graphql
        mutation AccDelete($id: ID!) {
          discountAutomaticDelete(id: $id) { userErrors { message } }
        }`,
      { variables: { id: nodeId } },
    );
  }
  // Delete the storefront metafield.
  await admin.graphql(
    `#graphql
      mutation AccClear($metafields: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $metafields) { userErrors { message } }
      }`,
    {
      variables: {
        metafields: [
          {
            ownerId: productId,
            namespace: ACC_METAFIELD_NAMESPACE,
            key: ACC_METAFIELD_KEY,
          },
        ],
      },
    },
  );
  // Delete the dashboard index row.
  await prisma.bundleConfig
    .delete({ where: { shop_productId: { shop, productId } } })
    .catch(() => {});
}
