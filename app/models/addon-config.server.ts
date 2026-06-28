import prisma from "../db.server";
import {
  METAFIELD_NAMESPACE,
  METAFIELD_KEY,
  EMPTY_CONFIG,
  parseConfig,
  countAccessories,
  summarizeConfig,
  type AddonConfig,
  type ProductSummary,
} from "./addon-config";

/**
 * Server-only operations for add-on config. Config lives in two places kept in
 * sync by `saveConfig`:
 *
 *  1. The `custom.addon_config` JSON metafield on each MAIN product — the
 *     source of truth, read by the storefront block and the discount Function.
 *  2. A `BundleConfig` row in the app DB — a dashboard index so the admin home
 *     can list configured products without scanning the catalog.
 */

type AdminGraphql = {
  graphql: (query: string, options?: { variables?: any }) => Promise<Response>;
};

/** Fetch a single product's summary + its current add-on config from Shopify. */
export async function readConfig(
  admin: AdminGraphql,
  productId: string,
): Promise<{ product: ProductSummary | null; config: AddonConfig }> {
  const response = await admin.graphql(
    `#graphql
      query AddonConfig($id: ID!, $ns: String!, $key: String!) {
        product(id: $id) {
          id
          title
          handle
          featuredImage { url }
          metafield(namespace: $ns, key: $key) {
            value
          }
        }
      }`,
    {
      variables: {
        id: productId,
        ns: METAFIELD_NAMESPACE,
        key: METAFIELD_KEY,
      },
    },
  );
  const json = await response.json();
  const product = json?.data?.product;
  if (!product) return { product: null, config: { ...EMPTY_CONFIG } };
  return {
    product: {
      id: product.id,
      title: product.title,
      handle: product.handle,
      image: product.featuredImage?.url ?? null,
    },
    config: parseConfig(product.metafield?.value),
  };
}

/**
 * Write the config to the product metafield AND mirror it to the dashboard
 * index. If the config has no groups, the metafield is deleted and the mirror
 * row removed so the product no longer shows as "configured".
 */
