import type { AddonConfig, ProductSummary } from "./addon-config";

/**
 * Server-only reconciliation of LIMITED-offer discount nodes.
 *
 * Each "limited" group in a product's config is backed by its own automatic
 * discount node so Shopify can time-gate it natively (startsAt/endsAt). One
 * shared Function powers them all; the node's app-reserved metafield carries the
 * `offerId` so the Function knows which offer it is running for. The node is set
 * NOT to combine with other product discounts, so on a limited line the deeper
 * of {this node, the main node's fallback} wins — giving "revert after expiry"
 * for free without the (clock-less) Function ever needing the time.
 *
 * Nodes are store-wide, so to stay scoped to ONE product we encode
 * `productId:offerId` in the node title and only ever touch nodes matching this
 * product's prefix.
 */

type AdminGraphql = {
  graphql: (query: string, options?: { variables?: any }) => Promise<Response>;
};

const PRODUCT_DISCOUNT_API_TYPE = "product_discounts";
const LO_NAMESPACE = "$app:limited";
const LO_KEY = "offer";

function nodeTitle(numericId: string, offerId: string) {
  return `CGP-LO ${numericId}:${offerId}`;
}

async function findFunctionId(admin: AdminGraphql): Promise<string | null> {
  const resp = await admin.graphql(
    `#graphql
      query DiscountFunctions {
        shopifyFunctions(first: 50) { nodes { id apiType } }
      }`,
  );
  const json = await resp.json();
  const fn = (json?.data?.shopifyFunctions?.nodes ?? []).find(
    (n: any) => n.apiType === PRODUCT_DISCOUNT_API_TYPE,
  );
  return fn?.id ?? null;
}

/**
 * Make the store's limited-offer nodes match this product's config: create new
 * offers, update changed windows, delete offers that were removed.
 */
export async function reconcileLimitedOffers(
  admin: AdminGraphql,
  product: ProductSummary,
  config: AddonConfig,
): Promise<{ userErrors: string[] }> {
  const numericId = product.id.replace("gid://shopify/Product/", "");
  const limited = config.groups.filter(
    (g) =>
      g.type === "bundle" &&
      !g.archived &&
      g.limited?.enabled &&
      typeof g.offerId === "string" &&
      g.offerId,
  );

  // List existing nodes for THIS product (title prefix match). NOTE: app
  // (function) discounts are `DiscountAutomaticApp` and are returned by
  // `discountNodes`, NOT `automaticDiscountNodes` (which only lists the
  // built-in Basic/Bxgy/FreeShipping types). Using the wrong query made every
  // lookup come back empty, so reconcile kept trying to CREATE and hit
  // "Title must be unique" on re-save.
  const listResp = await admin.graphql(
    `#graphql
      query ExistingLimitedNodes {
        discountNodes(first: 250) {
          nodes {
            id
            discount {
              __typename
              ... on DiscountAutomaticApp { title }
            }
          }
        }
      }`,
  );
  const listJson = await listResp.json();
  const prefix = `CGP-LO ${numericId}:`;
  const existing = new Map<string, string>(); // offerId -> DiscountAutomaticNode id
  for (const n of listJson?.data?.discountNodes?.nodes ?? []) {
    const title = n?.discount?.title;
    if (typeof title === "string" && title.startsWith(prefix)) {
      // discountNodes ids are gid://shopify/DiscountNode/<n>, but the update/
      // delete mutations require gid://shopify/DiscountAutomaticNode/<n>.
      const numeric = String(n.id).split("/").pop();
      existing.set(
        title.slice(prefix.length),
        `gid://shopify/DiscountAutomaticNode/${numeric}`,
      );
    }
  }

  // Nothing to do at all (no limited offers, no leftovers).
  if (limited.length === 0 && existing.size === 0) {
    return { userErrors: [] };
  }

  const functionId = limited.length > 0 ? await findFunctionId(admin) : null;
  if (limited.length > 0 && !functionId) {
    return {
      userErrors: [
        "Discount function not deployed — run `shopify app deploy` before creating limited offers.",
      ],
    };
  }

  const errors: string[] = [];
  const wanted = new Set<string>();

  for (const g of limited) {
    const offerId = g.offerId as string;
    wanted.add(offerId);

    const lim = g.limited;
    const startsAt = lim?.startsAt
      ? new Date(lim.startsAt).toISOString()
      : new Date().toISOString();
    const endsAt = lim?.endsAt ? new Date(lim.endsAt).toISOString() : null;

    const base = {
      title: nodeTitle(numericId, offerId),
      startsAt,
      endsAt,
      combinesWith: {
        productDiscounts: false, // don't stack with the main node on the same line
        orderDiscounts: true,
        shippingDiscounts: true,
      },
    };

    const nodeId = existing.get(offerId);
    if (nodeId) {
      const resp = await admin.graphql(
        `#graphql
          mutation UpdateLimited($id: ID!, $d: DiscountAutomaticAppInput!) {
            discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $d) {
              userErrors { message }
            }
          }`,
        { variables: { id: nodeId, d: base } },
      );
      const json = await resp.json();
      for (const e of json?.data?.discountAutomaticAppUpdate?.userErrors ?? [])
        errors.push(e.message);
    } else {
      const resp = await admin.graphql(
        `#graphql
          mutation CreateLimited($d: DiscountAutomaticAppInput!) {
            discountAutomaticAppCreate(automaticAppDiscount: $d) {
              userErrors { message }
            }
          }`,
        {
          variables: {
            d: {
              ...base,
              functionId,
              metafields: [
                {
                  namespace: LO_NAMESPACE,
                  key: LO_KEY,
                  type: "json",
                  value: JSON.stringify({ offerId, productId: product.id }),
                },
              ],
            },
          },
        },
      );
      const json = await resp.json();
      for (const e of json?.data?.discountAutomaticAppCreate?.userErrors ?? [])
        errors.push(e.message);
    }
  }

  // Delete nodes for offers this product no longer has.
  for (const [offerId, nodeId] of existing) {
    if (wanted.has(offerId)) continue;
    const resp = await admin.graphql(
      `#graphql
        mutation DeleteLimited($id: ID!) {
          discountAutomaticDelete(id: $id) { userErrors { message } }
        }`,
      { variables: { id: nodeId } },
    );
    const json = await resp.json();
    for (const e of json?.data?.discountAutomaticDelete?.userErrors ?? [])
      errors.push(e.message);
  }

  return { userErrors: errors };
}
