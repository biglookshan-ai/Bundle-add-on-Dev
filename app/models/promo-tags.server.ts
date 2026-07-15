/**
 * Promotion tags on products, so the storefront / self-built search engine can
 * SHOW a badge ("has bundle", "free gift", …) and FILTER by promo on collection
 * and search-results pages — where the metafield-based offers are otherwise
 * invisible. Each source (bundle/add-on/free config, gift campaigns) manages only
 * its own subset of tags so they don't clobber each other.
 */

type AdminGraphql = {
  graphql: (query: string, options?: { variables?: any }) => Promise<Response>;
};

export const PROMO_TAG_BUNDLE = "promo:bundle";
export const PROMO_TAG_ADDON = "promo:addon";
export const PROMO_TAG_FREE = "promo:free";
export const PROMO_TAG_GIFT = "promo:gift";

async function tagsAdd(admin: AdminGraphql, id: string, tags: string[]) {
  await admin.graphql(
    `#graphql
      mutation PromoTagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) { userErrors { message } }
      }`,
    { variables: { id, tags } },
  );
}

async function tagsRemove(admin: AdminGraphql, id: string, tags: string[]) {
  await admin.graphql(
    `#graphql
      mutation PromoTagsRemove($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) { userErrors { message } }
      }`,
    { variables: { id, tags } },
  );
}

/**
 * Make a product carry exactly `want` out of the `managed` promo tags — add the
 * ones it should have, remove the managed ones it shouldn't. Tags outside
 * `managed` (e.g. another source's promo tag, or unrelated tags) are untouched.
 */
export async function syncPromoTags(
  admin: AdminGraphql,
  productId: string,
  want: string[],
  managed: string[],
): Promise<void> {
  const add = managed.filter((t) => want.includes(t));
  const remove = managed.filter((t) => !want.includes(t));
  if (add.length) await tagsAdd(admin, productId, add);
  if (remove.length) await tagsRemove(admin, productId, remove);
}
