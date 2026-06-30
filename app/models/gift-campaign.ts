/**
 * Shared, client-safe types + helpers for Gift Campaigns (cross-product "gift
 * with purchase"). No server-only imports so React can use it.
 */

// Node metafield the Function reads (one node per campaign, time-gated).
export const GIFT_NODE_NAMESPACE = "$app:gift";
export const GIFT_NODE_KEY = "campaign";
// Product metafield stamped on trigger products: JSON array of campaign ids.
export const GIFT_TRIGGER_NAMESPACE = "custom";
export const GIFT_TRIGGER_KEY = "gift_trigger";

export type Ref = {
  id: string; // gid://shopify/Product/... or Collection/...
  title: string;
  handle: string;
  image?: string | null;
};

export type GiftCampaign = {
  id: string; // camp_xxxx
  title: string;
  enabled: boolean;
  startsAt: string; // ISO-8601 or ""
  endsAt: string; // ISO-8601 or ""
  /** Free gifts granted per qualifying unit (buy 2 -> 2). */
  perQualifying: number;
  /** "fixed" = auto-add the single gift; "choice" = customer picks from the set. */
  rewardMode: "fixed" | "choice";
  badgeText: string;
  triggerProducts: Ref[]; // manual product list
  triggerCollections: Ref[]; // Shopify collections (expanded at save time)
  giftProducts: Ref[]; // the gift set
};

export function newCampaignId() {
  return `camp_${Math.random().toString(36).slice(2, 10)}`;
}

export function emptyCampaign(): GiftCampaign {
  return {
    id: newCampaignId(),
    title: "",
    enabled: true,
    startsAt: "",
    endsAt: "",
    perQualifying: 1,
    rewardMode: "fixed",
    badgeText: "🎁 Free gift",
    triggerProducts: [],
    triggerCollections: [],
    giftProducts: [],
  };
}

/** Live state of a campaign's schedule. */
export function campaignState(
  c: Pick<GiftCampaign, "enabled" | "startsAt" | "endsAt">,
): "disabled" | "scheduled" | "active" | "ended" {
  if (!c.enabled) return "disabled";
  const now = Date.now();
  const s = c.startsAt ? Date.parse(c.startsAt) : NaN;
  const e = c.endsAt ? Date.parse(c.endsAt) : NaN;
  if (!Number.isNaN(e) && now >= e) return "ended";
  if (!Number.isNaN(s) && now < s) return "scheduled";
  return "active";
}

function parseRefs(json: string | null | undefined): Ref[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr)
      ? arr
          .filter((r: any) => typeof r?.id === "string")
          .map((r: any) => ({
            id: r.id,
            title: typeof r.title === "string" ? r.title : "",
            handle: typeof r.handle === "string" ? r.handle : "",
            image: r.image ?? null,
          }))
      : [];
  } catch {
    return [];
  }
}

/** Build a GiftCampaign from a Prisma row (shape-compatible). */
export function rowToCampaign(row: any): GiftCampaign {
  return {
    id: row.id,
    title: row.title ?? "",
    enabled: !!row.enabled,
    startsAt: row.startsAt ? new Date(row.startsAt).toISOString() : "",
    endsAt: row.endsAt ? new Date(row.endsAt).toISOString() : "",
    perQualifying: Math.max(1, Number(row.perQualifying) || 1),
    rewardMode: row.rewardMode === "choice" ? "choice" : "fixed",
    badgeText: row.badgeText ?? "",
    triggerProducts: parseRefs(row.triggerProductsJson),
    triggerCollections: parseRefs(row.triggerCollectionsJson),
    giftProducts: parseRefs(row.giftProductsJson),
  };
}
