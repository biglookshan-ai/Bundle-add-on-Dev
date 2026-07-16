/**
 * Simplified, Function-FREE accessory config (works on any Shopify plan).
 *
 * A main product offers groups of optional accessories the customer can add
 * (each at full price, a % off, or free), plus free-gift groups. Discounts are
 * delivered by NATIVE "Buy X Get Y" automatic discounts (no Shopify Function, so
 * no Plus requirement) — the storefront just adds the chosen accessories to the
 * cart and Shopify prices them.
 *
 * Client-safe: no server-only imports.
 */

export const ACC_METAFIELD_NAMESPACE = "custom";
export const ACC_METAFIELD_KEY = "accessory_config";

export type AccessoryItem = {
  productId: string; // gid://shopify/Product/...
  handle: string;
  title: string;
  /**
   * 0 / undefined → full price. 1–99 → that % off (native BxGy). 100 → free.
   * For a `free` group this is forced to 100.
   */
  discountPercent?: number;
  /** Which variants to offer (variant gids); empty = all. */
  variantIds?: string[];
};

export type AccessoryGroup = {
  id: string;
  title: string; // "Filters", "Mounts", "Free gift"
  /** Optional one-line helper shown under the title on the storefront. */
  subtitle?: string;
  /** optional = customer-selected paid/discounted; free = 100% off. */
  type: "optional" | "free";
  /** single = pick at most one; multi = pick any number. */
  selectMode: "single" | "multi";
  /**
   * Show this group only when the selected MAIN variant is one of these
   * (variant gids). Empty / undefined = always show.
   */
  mainVariantIds?: string[];
  accessories: AccessoryItem[];
  archived?: boolean;
};

export type AccessoryConfig = {
  version: number;
  groups: AccessoryGroup[];
  /**
   * Native-discount offer (works on any plan, no leak): buy the main product and
   * add exactly `offerQuantity` accessories to get `offerPercent`% off them, via
   * a single "Buy X Get Y" automatic discount. One rate for all accessories; a
   * fixed required quantity (Shopify's native BxGy limitation).
   */
  offerPercent?: number; // 1–100
  offerQuantity?: number; // how many accessories the customer must add
  /**
   * Bundle mode: the accessories are a FIXED set sold together. Every component
   * is required and pre-selected on the storefront; required quantity is forced
   * to the component count so the discount only applies to the whole set.
   */
  bundleMode?: boolean;
};

export const EMPTY_ACC_CONFIG: AccessoryConfig = { version: 1, groups: [] };

export function newAccGroupId() {
  return `ag_${Math.random().toString(36).slice(2, 10)}`;
}

export function clampPct(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(100, Math.max(0, n)) * 100) / 100;
}

/** Effective discount % for an item (a free group's items are always 100). */
export function itemPercent(group: AccessoryGroup, item: AccessoryItem): number {
  if (group.type === "free") return 100;
  return clampPct(item.discountPercent);
}

function parseItems(raw: any): AccessoryItem[] {
  return Array.isArray(raw)
    ? raw
        .filter((a: any) => typeof a?.productId === "string")
        .map((a: any) => {
          const item: AccessoryItem = {
            productId: a.productId,
            handle: typeof a.handle === "string" ? a.handle : "",
            title: typeof a.title === "string" ? a.title : "",
          };
          if (a.discountPercent != null && a.discountPercent !== "") {
            const n = Number(a.discountPercent);
            if (Number.isFinite(n)) item.discountPercent = clampPct(n);
          }
          if (Array.isArray(a.variantIds)) {
            const ids = a.variantIds.filter(
              (x: any) => typeof x === "string" && x,
            );
            if (ids.length) item.variantIds = ids;
          }
          return item;
        })
    : [];
}

export function parseAccConfig(raw: string | null | undefined): AccessoryConfig {
  if (!raw) return { ...EMPTY_ACC_CONFIG };
  try {
    const data = JSON.parse(raw);
    const groups: AccessoryGroup[] = Array.isArray(data?.groups)
      ? data.groups.map((g: any) => {
          const group: AccessoryGroup = {
            id: typeof g?.id === "string" ? g.id : newAccGroupId(),
            title: typeof g?.title === "string" ? g.title : "Accessories",
            type: g?.type === "free" ? "free" : "optional",
            selectMode: g?.selectMode === "single" ? "single" : "multi",
            accessories: parseItems(g?.accessories),
            archived: Boolean(g?.archived),
          };
          if (typeof g?.subtitle === "string" && g.subtitle.trim())
            group.subtitle = g.subtitle.trim();
          if (Array.isArray(g?.mainVariantIds)) {
            const ids = g.mainVariantIds.filter(
              (x: any) => typeof x === "string" && x,
            );
            if (ids.length) group.mainVariantIds = ids;
          }
          return group;
        })
      : [];
    const cfg: AccessoryConfig = { version: 1, groups };
    if (data?.offerPercent != null) {
      const n = clampPct(data.offerPercent);
      if (n > 0) cfg.offerPercent = n;
    }
    if (data?.offerQuantity != null) {
      const q = Math.round(Number(data.offerQuantity));
      if (Number.isFinite(q) && q > 0) cfg.offerQuantity = q;
    }
    if (data?.bundleMode) cfg.bundleMode = true;
    return cfg;
  } catch {
    return { ...EMPTY_ACC_CONFIG };
  }
}

/** All accessory product gids eligible for the native offer (non-archived groups). */
export function offerAccessoryGids(config: AccessoryConfig): string[] {
  const seen = new Set<string>();
  for (const g of config.groups) {
    if (g.archived) continue;
    for (const a of g.accessories) seen.add(a.productId);
  }
  return [...seen];
}

/**
 * Every accessory that needs a backing native discount, ONE ENTRY PER ACCESSORY
 * product (deduped, keeping the highest % if the same product appears twice).
 *
 * Why per-accessory and not grouped by % level: Shopify's "Buy X Get Y" get-
 * quantity is a HARD THRESHOLD — "get N at X% off" only applies when N eligible
 * items are in the cart, and discounts exactly N. So a single node covering a
 * whole level can't independently discount however many accessories the customer
 * happens to pick. Instead we create one BxGy per accessory (buy main → get THIS
 * one accessory, quantity 1, its %), set to combine, so each selected accessory
 * is discounted on its own regardless of how many others are chosen.
 */
export function discountedAccessories(
  config: AccessoryConfig,
): { productId: string; percent: number }[] {
  const best = new Map<string, number>();
  for (const g of config.groups) {
    if (g.archived) continue;
    for (const a of g.accessories) {
      const pct = itemPercent(g, a);
      if (pct <= 0) continue; // full price → no native discount
      const prev = best.get(a.productId) ?? 0;
      if (pct > prev) best.set(a.productId, pct);
    }
  }
  return [...best.entries()].map(([productId, percent]) => ({
    productId,
    percent,
  }));
}
