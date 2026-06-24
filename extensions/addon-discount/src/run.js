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
  /** @type {Array<{config: any, mainQty: number}>} */
  const mainLines = [];

  for (const line of lines) {
    const product = /** @type {any} */ (line?.merchandise)?.product;
    const pid = product?.id;
    if (typeof pid !== "string") continue;
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

    const raw = product?.addonConfig?.value;
    if (raw) {
      let config;
      try {
        config = JSON.parse(raw);
      } catch {
        continue;
      }
      mainLines.push({ config, mainQty: qty });
      if (grp) {
        mainConfigByGrp.set(grp, config);
        mainQtyByGrp.set(grp, (mainQtyByGrp.get(grp) ?? 0) + qty);
      }
    }
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
      if (product?.addonConfig?.value) continue; // never discount the main
      const lineQty = Number(line?.quantity) || 0;
      if (lineQty <= 0) continue;

      const config = mainConfigByGrp.get(grp);
      if (!config) continue; // kit main removed
      const group = findBundleByOffer(config, limitedOfferId);
      if (!group || !group.limited || !group.limited.enabled) continue;
      if (!groupHasProduct(group, pid)) continue;
      if (!allPresentUnder(group, presentByGrp.get(grp))) continue;

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
  for (const { config, mainQty } of mainLines) {
    if (mainQty <= 0) continue;
    /** @type {Map<string, number>} */
    const lineBest = new Map();
    const groups = Array.isArray(config?.groups) ? config.groups : [];
    for (const group of groups) {
      if (group?.archived) continue;
      if (group?.type === "bundle" || group?.type === "free") continue;
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
    if (product?.addonConfig?.value) continue; // never discount a main product

    const lineQty = Number(line?.quantity) || 0;
    if (lineQty <= 0) continue;

    const grp = /** @type {any} */ (line)?.cgpGrp?.value;
    const lo = /** @type {any} */ (line)?.cgpLo?.value;

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
          best = endMode ? 0 : accPercent(group, pid);
        }
      } else {
        // Plain bundle line: best matching bundle group by membership, using
        // this accessory's effective percent.
        for (const group of config?.groups ?? []) {
          if (group?.type !== "bundle" || group?.archived) continue;
          if (!groupHasProduct(group, pid)) continue;
          if (!allPresentUnder(group, present)) continue;
          const percent = accPercent(group, pid);
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
