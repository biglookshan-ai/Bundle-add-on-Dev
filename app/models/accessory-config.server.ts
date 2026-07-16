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
 * NATIVE "Buy X Get Y" automatic discounts (work on any plan). Each product gets
 * ONE BxGy node PER DISCOUNTED ACCESSORY (buy main → get that one accessory,
 * quantity 1, its own %), scoped by a title prefix so we can create / update /
 * delete just this product's nodes.
 *
 * Per-accessory (not per-%-level) because Shopify's get-quantity is a hard
 * threshold: a single node with "get N" only applies when N eligible items are
 * present and discounts exactly N. Quantity-1-per-accessory + combinesWith lets
 * every selected accessory be discounted independently, however many are chosen.
 */

type AdminGraphql = {
  graphql: (query: string, options?: { variables?: any }) => Promise<Response>;
};

function numericId(gid: string) {
  return gid.replace("gid://shopify/Product/", "");
}
/** Title encodes the product + accessory so we only ever touch our own nodes. */
function nodeTitle(productNumericId: string, accNumericId: string) {
  return `CGP-ACC ${productNumericId}:${accNumericId}`;
}

/** BxGy input: buy the MAIN product, get ONE accessory `pct`% off. */
function bxgyInput(mainId: string, giftId: string, pct: number) {
  return {
    title: "", // filled by caller
    combinesWith: {
      orderDiscounts: true,
      productDiscounts: true, // stack with our other per-accessory nodes
      shippingDiscounts: true,
    },
    // Minimum SPEND of the main (not a quantity) — a spend threshold is a
    // non-consumed CONDITION, so every per-accessory node can trigger off the
    // SAME single main in the cart. A quantity-based "buy 1" is consumed per
    // discount, which would force one main per discounted accessory.
    customerBuys: {
      value: { amount: "0.01" },
      items: { products: { productsToAdd: [mainId] } },
    },
    customerGets: {
      value: {
        discountOnQuantity: {
          quantity: "1", // one accessory, discounted on its own
          effect: { percentage: Math.min(1, Math.max(0, pct / 100)) },
        },
      },
      items: { products: { productsToAdd: [giftId] } },
    },
  };
}

/** Existing CGP-ACC nodes for this product: title-level → DiscountAutomaticNode id. */
async function existingNodes(
  admin: AdminGraphql,
  productNumericId: string,
): Promise<Map<string, string>> {
  const resp = await admin.graphql(
    `#graphql
      query AccNodes {
        discountNodes(first: 250) {
          nodes {
            id
            discount { __typename ... on DiscountAutomaticBxgy { title } }
          }
        }
      }`,
  );
  const json = await resp.json();
  const prefix = `CGP-ACC ${productNumericId}:`;
  const map = new Map<string, string>();
  for (const n of json?.data?.discountNodes?.nodes ?? []) {
    const title = n?.discount?.title;
    if (typeof title === "string" && title.startsWith(prefix)) {
      const numeric = String(n.id).split("/").pop();
      map.set(
        title.slice(prefix.length),
        `gid://shopify/DiscountAutomaticNode/${numeric}`,
      );
    }
  }
  return map;
}

/** Make this product's BxGy discount nodes match its config (create/update/delete). */
export async function reconcileAccessoryDiscounts(
  admin: AdminGraphql,
  product: ProductSummary,
  config: AccessoryConfig,
): Promise<string[]> {
  const errors: string[] = [];
  const pid = numericId(product.id);
  const accessories = discountedAccessories(config); // one entry per accessory
  const existing = await existingNodes(admin, pid);
  const wanted = new Set<string>();

  for (const { productId: giftGid, percent: pct } of accessories) {
    const accKey = numericId(giftGid);
    wanted.add(accKey);
    const input = {
      ...bxgyInput(product.id, giftGid, pct),
      title: nodeTitle(pid, accKey),
      startsAt: new Date().toISOString(), // required by Shopify automatic discounts
    };
    const nodeId = existing.get(accKey);
    if (nodeId) {
      const resp = await admin.graphql(
        `#graphql
          mutation AccUpdate($id: ID!, $d: DiscountAutomaticBxgyInput!) {
            discountAutomaticBxgyUpdate(id: $id, automaticBxgyDiscount: $d) {
              userErrors { message }
            }
          }`,
        { variables: { id: nodeId, d: input } },
      );
      const j = await resp.json();
      for (const e of j?.data?.discountAutomaticBxgyUpdate?.userErrors ?? [])
        errors.push(e.message);
    } else {
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
  }

  // Delete nodes for accessories this product no longer discounts.
  for (const [accKey, nodeId] of existing) {
    if (wanted.has(accKey)) continue;
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
