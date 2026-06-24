/**
 * Shared, client-safe add-on config types + pure helpers.
 *
 * This module must NOT import server-only code (Prisma, Admin API) so it can be
 * used inside React components. Server-only operations live in
 * `addon-config.server.ts`.
 */

export const METAFIELD_NAMESPACE = "custom";
export const METAFIELD_KEY = "addon_config";

export type AddonAccessory = {
  productId: string; // gid://shopify/Product/...
  handle: string; // used by the storefront to fetch /products/{handle}.js
  title: string;
  /**
   * Optional per-accessory discount override (0–100). When set, it overrides the
   * group's `discountPercent` for THIS accessory only; when undefined, the group
   * discount applies. (0 is a valid override = no discount on this item.)
   */
  discountPercent?: number;
  /**
   * Which variants to OFFER the customer as choices (variant gids). Undefined or
   * empty = offer all variants. When the accessory has >1 offered variant the
   * storefront makes the customer pick one before adding.
   */
  variantIds?: string[];
};

/**
 * Optional limited-time promotion attached to a BUNDLE. The bundle's own
 * `discountPercent` is its normal/standing price; while a limited offer is
 * running, the deeper `discountPercent` here applies instead. After `endsAt`:
 *   - mode "revert" → back to the bundle's normal price
 *   - mode "end"    → the whole bundle disappears (full price)
 * The authoritative time gate lives on a backing automatic-discount node, so a
 * customer can't keep the promo price past expiry (even an abandoned cart
 * reverts at checkout).
 */
export type LimitedOffer = {
  enabled: boolean;
  /** 0–100 deep discount while the offer is live. */
  discountPercent: number;
  mode: "revert" | "end";
  /** ISO-8601 UTC. Empty start = starts immediately. */
  startsAt: string;
  endsAt: string;
};

export type AddonGroup = {
  id: string; // stable client-generated id, e.g. "g_xxxxx"
  /** Stable short human-facing code, e.g. "A1B2C3"; shown with a form prefix. */
  code: string;
  title: string; // shown as a tab/card label on the storefront
  /**
   * "addon"  — optional extras the customer adds individually (Moment "Add On & Save").
   * "bundle" — a curated set offered together (Moment "Bundle & Save"); may carry
   *            an optional limited-time offer.
   * "free"   — a gift auto-added with the main product at 100% off (locked).
   */
  type: "addon" | "bundle" | "free";
  /** 0–100. For a bundle this is the NORMAL price; 100 = free with the main. */
  discountPercent: number;
  accessories: AddonAccessory[];

  // ---- bundle-only ----
  /** Stable id tying a limited bundle to its backing discount node. */
  offerId?: string;
  /** Optional limited-time promotion (bundles only). */
  limited?: LimitedOffer;

  /**
   * Soft-deleted. Archived groups are kept (so they can be restored / reused)
   * but never shown on the storefront, never discount, and don't appear in the
   * active dashboard tabs. Only a permanent delete drops them.
   */
  archived?: boolean;
};

export type AddonConfig = {
  version: number;
  groups: AddonGroup[];
};

export type ProductSummary = {
  id: string;
  title: string;
  handle: string;
  image?: string | null;
};

/** The four merchant-facing "forms" a group can take. */
export type GroupForm = "bundle" | "limited" | "addon" | "free";

export const EMPTY_CONFIG: AddonConfig = { version: 1, groups: [] };

export function newGroupId() {
  return `g_${Math.random().toString(36).slice(2, 10)}`;
}

/** Stable id for a limited offer; mirrored onto its discount node's metafield. */
export function newOfferId() {
  return `lo_${Math.random().toString(36).slice(2, 10)}`;
}