export async function saveConfig(
  admin: AdminGraphql,
  shop: string,
  product: ProductSummary,
  config: AddonConfig,
): Promise<{ ok: boolean; userErrors: string[] }> {
  const hasGroups = config.groups.length > 0;

  if (!hasGroups) {
    await clearMetafield(admin, product.id);
    await prisma.bundleConfig.deleteMany({
      where: { shop, productId: product.id },
    });
    return { ok: true, userErrors: [] };
  }

  const response = await admin.graphql(
    `#graphql
      mutation SetAddonConfig($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        metafields: [
          {
            ownerId: product.id,
            namespace: METAFIELD_NAMESPACE,
            key: METAFIELD_KEY,
            type: "json",
            value: JSON.stringify(config),
          },
        ],
      },
    },
  );
  const json = await response.json();
  const userErrors: string[] = (
    json?.data?.metafieldsSet?.userErrors ?? []
  ).map((e: any) => e.message);

  if (userErrors.length > 0) {
    return { ok: false, userErrors };
  }

  const groupsJson = JSON.stringify(summarizeConfig(config));
  await prisma.bundleConfig.upsert({
    where: { shop_productId: { shop, productId: product.id } },
    create: {
      shop,
      productId: product.id,
      productTitle: product.title,
      productHandle: product.handle,
      productImage: product.image ?? null,
      groupCount: config.groups.length,
      accessoryCount: countAccessories(config),
      groupsJson,
    },
    update: {
      productTitle: product.title,
      productHandle: product.handle,
      productImage: product.image ?? null,
      groupCount: config.groups.length,
      accessoryCount: countAccessories(config),
      groupsJson,
    },
  });

  return { ok: true, userErrors: [] };
}

async function clearMetafield(admin: AdminGraphql, productId: string) {
  await admin.graphql(
    `#graphql
      mutation ClearAddonConfig($metafields: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $metafields) {
          deletedMetafields { key }
          userErrors { message }
        }
      }`,
    {
      variables: {
        metafields: [
          {
            ownerId: productId,
            namespace: METAFIELD_NAMESPACE,
            key: METAFIELD_KEY,
          },
        ],
      },
    },
  );
}

export type VariantOption = {
  id: string;
  title: string;
  /** Selling price of this variant. */
  price?: number;
  /** True original (compare-at) of this variant; equals price when not on sale. */
  compareAt?: number;
};
export type ProductMeta = { title: string; handle: string; image: string | null };

/**
 * Live prices (major units) + variant lists + current title/handle/image for a
 * set of products, for the editor's preview, variant picker, and to keep the
 * stored accessory title/handle in sync with Shopify.
 */
export async function fetchProductPrices(
  admin: AdminGraphql,
  ids: string[],
): Promise<{
  prices: Record<string, number>;
  compareAt: Record<string, number>;
  variants: Record<string, VariantOption[]>;
  info: Record<string, ProductMeta>;
  currency: string;
}> {
  const unique = Array.from(new Set(ids)).filter(Boolean);
  if (unique.length === 0)
    return { prices: {}, compareAt: {}, variants: {}, info: {}, currency: "USD" };
  const resp = await admin.graphql(
    `#graphql
      query Prices($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            handle
            featuredImage { url }
            priceRangeV2 { minVariantPrice { amount currencyCode } }
            variants(first: 100) { nodes { id title price compareAtPrice } }
          }
        }
      }`,
    { variables: { ids: unique } },
  );
  const json = await resp.json();
  const prices: Record<string, number> = {};
  // True original (compare-at) of the representative variant, so a product that
  // is ALREADY on sale shows its real MSRP — not the already-discounted price.
  const compareAt: Record<string, number> = {};
  const variants: Record<string, VariantOption[]> = {};
  const info: Record<string, ProductMeta> = {};
  let currency = "USD";
  for (const n of json?.data?.nodes ?? []) {
    if (!n?.id) continue;
    info[n.id] = {
      title: n.title ?? "",
      handle: n.handle ?? "",
      image: n.featuredImage?.url ?? null,
    };
    const mp = n?.priceRangeV2?.minVariantPrice;
    if (mp) {
      prices[n.id] = Number(mp.amount) || 0;
      currency = mp.currencyCode || currency;
    }
    const rawVariants = (n?.variants?.nodes ?? []).filter((v: any) => v?.id);
    // Representative variant = the lowest-priced one (matches minVariantPrice).
    let rep: any = null;
    for (const v of rawVariants) {
      const p = Number(v.price) || 0;
      if (!rep || p < (Number(rep.price) || 0)) rep = v;
    }
    if (rep) {
      const repPrice = Number(rep.price) || prices[n.id] || 0;
      const repCompare = Number(rep.compareAtPrice) || 0;
      // Use compare-at only when it's a real higher MSRP; else there's no
      // pre-existing discount and the "original" equals the current price.
      compareAt[n.id] = repCompare > repPrice ? repCompare : repPrice;
    }
    const vs = rawVariants.map((v: any) => {
      const p = Number(v.price) || 0;
      const c = Number(v.compareAtPrice) || 0;
      return { id: v.id, title: v.title, price: p, compareAt: c > p ? c : p };
    });
    if (vs.length) variants[n.id] = vs;
  }
  return { prices, compareAt, variants, info, currency };
}

/** List all configured products for the dashboard, newest first. */
export function listConfigs(shop: string) {
  return prisma.bundleConfig.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
  });
}

export type DetailedConfig = {
  productId: string;
  numericId: string;
  title: string;
  handle: string;
  image: string | null;
  updatedAt: Date;
  config: AddonConfig;
};

/**
 * Dashboard data straight from the source of truth: one batched query reads the
 * live `addon_config` metafield (+ image) of every configured product, so the
 * "by bundle / by add-on" views are always correct without needing a re-save.
 */
export async function listConfigsDetailed(
  admin: AdminGraphql,
  shop: string,
): Promise<DetailedConfig[]> {
  const rows = await prisma.bundleConfig.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
  });
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.productId);
  const response = await admin.graphql(
    `#graphql
      query DashboardConfigs($ids: [ID!]!, $ns: String!, $key: String!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            handle
            featuredImage { url }
            metafield(namespace: $ns, key: $key) { value }
          }
        }
      }`,
    { variables: { ids, ns: METAFIELD_NAMESPACE, key: METAFIELD_KEY } },
  );
  const json = await response.json();
  const nodes: any[] = json?.data?.nodes ?? [];
  const byId = new Map<string, any>();
  for (const n of nodes) if (n?.id) byId.set(n.id, n);

  const out: DetailedConfig[] = [];
  for (const row of rows) {
    const node = byId.get(row.productId);
    if (!node) continue; // product deleted since it was configured
    out.push({
      productId: row.productId,
      numericId: row.productId.replace("gid://shopify/Product/", ""),
      title: node.title ?? row.productTitle,
      handle: node.handle ?? row.productHandle,
      image: node.featuredImage?.url ?? null,
      updatedAt: row.updatedAt,
      config: parseConfig(node.metafield?.value),
    });
  }
  return out;
}
