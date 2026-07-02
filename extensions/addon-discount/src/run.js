// @ts-check

/**
 * Product-discount Function for the Add-on / Bundle / Free-gift app.
 *
 * Tamper-proof on the discount itself: every percentage and the list of which
 * products are accessories always come from a MAIN product's `custom.addon_config`
 * metafield, never from a client value. Cart line attributes only GROUP a kit.
 *
 * ONE Function powers several automatic-discount nodes:
 *
 *  - The MAIN node (no `discountNode` metafield) handles ADD-ON, FREE gifts, and
 *    BUNDLE prices. A bundle's `discountPercent` is its NORMAL/standing price and
 *    also the "revert" price after a limited offer ends. A bundle whose limited
 *    offer is mode "end" gets NO main-node discount (full price outside the
 *    window). Always on.
 *
 *  - Each LIMITED node carries an `offerId` in its app-reserved metafield and a
 *    native `startsAt`/`endsAt` window, so Shopify only invokes it inside the
 *    window — the deep price is time-gated server-side. The limited node and the
 *    main node are set NOT to combine, so on a limited bundle line the deeper of
 *    {limited deep price, main normal price} wins: inside the window the deep
 *    price; after expiry only the normal price (mode "revert") or nothing (mode
 *    "end") remains. No clock needed in the (stateless) Function.
 *
 * @typedef {import("../generated/api").RunInput} RunInput
 * @typedef {import("../generated/api").FunctionRunResult} FunctionRunResult
 */

/** @type {FunctionRunResult} */
const EMPTY = {
  discountApplicationStrategy: /** @type {any} */ ("ALL"),
  discounts: [],
};

/** Clamp a raw percent into a safe 0–100 number. */
function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/** Numeric tail of a gid, for tolerant variant id comparison. */
function gidTail(id) {
  return String(id ?? "").split("/").pop();
}

/**
 * Does this add-on group apply to the given main variant?
 * No restriction (empty mainVariantIds) = applies to every variant.
 * Mirrors the storefront's show/hide rule so the discount cap can't be
 * inflated by adding a non-participating variant to the cart.
 */
function groupAllowsVariant(group, variantId) {
  const ids = group?.mainVariantIds;
  if (!Array.isArray(ids) || ids.length === 0) return true;
  const tail = gidTail(variantId);
  return ids.some((g) => gidTail(g) === tail);
}

/** Find the bundle group with this group id inside a main's config. */
function findBundleById(config, bid) {
  if (!bid) return null;
  const groups = Array.isArray(config?.groups) ? config.groups : [];
  for (const group of groups) {
    if (group?.archived) continue;
    if (group?.type === "bundle" && group?.id === bid) return group;
  }
  return null;
}

/** Find the bundle group with this offerId inside a main's config. */
function findBundleByOffer(config, offerId) {
  const groups = Array.isArray(config?.groups) ? config.groups : [];
  for (const group of groups) {
    if (group?.archived) continue;
    if (group?.type === "bundle" && group?.offerId === offerId) return group;
  }
  return null;
}

function allPresentUnder(group, present) {
  const accessories = Array.isArray(group?.accessories) ? group.accessories : [];
  return (
    accessories.length > 0 &&
    accessories.every(
      (a) => typeof a?.productId === "string" && present && present.has(a.productId),
    )
  );
}

function groupHasProduct(group, pid) {
  const accessories = Array.isArray(group?.accessories) ? group.accessories : [];
  return accessories.some((a) => a?.productId === pid);
}

/** Effective % for one accessory: its own override, else the group's. */
function accPercent(group, pid) {
  const accessories = Array.isArray(group?.accessories) ? group.accessories : [];
  for (const a of accessories) {
    if (a?.productId === pid) {
      const v = a?.discountPercent;
      return clampPercent(typeof v === "number" ? v : group?.discountPercent);
    }
  }
  return clampPercent(group?.discountPercent);
}

/**
 * @param {RunInput} input
 * @returns {FunctionRunResult}
 */
