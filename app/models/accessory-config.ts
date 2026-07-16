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
  /** optional = customer-selected paid/discounted; free = 100% off. */
  type: "optional" | "free";
  /** single = pick at most one; multi = pick any number. */
  selectMode: "single" | "multi";
  accessories: AccessoryItem[];
  archived?: boolean;
};

export type AccessoryConfig = {
  version: number;
  groups: AccessoryGroup[];
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
      ? data.groups.map((g: any) => ({
          id: typeof g?.id === "string" ? g.id : newAccGroupId(),
          title: typeof g?.title === "string" ? g.title : "Accessories",
          type: g?.type === "free" ? "free" : "optional",
          selectMode: g?.selectMode === "single" ? "single" : "multi",
          accessories: parseItems(g?.accessories),
          archived: Boolean(g?.archived),
        }))
      : [];
    return { version: 1, groups };
  } catch {
    return { ...EMPTY_ACC_CONFIG };
  }
}

/**
 * The distinct discount levels a product's config needs backing native BxGy
 * discounts for: a map of percent (1–100) → the gift/accessory product gids that
 * get that % off when the main is bought. Full-price items (0%) need no discount.
 */
export function discountLevels(config: AccessoryConfig): Map<number, string[]> {
  const levels = new Map<number, string[]>();
  for (const g of config.groups) {
    if (g.archived) continue;
    for (const a of g.accessories) {
      const pct = itemPercent(g, a);
      if (pct <= 0) continue; // full price → no native discount
      const list = levels.get(pct) ?? [];
      if (!list.includes(a.productId)) list.push(a.productId);
      levels.set(pct, list);
    }
  }
  return levels;
}