/** Short, human-facing unique code (no ambiguous chars). */
export function newCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function clampPercent(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/** Which of the four forms a group currently is. */
export function groupForm(group: AddonGroup): GroupForm {
  if (group.type === "free") return "free";
  if (group.type === "addon") return "addon";
  return group.limited?.enabled ? "limited" : "bundle";
}

const FORM_PREFIX: Record<GroupForm, string> = {
  bundle: "BDL",
  limited: "LTD",
  addon: "ADO",
  free: "FRE",
};

const FORM_LABEL: Record<GroupForm, string> = {
  bundle: "Bundle",
  limited: "Limited bundle",
  addon: "Add-on",
  free: "Free add-on",
};

/** Display code with a form prefix, e.g. "LTD-A1B2C3". */
export function displayCode(group: AddonGroup): string {
  return `${FORM_PREFIX[groupForm(group)]}-${group.code || ""}`;
}

export function formLabel(group: AddonGroup): string {
  return FORM_LABEL[groupForm(group)];
}

/** Live state of a limited offer (null when not a live limited bundle). */
export function offerStateOf(
  limited?: LimitedOffer,
): "upcoming" | "active" | "ended" | null {
  if (!limited || !limited.enabled) return null;
  const now = Date.now();
  const s = limited.startsAt ? Date.parse(limited.startsAt) : NaN;
  const e = limited.endsAt ? Date.parse(limited.endsAt) : NaN;
  if (!Number.isNaN(e) && now >= e) return "ended";
  if (!Number.isNaN(s) && now < s) return "upcoming";
  return "active";
}

/** Which dashboard bucket a group falls into right now. */
export type Bucket = "bundle" | "sale" | "addon" | "free";
export function groupBucket(group: AddonGroup): Bucket {
  if (group.type === "addon") return "addon";
  if (group.type === "free") return "free";
  // bundle:
  const state = offerStateOf(group.limited);
  if (!state) return "bundle"; // plain bundle
  // A reverted, expired offer is back to being a normal bundle.
  if (state === "ended" && group.limited?.mode === "revert") return "bundle";
  return "sale"; // active / upcoming / ended-and-hidden ("end" mode)
}

/** A sale bundle whose offer fully ended ("end" mode) — shown greyed. */
export function isEndedSale(group: AddonGroup): boolean {
  return (
    offerStateOf(group.limited) === "ended" && group.limited?.mode === "end"
  );
}

export function countAccessories(config: AddonConfig): number {
  return config.groups.reduce((sum, g) => sum + g.accessories.length, 0);
}

/** Per-form group counts, for the dashboard. */
export function formCounts(config: AddonConfig) {
  const counts = { bundle: 0, limited: 0, addon: 0, free: 0 };
  for (const g of config.groups) counts[groupForm(g)] += 1;
  return counts;
}

/** A lightweight, denormalised group row for the dashboard "by bundle / by
 * add-on" lists (stored on BundleConfig so we don't refetch every metafield). */
export type GroupSummary = {
  id: string;
  code: string; // display code, e.g. "LTD-A1B2C3"
  form: GroupForm;
  title: string;
  accessoryCount: number;
  discountPercent: number;
  limited?: { mode: "revert" | "end"; startsAt: string; endsAt: string };
};

export function summarizeConfig(config: AddonConfig): GroupSummary[] {
  return config.groups.map((g) => {
    const row: GroupSummary = {
      id: g.id,
      code: displayCode(g),
      form: groupForm(g),
      title: g.title,
      accessoryCount: g.accessories.length,
      discountPercent: g.discountPercent,
    };
    if (g.limited?.enabled) {
      row.limited = {
        mode: g.limited.mode,
        startsAt: g.limited.startsAt,
        endsAt: g.limited.endsAt,
      };
    }
    return row;
  });
}

export function parseSummaries(json: string | null | undefined): GroupSummary[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function parseAccessories(raw: any): AddonAccessory[] {
  return Array.isArray(raw)
    ? raw
        .filter((a: any) => typeof a?.productId === "string")
        .map((a: any) => {
          const acc: AddonAccessory = {
            productId: a.productId,
            handle: typeof a.handle === "string" ? a.handle : "",
            title: typeof a.title === "string" ? a.title : "",
          };
          // Keep the override only when explicitly set (0 is valid, "" / null = unset).
          if (a.discountPercent != null && a.discountPercent !== "") {
            const n = Number(a.discountPercent);
            if (Number.isFinite(n)) acc.discountPercent = clampPercent(n);
          }
          if (Array.isArray(a.variantIds)) {
            const ids = a.variantIds.filter(
              (x: any) => typeof x === "string" && x,
            );
            if (ids.length) acc.variantIds = ids;
          }
          return acc;
        })
    : [];
}

/** A bundle/add-on accessory's effective % = its override, else the group's. */
export function effectiveAccessoryPercent(
  group: AddonGroup,
  accessory: AddonAccessory,
): number {
  return clampPercent(
    typeof accessory.discountPercent === "number"
      ? accessory.discountPercent
      : group.discountPercent,
  );
}

function parseLimited(raw: any): LimitedOffer | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return {
    enabled: Boolean(raw.enabled),
    discountPercent: clampPercent(raw.discountPercent),
    mode: raw.mode === "end" ? "end" : "revert",
    startsAt: typeof raw.startsAt === "string" ? raw.startsAt : "",
    endsAt: typeof raw.endsAt === "string" ? raw.endsAt : "",
  };
}

/** Parse + defensively normalise a raw metafield JSON string into an AddonConfig. */
export function parseConfig(raw: string | null | undefined): AddonConfig {
  if (!raw) return { ...EMPTY_CONFIG };
  try {
    const data = JSON.parse(raw);
    const groups: AddonGroup[] = Array.isArray(data?.groups)
      ? data.groups.map((g: any) => migrateGroup(g))
      : [];
    return { version: 1, groups };
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

/** Normalise one raw group, migrating the legacy standalone "limited" type. */
function migrateGroup(g: any): AddonGroup {
  const id = typeof g?.id === "string" ? g.id : newGroupId();
  const code = typeof g?.code === "string" && g.code ? g.code : newCode();
  const accessories = parseAccessories(g?.accessories);
  const archived = Boolean(g?.archived);

  // Legacy: a standalone "limited" group becomes a bundle whose NORMAL price is
  // the old fallbackPercent and whose limited deep price is the old discount.
  if (g?.type === "limited") {
    return {
      id,
      code,
      title: typeof g?.title === "string" ? g.title : "Limited bundle",
      type: "bundle",
      discountPercent: clampPercent(g?.fallbackPercent),
      accessories,
      archived,
      offerId:
        typeof g?.offerId === "string" && g.offerId ? g.offerId : newOfferId(),
      limited: {
        enabled: true,
        discountPercent: clampPercent(g?.discountPercent),
        mode: g?.mode === "end" ? "end" : "revert",
        startsAt: typeof g?.startsAt === "string" ? g.startsAt : "",
        endsAt: typeof g?.endsAt === "string" ? g.endsAt : "",
      },
    };
  }

  const type: AddonGroup["type"] =
    g?.type === "bundle" ? "bundle" : g?.type === "free" ? "free" : "addon";

  const group: AddonGroup = {
    id,
    code,
    title: typeof g?.title === "string" ? g.title : "Add-ons",
    type,
    discountPercent: clampPercent(g?.discountPercent),
    accessories,
    archived,
  };

  if (type === "bundle") {
    const limited = parseLimited(g?.limited);
    if (limited) group.limited = limited;
    if (limited?.enabled || (typeof g?.offerId === "string" && g.offerId)) {
      group.offerId =
        typeof g?.offerId === "string" && g.offerId ? g.offerId : newOfferId();
    }
  }

  return group;
}
