import prisma from "../db.server";
import {
  GIFT_NODE_NAMESPACE,
  GIFT_NODE_KEY,
  GIFT_TRIGGER_NAMESPACE,
  GIFT_TRIGGER_KEY,
  rowToCampaign,
  type GiftCampaign,
} from "./gift-campaign";
import { syncPromoTags, PROMO_TAG_GIFT } from "./promo-tags.server";

type AdminGraphql = {
  graphql: (query: string, options?: { variables?: any }) => Promise<Response>;
};

const PRODUCT_DISCOUNT_API_TYPE = "product_discounts";
const NODE_TITLE_PREFIX = "CGP-GIFT ";

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

/** Resolve a collection's product gids (capped — large collections need resync). */
async function collectionProductIds(
  admin: AdminGraphql,
  collectionId: string,
): Promise<string[]> {
  const resp = await admin.graphql(
    `#graphql
      query CollProducts($id: ID!) {
        collection(id: $id) {
          products(first: 250) { nodes { id } }
        }
      }`,
    { variables: { id: collectionId } },
  );
  const json = await resp.json();
  return (json?.data?.collection?.products?.nodes ?? [])
    .map((n: any) => n?.id)
    .filter((x: any) => typeof x === "string");
}

/** All product gids a campaign triggers = manual list + expanded collections. */
async function expandTriggerProducts(
  admin: AdminGraphql,
  c: GiftCampaign,
): Promise<string[]> {
  const ids = new Set<string>(c.triggerProducts.map((p) => p.id));
  for (const coll of c.triggerCollections) {
    for (const pid of await collectionProductIds(admin, coll.id)) ids.add(pid);
  }
  return [...ids];
}

/** Set `custom.gift_trigger` on each product to the given campaign entries. */
async function writeTriggerStamps(
  admin: AdminGraphql,
  map: Map<string, any[]>,
): Promise<string[]> {
  const errors: string[] = [];
  const entries = [...map.entries()];
  for (let i = 0; i < entries.length; i += 25) {
    const chunk = entries.slice(i, i + 25);
    const metafields = chunk.map(([ownerId, campIds]) => ({
      ownerId,
      namespace: GIFT_TRIGGER_NAMESPACE,
      key: GIFT_TRIGGER_KEY,
      type: "json",
      value: JSON.stringify(campIds),
    }));
    const resp = await admin.graphql(
      `#graphql
        mutation StampTriggers($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors { message }
          }
        }`,
      { variables: { metafields } },
    );
    const json = await resp.json();
    for (const e of json?.data?.metafieldsSet?.userErrors ?? [])
      errors.push(e.message);
  }
  return errors;
}

/**
 * Recompute `custom.gift_trigger` for the given products from ALL enabled
 * campaigns. The stamp is SELF-CONTAINED per product — the theme reads only the
 * product's own metafield (guaranteed readable in Liquid via write_products) to
 * auto-add gifts, no shop-level metafield needed. Each entry:
 *   { id, triggers:[numericIds], gifts:[handles], perQualifying, badge }
 * Products no longer triggered by anything are set to [].
 */
async function restampProducts(
  admin: AdminGraphql,
  shop: string,
  affected: Set<string>,
): Promise<string[]> {
  if (affected.size === 0) return [];
  const rows = await prisma.giftCampaign.findMany({
    where: { shop, enabled: true },
  });
  const map = new Map<string, any[]>();
  for (const pid of affected) map.set(pid, []);
  for (const row of rows) {
    const c = rowToCampaign(row);
    const triggerGids = await expandTriggerProducts(admin, c);
    const entry = {
      id: c.id,
      triggers: triggerGids.map(gidTail),
      gifts: c.giftProducts.map((g) => g.handle).filter(Boolean),
      perQualifying: Math.max(1, c.perQualifying || 1),
      badge: c.badgeText || "",
      rewardMode: c.rewardMode,
      startsAt: c.startsAt || "",
      endsAt: c.endsAt || "",
    };
    for (const pid of triggerGids) {
      if (!affected.has(pid)) continue; // only rewrite the affected set
      map.get(pid)!.push(entry);
    }
  }
  const errors = await writeTriggerStamps(admin, map);
  // Promo tag: a product that triggers ≥1 enabled campaign gets `promo:gift`.
  for (const [pid, entries] of map) {
    await syncPromoTags(
      admin,
      pid,
      entries.length ? [PROMO_TAG_GIFT] : [],
      [PROMO_TAG_GIFT],
    );
  }
  return errors;
}