export function run(input) {
  const lines = input?.cart?.lines ?? [];
  if (lines.length === 0) return EMPTY;

  // 1. Index the cart.
  /** @type {Map<string, number>} */
  const presentQty = new Map();
  /** @type {Map<string, Set<string>>} */
  const presentByGrp = new Map(); // kit instance tag -> product ids present under it
  /** @type {Map<string, any>} */
  const mainConfigByGrp = new Map(); // tag -> backing main's config
  /** @type {Map<string, number>} */
  const mainQtyByGrp = new Map(); // tag -> backing main quantity
  /** @type {Array<{config: any, mainQty: number, variantId: string|undefined}>} */
  const mainLines = [];

  for (const line of lines) {
    const merch = /** @type {any} */ (line?.merchandise);
    const product = merch?.product;
    const pid = product?.id;
    if (typeof pid !== "string") continue;
    const variantId = merch?.id;
    const qty = Number(line?.quantity) || 0;
    presentQty.set(pid, (presentQty.get(pid) ?? 0) + qty);

    const grp = /** @type {any} */ (line)?.cgpGrp?.value;
    if (grp) {
      let set = presentByGrp.get(grp);
      if (!set) {
        set = new Set();
        presentByGrp.set(grp, set);
      }
      set.add(pid);
    }

    // A line only acts as a MAIN (its config drives add-on/free/bundle prices)
    // when it is NOT itself an accessory or a free gift. This matters when an
    // accessory product is ALSO a configured main elsewhere: tagged `_addon_for`
    // here, its own config must not overwrite its bundle main's config for the
    // shared `_cgp_grp`, nor make its own add-ons eligible.
    const isAccessory = !!(/** @type {any} */ (line)?.cgpFor?.value);
    const isFreeGift = !!(/** @type {any} */ (line)?.cgpFree?.value);
    const raw = product?.addonConfig?.value;
    if (raw && !isAccessory && !isFreeGift) {
      let config;
      try {
        config = JSON.parse(raw);
      } catch {
        continue;
      }
      mainLines.push({ config, mainQty: qty, variantId });
      if (grp) {
        mainConfigByGrp.set(grp, config);
        mainQtyByGrp.set(grp, (mainQtyByGrp.get(grp) ?? 0) + qty);
      }
    }
  }

  // ---- GIFT-CAMPAIGN node: a gift, time-gated by the node, given when one of
  // the campaign's trigger products is in the cart. Allowance scales with the
  // qualifying quantity (buy 2 -> 2 free). ----
  const giftRaw = /** @type {any} */ (input)?.discountNode?.giftMeta?.value;
  if (giftRaw) {
    let camp;
    try {
      camp = JSON.parse(giftRaw);
    } catch {
      return EMPTY;
    }
    const campId = camp && camp.id;
    const giftIds = Array.isArray(camp && camp.giftProducts)
      ? camp.giftProducts
      : [];
    const perQ = Number(camp && camp.perQualifying) || 1;
    if (!campId || !giftIds.length) return EMPTY;

    // Qualifying quantity: non-gift lines whose product triggers this campaign.
    let qualifyingQty = 0;
    for (const line of lines) {
      if (/** @type {any} */ (line)?.cgpGift?.value) continue; // skip gift lines
      const trig = /** @type {any} */ (line?.merchandise)?.product?.giftTrigger
        ?.value;
      if (!trig) continue;
      let entries;
      try {
        entries = JSON.parse(trig);
      } catch {
        continue;
      }
      // Each entry is a campaign id string (legacy) or { id, ... } (current).
      const triggersCamp =
        Array.isArray(entries) &&
        entries.some(function (e) {
          return (e && typeof e === "object" ? e.id : e) === campId;
        });
      if (triggersCamp) {
        qualifyingQty += Number(line?.quantity) || 0;
      }
    }
    let allowance = qualifyingQty * perQ;
    if (allowance <= 0) return EMPTY;

    const giftSet = new Set(giftIds.map(gidTail));
    /** @type {FunctionRunResult["discounts"]} */
    const giftDiscounts = [];
    for (const line of lines) {
      if (/** @type {any} */ (line)?.cgpGift?.value !== campId) continue;
      const pid = /** @type {any} */ (line?.merchandise)?.product?.id;
      if (typeof pid !== "string" || !giftSet.has(gidTail(pid))) continue;
      const q = Math.min(Number(line?.quantity) || 0, allowance);
      if (q <= 0) continue;
      allowance -= q;
      giftDiscounts.push({
        message: "🎁 Free gift",
        targets: [{ cartLine: { id: line.id, quantity: q } }],
        value: { percentage: { value: "100.0" } },
      });
    }
    return giftDiscounts.length === 0
      ? EMPTY
      : {
          discountApplicationStrategy: /** @type {any} */ ("ALL"),
          discounts: giftDiscounts,
        };
  }

  // Is this a LIMITED node? Its metafield names the offer it runs for.
  let limitedOfferId = null;
  const offerRaw = /** @type {any} */ (input)?.discountNode?.metafield?.value;
  if (offerRaw) {
    try {
      const parsed = JSON.parse(offerRaw);
      if (parsed && typeof parsed.offerId === "string") {
        limitedOfferId = parsed.offerId;
      }
    } catch {
      // ignore: behave like the main node
    }
  }

  // ---- LIMITED node: deep, time-gated price for this one offer. ----
  if (limitedOfferId) {
    /** @type {FunctionRunResult["discounts"]} */
    const limited = [];
    for (const line of lines) {
      const lo = /** @type {any} */ (line)?.cgpLo?.value;
      if (lo !== limitedOfferId) continue;
      const grp = /** @type {any} */ (line)?.cgpGrp?.value;
      if (!grp) continue;
      const product = /** @type {any} */ (line?.merchandise)?.product;
      const pid = product?.id;
      if (typeof pid !== "string") continue;
      const lineQty = Number(line?.quantity) || 0;
      if (lineQty <= 0) continue;

      const config = mainConfigByGrp.get(grp);
      if (!config) continue; // kit main removed
      const group = findBundleByOffer(config, limitedOfferId);
      if (!group || !group.limited || !group.limited.enabled) continue;
      if (!allPresentUnder(group, presentByGrp.get(grp))) continue;
      // A bundle is one deep discount on the WHOLE kit: the main (no `_addon_for`)
      // always qualifies; an accessory must belong to this group. (Tag-based so a
      // product that is itself a configured main can still be discounted here.)
      const isAcc = !!(/** @type {any} */ (line)?.cgpFor?.value);
      if (isAcc && !groupHasProduct(group, pid)) continue;

      const percent = clampPercent(group.limited.discountPercent);
      if (percent <= 0) continue;
      const cap = mainQtyByGrp.get(grp) ?? 1;
      const qty = Math.min(lineQty, cap);
      if (qty <= 0) continue;
      limited.push({
        message: `Limited offer ${percent}% off`,
        targets: [{ cartLine: { id: line.id, quantity: qty } }],
        value: { percentage: { value: percent.toFixed(1) } },
      });
    }
    return limited.length === 0
      ? EMPTY
      : { discountApplicationStrategy: /** @type {any} */ ("ALL"), discounts: limited };
  }

  // ================= MAIN node from here on =================

  // 2. ADD-ON eligibility (shared main, capped). Each main line contributes its
  //    quantity to the allowance ONCE; bundle/free groups are handled separately.
  /** @type {Map<string, {percent: number, allowance: number}>} */
  const addonEligible = new Map();
  for (const { config, mainQty, variantId } of mainLines) {
    if (mainQty <= 0) continue;
    /** @type {Map<string, number>} */
    const lineBest = new Map();
    const groups = Array.isArray(config?.groups) ? config.groups : [];
    for (const group of groups) {
      if (group?.archived) continue;
      if (group?.type === "bundle" || group?.type === "free") continue;
      // Only count this main toward the cap if its variant participates in the
      // group. Otherwise a hidden-add-on variant (e.g. Kit4) would let extra
      // add-on units sneak in at the discounted price.
      if (!groupAllowsVariant(group, variantId)) continue;
      for (const accessory of group?.accessories ?? []) {
        const apid = accessory?.productId;
        if (typeof apid !== "string") continue;
        if ((presentQty.get(apid) ?? 0) <= 0) continue;
        // Per-accessory override wins; else the group discount.
        const v = accessory?.discountPercent;
        const percent = clampPercent(
          typeof v === "number" ? v : group?.discountPercent,
        );
        if (percent <= 0) continue;
        lineBest.set(apid, Math.max(lineBest.get(apid) ?? 0, percent));
      }
    }
    for (const [apid, percent] of lineBest) {
      const prev = addonEligible.get(apid);
      addonEligible.set(apid, {
        percent: prev ? Math.max(prev.percent, percent) : percent,
        allowance: (prev?.allowance ?? 0) + mainQty,
      });
    }
  }

  // 2b. FREE-gift eligibility: products in a "free" group of a present main.
  //     Hard-capped to ONE free unit per gift product, regardless of main qty.
  /** @type {Map<string, number>} */
  const freeRemaining = new Map();
  for (const { config } of mainLines) {
    for (const group of Array.isArray(config?.groups) ? config.groups : []) {
      if (group?.type !== "free" || group?.archived) continue;
      for (const accessory of group?.accessories ?? []) {
        const apid = accessory?.productId;
        if (typeof apid === "string") freeRemaining.set(apid, 1);
      }
    }
  }

  /** @type {Map<string, number>} */
  const remaining = new Map();
  for (const [apid, e] of addonEligible) remaining.set(apid, e.allowance);

  // 3. Apply.
  /** @type {FunctionRunResult["discounts"]} */
  const discounts = [];

  for (const line of lines) {
    const product = /** @type {any} */ (line?.merchandise)?.product;
    const pid = product?.id;
    if (typeof pid !== "string") continue;

    const lineQty = Number(line?.quantity) || 0;
    if (lineQty <= 0) continue;

    const grp = /** @type {any} */ (line)?.cgpGrp?.value;
    const lo = /** @type {any} */ (line)?.cgpLo?.value;
    const addonFor = /** @type {any} */ (line)?.cgpFor?.value;
    const free = /** @type {any} */ (line)?.cgpFree?.value;
    const bid = /** @type {any} */ (line)?.cgpBid?.value;

    // A MAIN line is normally never discounted. A main is any line NOT tagged as
    // an accessory (`_addon_for`) or a free gift (`_cgp_free`) — the shared
    // add-on main, a bundle's own main, or a plain product. We key off the tags
    // (not the metafield) so a product that is itself a configured main can
    // still be discounted when it appears as someone else's accessory.
    if (!addonFor && !free) {
      // EXCEPTION: a bundle's OWN main. A bundle is one discount on the whole
      // kit, so the main gets the same `discountPercent` as the accessories,
      // gated on the full kit being present (all-or-nothing).
      if (grp && bid) {
        const config = mainConfigByGrp.get(grp);
        const group = findBundleById(config, bid);
        if (group && allPresentUnder(group, presentByGrp.get(grp))) {
          // "end"-mode limited bundle: full price outside the window (the deep
          // price is the time-gated limited node's job); the main node gives 0.
          const endMode =
            group.limited && group.limited.enabled && group.limited.mode === "end";
          const pct = endMode ? 0 : clampPercent(group.discountPercent);
          if (pct > 0) {
            discounts.push({
              message: `Bundle ${pct}% off`,
              targets: [{ cartLine: { id: line.id, quantity: lineQty } }],
              value: { percentage: { value: pct.toFixed(1) } },
            });
          }
        }
      }
      continue;
    }

    if (grp) {
      // BUNDLE accessory (normal bundle, or a limited bundle's NORMAL/revert
      // price). Needs its bundle main present (same tag) and the whole bundle
      // group present under that tag.
      const config = mainConfigByGrp.get(grp);
      if (!config) continue; // bundle main removed -> back to full price
      const present = presentByGrp.get(grp);

      let best = 0;
      if (lo) {
        // Limited bundle line: the main node only ever applies the NORMAL price
        // (per-accessory override, else group), and nothing at all when the
        // offer ends ("end" mode). The deep price is the limited node's job.
        const group = findBundleByOffer(config, lo);
        if (
          group &&
          groupHasProduct(group, pid) &&
          allPresentUnder(group, present)
        ) {
          const endMode = group.limited && group.limited.mode === "end";
          // A bundle is ONE discount on the whole kit: the group %, not any
          // per-accessory override (those are an add-on-only concept).
          best = endMode ? 0 : clampPercent(group.discountPercent);
        }
      } else {
        // Plain bundle line: best matching bundle group by membership, using the
        // single group discount (one price for the whole kit).
        for (const group of config?.groups ?? []) {
          if (group?.type !== "bundle" || group?.archived) continue;
          if (!groupHasProduct(group, pid)) continue;
          if (!allPresentUnder(group, present)) continue;
          const percent = clampPercent(group.discountPercent);
          if (percent > best) best = percent;
        }
      }

      if (best <= 0) continue;
      const cap = mainQtyByGrp.get(grp) ?? 1;
      const qty = Math.min(lineQty, cap);
      if (qty <= 0) continue;
      discounts.push({
        message: `Bundle ${best}% off`,
        targets: [{ cartLine: { id: line.id, quantity: qty } }],
        value: { percentage: { value: best.toFixed(1) } },
      });
    } else if (/** @type {any} */ (line)?.cgpFree?.value) {
      // FREE gift: 100% off, ONE unit max per gift product, only if it's a
      // configured free accessory of a main that's in the cart.
      const rem = freeRemaining.get(pid) ?? 0;
      if (rem <= 0) continue; // not eligible, or the free unit is used up
      freeRemaining.set(pid, rem - 1);
      discounts.push({
        message: "🎁 Free Gift",
        targets: [{ cartLine: { id: line.id, quantity: 1 } }],
        value: { percentage: { value: "100.0" } },
      });
    } else {
      // ADD-ON accessory: only lines added via the add-on flow (`_addon_for`).
      // A plain line — e.g. a bundle item that reverted after its kit broke —
      // stays full price even if its product is also configured as an add-on.
      if (!(/** @type {any} */ (line)?.cgpFor?.value)) continue;
      const e = addonEligible.get(pid);
      if (!e) continue;
      const rem = remaining.get(pid) ?? 0;
      if (rem <= 0) continue;
      const qty = Math.min(lineQty, rem);
      if (qty <= 0) continue;
      remaining.set(pid, rem - qty);
      const capped = clampPercent(e.percent);
      discounts.push({
        message: `Add-on ${capped}% off`,
        targets: [{ cartLine: { id: line.id, quantity: qty } }],
        value: { percentage: { value: capped.toFixed(1) } },
      });
    }
  }

  if (discounts.length === 0) return EMPTY;

  return {
    discountApplicationStrategy: /** @type {any} */ ("ALL"),
    discounts,
  };
}
