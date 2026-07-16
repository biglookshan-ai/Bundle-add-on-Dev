import prisma from "../db.server";
import {
  ACC_METAFIELD_NAMESPACE,
  ACC_METAFIELD_KEY,
  EMPTY_ACC_CONFIG,
  discountLevels,
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
 * one BxGy node per distinct discount level (e.g. 10% off, 100% off), scoped by
 * a title prefix so we can create / update / delete just this product's nodes.
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

/** BxGy input: buy the MAIN product, get these accessories `pct`% off. */
function bxgyInput(mainId: string, giftIds: string[], pct: number) {
  return {
    title: "", // filled by caller
    combinesWith: {
      orderDiscounts: true,
      productDiscounts: true,
      shippingDiscounts: true,
    },
    customerBuys: {
      value: { quantity: "1" },
      items: { products: { productsToAdd: [mainId] } },
    },
    customerGets: {
      value: {
        discountOnQuantity: {
          quantity: String(Math.max(giftIds.length, 10)),
          effect: { percentage: Math.min(1, Math.max(0, pct / 100)) },
        },
      },
      items: { products: { productsToAdd: giftIds } },
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
  const levels = discountLevels(config); // pct -> [accessory gids]
  const existing = await existingNodes(admin, pid);
  const wanted = new Set<string>();

  for (const [pct, giftIds] of levels) {
    if (!giftIds.length) continue;
    const levelKey = String(pct);
    wanted.add(levelKey);
    const input = { ...bxgyInput(product.id, giftIds, pct), title: nodeTitle(pid, pct) };
    const nodeId = existing.get(levelKey);
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

  // Delete nodes for levels this product no longer has.
  for (const [levelKey, nodeId] of existing) {
    if (wanted.has(levelKey)) continue;
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