/** Create or update the campaign's automatic discount node + its rules metafield. */
async function reconcileNode(
  admin: AdminGraphql,
  c: GiftCampaign,
  existingNodeId: string | null,
): Promise<{ nodeId: string | null; errors: string[] }> {
  const errors: string[] = [];
  const startsAt = c.startsAt
    ? new Date(c.startsAt).toISOString()
    : new Date().toISOString();
  const endsAt = c.endsAt ? new Date(c.endsAt).toISOString() : null;
  const base = {
    title: `${NODE_TITLE_PREFIX}${c.id}`,
    startsAt,
    endsAt,
    combinesWith: {
      productDiscounts: true,
      orderDiscounts: true,
      shippingDiscounts: true,
    },
  };

  if (existingNodeId) {
    const resp = await admin.graphql(
      `#graphql
        mutation UpdateGift($id: ID!, $d: DiscountAutomaticAppInput!) {
          discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $d) {
            userErrors { message }
          }
        }`,
      { variables: { id: existingNodeId, d: base } },
    );
    const json = await resp.json();
    for (const e of json?.data?.discountAutomaticAppUpdate?.userErrors ?? [])
      errors.push(e.message);
    return { nodeId: existingNodeId, errors };
  }

  const functionId = await findFunctionId(admin);
  if (!functionId) {
    return {
      nodeId: null,
      errors: ["Discount function not deployed — run `shopify app deploy`."],
    };
  }
  const resp = await admin.graphql(
    `#graphql
      mutation CreateGift($d: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $d) {
          automaticAppDiscount { discountId }
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
              namespace: GIFT_NODE_NAMESPACE,
              key: GIFT_NODE_KEY,
              type: "json",
              value: JSON.stringify({
                id: c.id,
                giftProducts: c.giftProducts.map((g) => g.id),
                perQualifying: Math.max(1, c.perQualifying || 1),
              }),
            },
          ],
        },
      },
    },
  );
  const json = await resp.json();
  for (const e of json?.data?.discountAutomaticAppCreate?.userErrors ?? [])
    errors.push(e.message);
  const discountId =
    json?.data?.discountAutomaticAppCreate?.automaticAppDiscount?.discountId ??
    null;
  return { nodeId: discountId, errors };
}

/** Update the node's rules metafield (gift set / perQualifying changed). */
async function writeNodeRules(
  admin: AdminGraphql,
  nodeId: string,
  c: GiftCampaign,
): Promise<string[]> {
  const resp = await admin.graphql(
    `#graphql
      mutation NodeRules($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { message } }
      }`,
    {
      variables: {
        metafields: [
          {
            ownerId: nodeId,
            namespace: GIFT_NODE_NAMESPACE,
            key: GIFT_NODE_KEY,
            type: "json",
            value: JSON.stringify({
              id: c.id,
              giftProducts: c.giftProducts.map((g) => g.id),
              perQualifying: Math.max(1, c.perQualifying || 1),
            }),
          },
        ],
      },
    },
  );
  const json = await resp.json();
  return (json?.data?.metafieldsSet?.userErrors ?? []).map((e: any) => e.message);
}

function gidTail(id: string) {
  return String(id).split("/").pop() || "";
}

async function shopGid(admin: AdminGraphql): Promise<string | null> {
  const resp = await admin.graphql(`#graphql
    query { shop { id } }`);
  const json = await resp.json();
  return json?.data?.shop?.id ?? null;
}

/**
 * Publish a compact, theme-readable snapshot of all enabled campaigns to a SHOP
 * metafield (custom.gift_campaigns) so the storefront can auto-add gifts and show
 * badges. Trigger ids are numeric + collection-expanded so the theme can match
 * cart line product_ids without reading per-line metafields.
 */
export async function writeShopCampaigns(
  admin: AdminGraphql,
  shop: string,
): Promise<string[]> {
  const rows = await prisma.giftCampaign.findMany({
    where: { shop, enabled: true },
  });
  const list = [];
  for (const row of rows) {
    const c = rowToCampaign(row);
    const triggerIds = (await expandTriggerProducts(admin, c)).map(gidTail);
    list.push({
      id: c.id,
      perQualifying: Math.max(1, c.perQualifying || 1),
      rewardMode: c.rewardMode,
      badge: c.badgeText || "",
      startsAt: c.startsAt || "",
      endsAt: c.endsAt || "",
      triggerProductIds: triggerIds,
      giftHandles: c.giftProducts.map((g) => g.handle).filter(Boolean),
    });
  }
  const owner = await shopGid(admin);
  if (!owner) return ["Could not resolve shop id."];
  const resp = await admin.graphql(
    `#graphql
      mutation ShopCampaigns($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { message } }
      }`,
    {
      variables: {
        metafields: [
          {
            ownerId: owner,
            namespace: "custom",
            key: "gift_campaigns",
            type: "json",
            value: JSON.stringify(list),
          },
        ],
      },
    },
  );
  const json = await resp.json();
  return (json?.data?.metafieldsSet?.userErrors ?? []).map(
    (e: any) => e.message,
  );
}

// ---- public API ----

export async function listCampaigns(shop: string): Promise<GiftCampaign[]> {
  const rows = await prisma.giftCampaign.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(rowToCampaign);
}

export async function getCampaign(
  shop: string,
  id: string,
): Promise<GiftCampaign | null> {
  const row = await prisma.giftCampaign.findFirst({ where: { shop, id } });
  return row ? rowToCampaign(row) : null;
}

export async function saveCampaign(
  admin: AdminGraphql,
  shop: string,
  c: GiftCampaign,
): Promise<{ ok: boolean; errors: string[] }> {
  const prev = await prisma.giftCampaign.findFirst({ where: { shop, id: c.id } });

  // 1. Discount node (time-gated) + rules metafield.
  const node = await reconcileNode(admin, c, prev?.nodeId ?? null);
  const errors = [...node.errors];
  if (node.nodeId && prev?.nodeId) {
    errors.push(...(await writeNodeRules(admin, node.nodeId, c)));
  }

  // 2. Persist (source of truth).
  const data = {
    shop,
    title: c.title,
    enabled: c.enabled,
    startsAt: c.startsAt ? new Date(c.startsAt) : null,
    endsAt: c.endsAt ? new Date(c.endsAt) : null,
    perQualifying: Math.max(1, c.perQualifying || 1),
    rewardMode: c.rewardMode === "choice" ? "choice" : "fixed",
    badgeText: c.badgeText,
    triggerProductsJson: JSON.stringify(c.triggerProducts),
    triggerCollectionsJson: JSON.stringify(c.triggerCollections),
    giftProductsJson: JSON.stringify(c.giftProducts),
    nodeId: node.nodeId ?? prev?.nodeId ?? null,
  };
  await prisma.giftCampaign.upsert({
    where: { id: c.id },
    create: { id: c.id, ...data },
    update: data,
  });

  // 3. Restamp trigger products (old set ∪ new set), recomputed from all
  //    enabled campaigns so every product's gift_trigger stays correct.
  const affected = new Set<string>(await expandTriggerProducts(admin, c));
  if (prev) {
    const prevCampaign = rowToCampaign(prev);
    for (const pid of await expandTriggerProducts(admin, prevCampaign))
      affected.add(pid);
  }
  errors.push(...(await restampProducts(admin, shop, affected)));

  return { ok: errors.length === 0, errors };
}

export async function deleteCampaign(
  admin: AdminGraphql,
  shop: string,
  id: string,
): Promise<{ ok: boolean; errors: string[] }> {
  const row = await prisma.giftCampaign.findFirst({ where: { shop, id } });
  if (!row) return { ok: true, errors: [] };
  const c = rowToCampaign(row);
  const errors: string[] = [];

  if (row.nodeId) {
    const resp = await admin.graphql(
      `#graphql
        mutation DeleteGift($id: ID!) {
          discountAutomaticDelete(id: $id) { userErrors { message } }
        }`,
      { variables: { id: row.nodeId } },
    );
    const json = await resp.json();
    for (const e of json?.data?.discountAutomaticDelete?.userErrors ?? [])
      errors.push(e.message);
  }

  // Forget the row first so restamp recomputes WITHOUT this campaign.
  const affected = new Set<string>(await expandTriggerProducts(admin, c));
  await prisma.giftCampaign.delete({ where: { id } });
  errors.push(...(await restampProducts(admin, shop, affected)));

  return { ok: errors.length === 0, errors };
}

/** Re-expand collections and rewrite stamps for every campaign (manual sync). */
export async function resyncAll(
  admin: AdminGraphql,
  shop: string,
): Promise<{ ok: boolean; errors: string[] }> {
  const rows = await prisma.giftCampaign.findMany({ where: { shop } });
  const affected = new Set<string>();
  for (const row of rows) {
    for (const pid of await expandTriggerProducts(admin, rowToCampaign(row)))
      affected.add(pid);
  }
  const errors = await restampProducts(admin, shop, affected);
  return { ok: errors.length === 0, errors };
}
