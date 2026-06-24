/* Add On & Save — storefront behaviour (Moment-style staged selection).
 *
 * The customer SELECTS extras (they don't add to cart immediately), and a single
 * aggregate CTA adds the main product + everything selected in one go:
 *   - "addon"  group -> one toggleable card per accessory.
 *   - "bundle" group -> ONE named, expandable card whose products are added together.
 *
 * The CTA shows the discounted total ("what you'll pay"); the real discount is
 * applied at checkout by the product-discount Function. After adding, the
 * selection is cleared and the cart drawer opens. */
(function () {
  "use strict";

  var cache = {};

  function fetchProduct(handle) {
    if (cache[handle]) return cache[handle];
    cache[handle] = fetch("/products/" + handle + ".js", {
      headers: { Accept: "application/json" },
    })
      .then(function (r) {
        if (!r.ok) throw 0;
        return r.json();
      })
      .catch(function () {
        return null;
      });
    return cache[handle];
  }

  function money(cents, currency) {
    var amount = (cents || 0) / 100;
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency || "USD",
      }).format(amount);
    } catch (e) {
      return "$" + amount.toFixed(2);
    }
  }

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function discounted(cents, percent) {
    var p = Math.min(100, Math.max(0, Number(percent) || 0));
    return Math.round(cents * (1 - p / 100));
  }

  // A storefront product's id is numeric; config accessory ids are gids.
  function gidTail(id) {
    return String(id).split("/").pop();
  }

  function firstAvailableIn(list) {
    return (
      list.filter(function (v) {
        return v.available;
      })[0] || list[0]
    );
  }

  // Which variants this accessory offers the customer. Empty config = all.
  function offeredVariants(group, data) {
    var accs = (group && group.accessories) || [];
    var want = String(data.id);
    var cfg = null;
    for (var i = 0; i < accs.length; i++) {
      if (gidTail(accs[i].productId) === want) {
        cfg = accs[i];
        break;
      }
    }
    var all = data.variants || [];
    if (cfg && Array.isArray(cfg.variantIds) && cfg.variantIds.length) {
      var allow = {};
      cfg.variantIds.forEach(function (g) {
        allow[gidTail(g)] = true;
      });
      var filtered = all.filter(function (v) {
        return allow[String(v.id)];
      });
      if (filtered.length) return filtered;
    }
    return all;
  }

  // Effective % for one accessory in a group: its own override, else the group.
  function accPercentFor(group, productId) {
    var accs = (group && group.accessories) || [];
    var want = String(productId);
    for (var i = 0; i < accs.length; i++) {
      if (gidTail(accs[i].productId) === want) {
        var v = accs[i].discountPercent;
        return typeof v === "number" ? v : Number(group.discountPercent) || 0;
      }
    }
    return Number(group.discountPercent) || 0;
  }

  // /products/x.js returns `options` as strings (older) or {name,values} (current).
  function optionName(opt) {
    return typeof opt === "string" ? opt : (opt && opt.name) || "";
  }

  function hasVariants(data) {
    if (!data || !data.variants) return false;
    if (data.variants.length > 1) return true;
    var name = optionName((data.options || [])[0]);
    return name && name !== "Title";
  }

  function firstAvailable(data) {
    return (
      data.variants.filter(function (v) {
        return v.available;
      })[0] || data.variants[0]
    );
  }

  function optionValues(data, idx) {
    var seen = {},
      out = [];
    data.variants.forEach(function (v) {
      var val = v.options[idx];
      if (val != null && !seen[val]) {
        seen[val] = true;
        out.push(val);
      }
    });
    return out;
  }

  function readMainVariantId() {
    var input = document.querySelector(
      'form[action*="/cart/add"] [name="id"]:not([disabled])',
    );
    if (input && input.value) return input.value;
    var url = new URL(window.location.href);
    if (url.searchParams.get("variant")) return url.searchParams.get("variant");
    try {
      return (
        window.ShopifyAnalytics.meta.selectedVariantId ||
        window.ShopifyAnalytics.meta.product.variants[0].id
      );
    } catch (e) {
      return null;
    }
  }

  function init(root) {
    if (root.__cgpInit) return;
    root.__cgpInit = true;

    var node = root.querySelector("[data-cgp-config]");
    if (!node) return;
    var config;
    try {
      config = JSON.parse(node.textContent);
    } catch (e) {
      return;
    }
    var groups = (config && config.groups) || [];

    var ctx = {
      root: root,
      currency: root.getAttribute("data-currency") || "USD",
      mainHandle: root.getAttribute("data-product-handle") || "",
      mainProductId: (root.getAttribute("data-product-id") || "").split("/").pop(),
      showStrike: root.getAttribute("data-show-strikethrough") !== "false",
      modal: document.querySelector("[data-cgp-modal]"),
      cta: root.querySelector("[data-cgp-cta]"),
      summaryEl: root.querySelector("[data-cgp-summary]"),
      counterEl: root.querySelector("[data-cgp-counter]"),
      extras: new Map(), // key -> { kind, percent, items: [{id, price}] }
      freeItems: [], // { productId, title, current() } auto-added free gifts
      resetFns: [], // visual de-selectors, run after a successful add
      bundlePaints: [], // re-render hooks, run once the main product loads
      mainData: null,
      mainInCart: false, // whether the main product is already in the cart
    };
    ctx.onChange = function () {
      updateCTA(ctx);
      updateCounter(ctx);
    };

    // Load the main product so bundles can show its thumbnail + total price.
    fetchProduct(ctx.mainHandle).then(function (d) {
      ctx.mainData = d;
      ctx.bundlePaints.forEach(function (fn) {
        try {
          fn();
        } catch (e) {}
      });
      updateCTA(ctx);
    });
    // Know whether the main is already in the cart, so the CTA counts honestly.
    refreshMainInCart(ctx);

    // Archived groups are soft-deleted: never render or discount them.
    var live = groups.filter(function (g) {
      return g && !g.archived;
    });
    var bundleGroups = live.filter(function (g) {
      return g.type === "bundle";
    });
    var freeGroups = live.filter(function (g) {
      return g.type === "free";
    });
    var addonGroups = live.filter(function (g) {
      return g.type !== "bundle" && g.type !== "free";
    });

    // Reset this main's free-gift requirements (used by the locked-restore).
    freeReqs = freeReqs.filter(function (r) {
      return r.mainId !== ctx.mainProductId;
    });

    renderBundles(ctx, bundleGroups, root);
    renderFree(ctx, freeGroups, root);
    renderAddons(ctx, addonGroups, root);
    setupModal(ctx.modal);
    setupCTA(ctx);
    updateCTA(ctx);

    // Keep bundle tags + free gifts honest: run now and after every cart change.
    installCartWatcher();
    reconcileBundles();

    var loading = root.querySelector("[data-cgp-loading]");
    if (loading) loading.style.display = "none";
  }

  /* ---------- Selection totals + CTA ---------- */

  function mainVariant(ctx) {
    var id = readMainVariantId();
    var d = ctx.mainData;
    if (d && d.variants) {
      var v =
        d.variants.filter(function (x) {
          return String(x.id) === String(id);
        })[0] || d.variants[0];
      return { id: v ? v.id : id, price: v ? v.price : d.price || 0 };
    }
    return { id: id, price: 0 };
  }

  function extrasCount(ctx) {
    var n = 0;
    ctx.extras.forEach(function (e) {
      n += e.items.length;
    });
    return n;
  }

  function itemPct(e, it) {
    return it.percent != null ? it.percent : e.percent;
  }

  function extrasTotal(ctx) {
    var t = 0;
    ctx.extras.forEach(function (e) {
      e.items.forEach(function (it) {
        t += discounted(it.price, itemPct(e, it));
      });
    });
    return t;
  }

  // Decide how many MAIN products and which accessory items an add should
  // include, given whether a main is already in the cart:
  //   - each BUNDLE is a complete kit and always brings its own main;
  //   - ADD-ONS share a single main (added only if none is present/added).
  function buildPlan(ctx, mainInCart) {
    // A bundle carries `offerId` only when its limited offer is live, so commit
    // tags it `_cgp_lo` and the time-gated node governs its deep price.
    var bundles = []; // [{ name, percent, offerId, items: [{id, price}] }]
    var addonItems = [];
    ctx.extras.forEach(function (e) {
      if (e.kind === "bundle") {
        bundles.push({
          name: e.title || "Bundle",
          percent: e.percent,
          offerId: e.offerId || null,
          items: e.items.map(function (it) {
            return { id: it.id, price: it.price, percent: itemPct(e, it) };
          }),
        });
      } else {
        e.items.forEach(function (it) {
          addonItems.push({
            id: it.id,
            price: it.price,
            percent: itemPct(e, it),
          });
        });
      }
    });
    // Add-ons share one main; a bundle kit's main covers them too. Add a shared
    // main only when add-ons are selected, none is in the cart, and no bundle
    // (whose main would satisfy them) is being added.
    var mainsForAddons =
      addonItems.length > 0 && !mainInCart && bundles.length === 0 ? 1 : 0;
    if (bundles.length === 0 && addonItems.length === 0) {
      mainsForAddons = 1; // bare "add to cart" -> add a main
    }
    return {
      bundles: bundles,
      addonItems: addonItems,
      mainsForAddons: mainsForAddons,
    };
  }

  function updateCTA(ctx) {
    var cta = ctx.cta;
    if (!cta) return;
    cta.hidden = false;
    var mv = mainVariant(ctx);
    var plan = buildPlan(ctx, ctx.mainInCart);
    var mains = plan.mainsForAddons + plan.bundles.length;
    var count = mains;
    var total = mains * (mv.price || 0);
    plan.addonItems.forEach(function (it) {
      count += 1;
      total += discounted(it.price, it.percent);
    });
    plan.bundles.forEach(function (b) {
      b.items.forEach(function (it) {
        count += 1;
        total += discounted(it.price, it.percent);
      });
    });
    // Free gifts always ride along (count them, $0 to the total).
    count += ctx.freeItems.length;

    // Total summary lives ABOVE the button; the button label stays static so it
    // can carry Pre-Order / Sold-out states without us overwriting it.
    if (ctx.summaryEl) {
      ctx.summaryEl.innerHTML = "";
      if (count > 0) {
        ctx.summaryEl.hidden = false;
        ctx.summaryEl.appendChild(
          el(
            "span",
            "cgp-total__count",
            count + (count > 1 ? " items" : " item"),
          ),
        );
        ctx.summaryEl.appendChild(
          el("span", "cgp-total__price", money(total, ctx.currency)),
        );
      } else {
        ctx.summaryEl.hidden = true;
      }
    }
    if (!cta.classList.contains("is-done") && !cta.classList.contains("is-loading")) {
      cta.textContent = "Add to cart";
    }
  }

  function refreshMainInCart(ctx) {
    return fetch("/cart.js", { headers: { Accept: "application/json" } })
      .then(function (r) {
        return r.json();
      })
      .then(function (cart) {
        ctx.mainInCart = (cart.items || []).some(function (it) {
          return String(it.product_id) === ctx.mainProductId;
        });
        updateCTA(ctx);
      })
      .catch(function () {});
  }

  function updateCounter(ctx) {
    if (!ctx.counterEl) return;
    var n = 0,
      total = 0;
    ctx.extras.forEach(function (e) {
      if (e.kind !== "addon") return;
      e.items.forEach(function (it) {
        n++;
        total += discounted(it.price, itemPct(e, it));
      });
    });
    ctx.counterEl.innerHTML = "";
    if (n > 0) {
      ctx.counterEl.appendChild(
        el(
          "span",
          "cgp-addon__counter-n",
          "+" + n + " ADD-ON" + (n > 1 ? "S" : ""),
        ),
      );
      ctx.counterEl.appendChild(
        el("span", "cgp-addon__counter-price", money(total, ctx.currency)),
      );
    }
  }

  /* ---------- ADD-ON groups: tabbed grid of toggle cards ---------- */

  function renderAddons(ctx, groups, root) {
    var wrap = root.querySelector("[data-cgp-addons]");
    if (!groups.length) {
      if (wrap) wrap.hidden = true;
      return;
    }
    wrap.hidden = false;

    var tabsEl = wrap.querySelector("[data-cgp-tabs]");
    var gridEl = wrap.querySelector("[data-cgp-grid]");
    ctx.gridEl = gridEl;

    if (groups.length > 1) {
      groups.forEach(function (group, i) {
        var tab = el("button", "cgp-tab", group.title || "Add-ons");
        tab.type = "button";
        if (i === 0) tab.classList.add("is-active");
        tab.addEventListener("click", function () {
          tabsEl.querySelectorAll(".cgp-tab").forEach(function (t) {
            t.classList.remove("is-active");
          });
          tab.classList.add("is-active");
          renderGroup(ctx, group);
        });
        tabsEl.appendChild(tab);
      });
    } else {
      tabsEl.style.display = "none";
    }
    renderGroup(ctx, groups[0]);
  }

  function renderGroup(ctx, group) {
    var grid = ctx.gridEl;
    grid.innerHTML = "";
    var rowsWrap = el("div", "cgp-addon__rows");
    grid.appendChild(rowsWrap);
    var nav = el("div", "cgp-addon__nav");
    grid.appendChild(nav);

    Promise.all(
      (group.accessories || []).map(function (a) {
        return fetchProduct(a.handle);
      }),
    ).then(function (datas) {
      var rows = [];
      datas.forEach(function (data) {
        if (!data) return;
        var row = renderRow(ctx, group, data);
        rowsWrap.appendChild(row);
        rows.push(row);
      });
      // Show 3 rows at a time; prev/next paging when there are more.
      var per = 3;
      var pages = Math.ceil(rows.length / per);
      var page = 0;
      function show() {
        rows.forEach(function (r, i) {
          r.style.display =
            i >= page * per && i < (page + 1) * per ? "" : "none";
        });
      }
      if (rows.length > per) {
        var ind = el("span", "cgp-addon__navind", "");
        var prev = el("button", "cgp-addon__navbtn", "‹");
        prev.type = "button";
        var next = el("button", "cgp-addon__navbtn", "›");
        next.type = "button";
        function upd() {
          ind.textContent = page + 1 + " / " + pages;
          prev.disabled = page <= 0;
          next.disabled = page >= pages - 1;
          show();
        }
        prev.addEventListener("click", function () {
          if (page > 0) {
            page--;
            upd();
          }
        });
        next.addEventListener("click", function () {
          if (page < pages - 1) {
            page++;
            upd();
          }
        });
        nav.appendChild(ind);
        nav.appendChild(prev);
        nav.appendChild(next);
        upd();
      } else {
        show();
      }
    });
  }

  // One add-on per row: image (link) + title (link) + inline variant picker +
  // price/discount + round selector. If >1 variant is offered the customer must
  // pick one before the row can be added.
  function renderRow(ctx, group, data) {
    var percent = accPercentFor(group, data.id);
    var offered = offeredVariants(group, data);
    var multi = offered.length > 1;
    var key = "addon:" + data.id;
    var selected = false;
    var chosen = multi ? null : firstAvailableIn(offered);

    var existing = ctx.extras.get(key);
    if (existing && existing.items && existing.items[0]) {
      var ev = offered.filter(function (v) {
        return String(v.id) === String(existing.items[0].id);
      })[0];
      if (ev) {
        chosen = ev;
        selected = true;
      }
    }

    var row = el("div", "cgp-addon__rowcard");
    var link = data.handle ? "/products/" + data.handle : null;

    var media = el(link ? "a" : "div", "cgp-addon__row-media");
    if (link) media.href = link;
    var img = data.featured_image || (data.images && data.images[0]);
    if (img) {
      var image = el("img");
      image.src = img;
      image.alt = data.title;
      image.loading = "lazy";
      media.appendChild(image);
    }
    row.appendChild(media);

    var info = el("div", "cgp-addon__row-info");
    var nameEl = el(link ? "a" : "div", "cgp-addon__row-name", data.title);
    if (link) nameEl.href = link;
    info.appendChild(nameEl);
    var price = el("div", "cgp-addon__row-price");
    info.appendChild(price);

    var sel = null;
    if (multi) {
      sel = el("select", "cgp-addon__variant");
      var ph = el("option", null, "Choose an option…");
      ph.value = "";
      sel.appendChild(ph);
      offered.forEach(function (v) {
        var o = el("option", null, v.title + (v.available ? "" : " — sold out"));
        o.value = v.id;
        if (!v.available) o.disabled = true;
        sel.appendChild(o);
      });
      sel.value = chosen ? String(chosen.id) : "";
      sel.addEventListener("click", function (e) {
        e.stopPropagation();
      });
      sel.addEventListener("change", function (e) {
        e.stopPropagation();
        chosen =
          offered.filter(function (x) {
            return String(x.id) === sel.value;
          })[0] || null;
        sel.classList.remove("cgp-needs-choice");
        renderPrice();
        if (selected) {
          if (chosen) store();
          else setSelected(false);
        }
      });
      info.appendChild(sel);
    }
    row.appendChild(info);

    var toggle = el("span", "cgp-check" + (selected ? " is-on" : ""), selected ? "✓" : "");
    toggle.setAttribute("role", "button");
    toggle.setAttribute("aria-label", "Add " + data.title);
    row.appendChild(toggle);

    function renderPrice() {
      var base = (chosen || offered[0] || data).price || 0;
      price.innerHTML = "";
      price.appendChild(
        el(
          "span",
          "cgp-card__now",
          "+" + money(discounted(base, percent), ctx.currency),
        ),
      );
      if (percent > 0 && ctx.showStrike) {
        price.appendChild(el("span", "cgp-card__was", money(base, ctx.currency)));
        price.appendChild(el("span", "cgp-card__off", "-" + percent + "%"));
      }
    }

    function store() {
      var v = chosen || (!multi ? offered[0] : null);
      if (!v) return;
      ctx.extras.set(key, {
        kind: "addon",
        percent: percent,
        items: [{ id: v.id, price: v.price }],
      });
    }

    function setSelected(on) {
      selected = on;
      row.classList.toggle("is-selected", on);
      toggle.textContent = on ? "✓" : "";
      toggle.classList.toggle("is-on", on);
      if (on) store();
      else ctx.extras.delete(key);
      ctx.onChange();
    }
    ctx.resetFns.push(function () {
      selected = false;
      row.classList.remove("is-selected");
      toggle.textContent = "";
      toggle.classList.remove("is-on");
      if (sel) {
        chosen = null;
        sel.value = "";
        renderPrice();
      }
    });

    function activate() {
      if (selected) {
        setSelected(false);
        return;
      }
      if (multi && !chosen) {
        // Must pick a variant first.
        if (sel) {
          sel.classList.add("cgp-needs-choice");
          try {
            sel.focus();
          } catch (e) {}
        }
        return;
      }
      setSelected(true);
    }
    toggle.addEventListener("click", function (e) {
      e.stopPropagation();
      activate();
    });

    renderPrice();
    return row;
  }

  function variantLabel(data, variant) {
    if (!variant) return "";
    var t = variant.title || "";
    return t === "Default Title" ? "" : t;
  }

  /* ---------- Variant-picker modal (returns a variant via onChoose) ---------- */

  function setupModal(modal) {
    if (!modal || modal.__cgpReady) return;
    modal.__cgpReady = true;
    modal.querySelectorAll("[data-cgp-modal-close]").forEach(function (n) {
      n.addEventListener("click", function () {
        modal.hidden = true;
      });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") modal.hidden = true;
    });
  }

  function openModal(ctx, data, percent, onChoose) {
    var modal = ctx.modal;
    if (!modal) return;
    var body = modal.querySelector("[data-cgp-modal-body]");
    body.innerHTML = "";
    body.appendChild(el("div", "cgp-modal__title", data.title));

    var rows = [];
    (data.options || []).forEach(function (opt, idx) {
      var field = el("div", "cgp-modal__option");
      field.appendChild(el("div", "cgp-modal__option-label", optionName(opt)));
      var row = el("div", "cgp-modal__values");
      optionValues(data, idx).forEach(function (value, vi) {
        var b = el("button", "cgp-chip", value);
        b.type = "button";
        if (vi === 0) b.classList.add("is-active");
        b.addEventListener("click", function () {
          row.querySelectorAll(".cgp-chip").forEach(function (c) {
            c.classList.remove("is-active");
          });
          b.classList.add("is-active");
          updatePrice();
        });
        row.appendChild(b);
      });
      field.appendChild(row);
      body.appendChild(field);
      rows.push(row);
    });

    var priceLine = el("div", "cgp-modal__price");
    body.appendChild(priceLine);
    var confirm = el("button", "cgp-modal__confirm", "Add to selection");
    confirm.type = "button";
    body.appendChild(confirm);

    function selected() {
      var chosen = rows.map(function (row) {
        var a = row.querySelector(".cgp-chip.is-active");
        return a ? a.textContent : null;
      });
      return data.variants.filter(function (v) {
        return chosen.every(function (val, i) {
          return val == null || v.options[i] === val;
        });
      })[0];
    }

    function updatePrice() {
      var v = selected();
      var cents = v ? v.price : data.price;
      priceLine.innerHTML = "";
      priceLine.appendChild(
        el(
          "span",
          "cgp-modal__now",
          money(discounted(cents, percent), ctx.currency),
        ),
      );
      if (percent > 0 && ctx.showStrike) {
        priceLine.appendChild(
          el("span", "cgp-modal__was", money(cents, ctx.currency)),
        );
      }
      confirm.disabled = !v || !v.available;
      confirm.textContent = v && !v.available ? "Sold out" : "Add to selection";
    }

    confirm.addEventListener("click", function () {
      var v = selected();
      if (!v) return;
      modal.hidden = true;
      onChoose(v);
    });

    updatePrice();
    modal.hidden = false;
  }

  /* ---------- BUNDLE groups: one named, expandable, selectable card ---------- */

  function renderBundles(ctx, groups, root) {
    var wrap = root.querySelector("[data-cgp-bundles]");
    var list = root.querySelector("[data-cgp-bundle-list]");
    if (!wrap || !list || !groups.length) return;
    wrap.hidden = false;
    groups.forEach(function (group) {
      var card = el("div", "cgp-bundle");
      card.appendChild(el("div", "cgp-bundle__skeleton"));
      list.appendChild(card);
      renderBundle(ctx, card, group);
    });
  }

  function renderBundle(ctx, card, group) {
    var key = "bundle:" + (group.id || group.title);
    var hasLimited = !!(group.limited && group.limited.enabled);

    Promise.all(
      (group.accessories || []).map(function (a) {
        return fetchProduct(a.handle);
      }),
    ).then(function (products) {
      products = products.filter(Boolean);
      if (!products.length) return card.remove();

      var selected = false;
      var timer = null;
      // Customer's chosen variant per accessory (numeric product id -> variant).
      // Lives outside paint so choices survive re-renders.
      var chosenVars = {};

      function offeredFor(p) {
        return offeredVariants(group, p);
      }
      // The chosen variant for an accessory: auto when only one is offered,
      // else whatever the customer picked (null until they pick).
      function chosenVarFor(p) {
        var off = offeredFor(p);
        if (off.length <= 1) return off[0];
        return chosenVars[gidTail(p.id)] || null;
      }
      function bundleReady() {
        return products.every(function (p) {
          return !!chosenVarFor(p);
        });
      }

      // Per-item percent for the current state:
      //  - limited active/upcoming -> uniform deep limited.discountPercent
      //  - limited ended + "end"   -> 0 (card is hidden anyway)
      //  - otherwise (normal / revert) -> each accessory's own % (else group %)
      function itemPercentFor(p, state) {
        if (hasLimited && (state === "active" || state === "upcoming")) {
          return Number(group.limited.discountPercent) || 0;
        }
        if (hasLimited && state === "ended" && group.limited.mode !== "revert") {
          return 0;
        }
        return accPercentFor(group, p.id);
      }
      // Tag `_cgp_lo` only while the offer is actually live, so the time-gated
      // node governs the price; after expiry the main node takes over.
      function offerIdFor(state) {
        return hasLimited && state === "active" ? group.offerId || null : null;
      }

      function storeSelection(state, offerId) {
        ctx.extras.set(key, {
          kind: "bundle",
          percent: 0, // each item carries its own percent
          offerId: offerId || null,
          title: group.title || "Bundle",
          items: products.map(function (p) {
            var v = chosenVarFor(p) || firstAvailableIn(offeredFor(p));
            return {
              id: v.id,
              price: v.price,
              percent: itemPercentFor(p, state),
            };
          }),
        });
      }

      function setSelected(on, state, offerId) {
        selected = on;
        card.classList.toggle("is-selected", on);
        var check = card.querySelector(".cgp-check");
        if (check) {
          check.textContent = on ? "✓" : "";
          check.classList.toggle("is-on", on);
        }
        if (on) storeSelection(state, offerId);
        else ctx.extras.delete(key);
        ctx.onChange();
      }

      ctx.resetFns.push(function () {
        selected = false;
        card.classList.remove("is-selected");
        var check = card.querySelector(".cgp-check");
        if (check) {
          check.textContent = "";
          check.classList.remove("is-on");
        }
      });

      function paint() {
        var state = hasLimited ? offerState(group) : "active";
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        // A finished "end"-mode offer is over: drop the bundle entirely.
        if (hasLimited && state === "ended" && group.limited.mode !== "revert") {
          if (selected) setSelected(false);
          card.remove();
          return;
        }
        var live = hasLimited && (state === "active" || state === "upcoming");
        card.classList.toggle("cgp-limited", live);
        card.innerHTML = "";

        var accNow = 0,
          accWas = 0;
        products.forEach(function (p) {
          accWas += p.price;
          accNow += discounted(p.price, itemPercentFor(p, state));
        });
        // The bundle shows its WHOLE total (main full price + accessories);
        // only accessories are discounted, so the saving is the accessory saving.
        var mainPrice = mainVariant(ctx).price || 0;
        var totalNow = mainPrice + accNow;
        var totalWas = mainPrice + accWas;
        var saved = accWas - accNow;
        var hasSaving = saved > 0;

        // HEAD (selectable): name (+ inline countdown badge) / one-line price /
        // thumbnails + "View more" on the right, with the selector on the far right.
        var head = el("div", "cgp-bundle__head");
        var mainCol = el("div", "cgp-bundle__main");

        var nameLine = el("div", "cgp-bundle__nameline");
        nameLine.appendChild(
          el("span", "cgp-bundle__name", group.title || "Bundle"),
        );
        // Inline countdown badge next to the name (instead of a full-width bar).
        var cdSpan = null;
        var cdTarget = null;
        if (live && state === "active" && group.limited.endsAt) {
          var bd = el("span", "cgp-bundle__timerbadge");
          bd.appendChild(el("span", "cgp-bundle__timericon", "Ends in"));
          cdSpan = el("span", "cgp-bundle__timerclock", "");
          bd.appendChild(cdSpan);
          nameLine.appendChild(bd);
          cdTarget = group.limited.endsAt;
        } else if (live && state === "upcoming" && group.limited.startsAt) {
          var bd2 = el(
            "span",
            "cgp-bundle__timerbadge cgp-bundle__timerbadge--soon",
          );
          bd2.appendChild(el("span", "cgp-bundle__timericon", "Starts in"));
          cdSpan = el("span", "cgp-bundle__timerclock", "");
          bd2.appendChild(cdSpan);
          nameLine.appendChild(bd2);
          cdTarget = group.limited.startsAt;
        }
        mainCol.appendChild(nameLine);
        if (cdSpan) timer = startCountdown(cdSpan, Date.parse(cdTarget), paint);

        var pr = el("div", "cgp-bundle__price");
        pr.appendChild(
          el("span", "cgp-bundle__now", money(totalNow, ctx.currency)),
        );
        if (hasSaving && ctx.showStrike) {
          pr.appendChild(el("span", "cgp-bundle__was", money(totalWas, ctx.currency)));
        }
        if (hasSaving) {
          pr.appendChild(
            el("span", "cgp-bundle__save", "Save " + money(saved, ctx.currency)),
          );
          var offPct = totalWas > 0 ? Math.round((saved / totalWas) * 100) : 0;
          pr.appendChild(el("span", "cgp-bundle__off", offPct + "% OFF"));
        }
        mainCol.appendChild(pr);

        // Thumbnails (main + accessories) on the left, "View more" on the right.
        var thumbsRow = el("div", "cgp-bundle__thumbsrow");
        var thumbs = el("div", "cgp-bundle__thumbs");
        [ctx.mainData]
          .concat(products)
          .forEach(function (p) {
            if (!p) return;
            var t = el("span", "cgp-bundle__thumb-sm");
            var img = p.featured_image || (p.images && p.images[0]);
            if (img) {
              var im = el("img");
              im.src = img;
              im.alt = p.title || "";
              im.loading = "lazy";
              t.appendChild(im);
            }
            // Clicking any thumbnail opens the detail (without selecting).
            t.addEventListener("click", function (e) {
              e.stopPropagation();
              setExpanded(true);
            });
            thumbs.appendChild(t);
          });
        thumbsRow.appendChild(thumbs);
        var toggleLine = el("button", "cgp-bundle__expand", "View more ▾");
        toggleLine.type = "button";
        thumbsRow.appendChild(toggleLine);
        mainCol.appendChild(thumbsRow);
        head.appendChild(mainCol);

        var aside = el("div", "cgp-bundle__aside");
        aside.appendChild(
          el("span", "cgp-check" + (selected ? " is-on" : ""), selected ? "✓" : ""),
        );
        head.appendChild(aside);
        card.appendChild(head);

        var listEl = el("div", "cgp-bundle__contents");
        listEl.hidden = true;
        card.appendChild(listEl);
        // Build the detail list, embedding a variant <select> for any accessory
        // that offers more than one variant.
        function buildContents() {
          listEl.innerHTML = "";
          if (ctx.mainData) {
            listEl.appendChild(
              contentRow(ctx, ctx.mainData, 0, "Your product", true, null),
            );
          }
          products.forEach(function (p) {
            var off = offeredFor(p);
            var sel = null;
            if (off.length > 1) {
              sel = el("select", "cgp-bundle__variant");
              var ph = el("option", null, "Choose an option…");
              ph.value = "";
              sel.appendChild(ph);
              off.forEach(function (v) {
                var o = el(
                  "option",
                  null,
                  v.title + (v.available ? "" : " — sold out"),
                );
                o.value = v.id;
                if (!v.available) o.disabled = true;
                sel.appendChild(o);
              });
              var cur = chosenVars[gidTail(p.id)];
              sel.value = cur ? String(cur.id) : "";
              sel.addEventListener("change", function () {
                chosenVars[gidTail(p.id)] =
                  off.filter(function (x) {
                    return String(x.id) === sel.value;
                  })[0] || null;
                sel.classList.remove("cgp-needs-choice");
                if (selected) {
                  if (bundleReady()) storeSelection(state, offerIdFor(state));
                  else setSelected(false, state, offerIdFor(state));
                }
              });
            }
            listEl.appendChild(
              contentRow(ctx, p, itemPercentFor(p, state), null, false, sel),
            );
          });
        }

        function setExpanded(open) {
          listEl.hidden = !open;
          thumbs.hidden = open;
          if (open && !listEl.childNodes.length) buildContents();
          toggleLine.textContent = open ? "Hide ▴" : "View more ▾";
        }
        toggleLine.addEventListener("click", function (e) {
          e.stopPropagation();
          setExpanded(listEl.hidden);
        });

        if (state === "upcoming") {
          // Not buyable yet — the deep price only applies once it starts.
          card.classList.add("is-disabled");
          if (selected) setSelected(false);
        } else {
          card.classList.remove("is-disabled");
          head.addEventListener("click", function () {
            if (selected) {
              setSelected(false, state, offerIdFor(state));
              return;
            }
            // Force variant choices first: open the detail + flag empty pickers.
            if (!bundleReady()) {
              setExpanded(true);
              listEl.querySelectorAll("select").forEach(function (s) {
                if (!s.value) s.classList.add("cgp-needs-choice");
              });
              return;
            }
            setSelected(true, state, offerIdFor(state));
          });
          // Keep a live selection's price/offer in sync across a transition.
          if (selected) storeSelection(state, offerIdFor(state));
        }
        ctx.onChange();
      }

      paint();
      // Re-render once the main product loads (for its thumbnail + total price).
      ctx.bundlePaints.push(paint);
    });
  }

  function contentRow(ctx, data, percent, tag, isMain, sel) {
    var row = el("div", "cgp-bundle__content-row");
    var link = !isMain && data.handle ? "/products/" + data.handle : null;
    var thumb = el(link ? "a" : "div", "cgp-bundle__content-thumb");
    if (link) thumb.href = link;
    var img = data.featured_image || (data.images && data.images[0]);
    if (img) {
      var im = el("img");
      im.src = img;
      im.alt = data.title;
      im.loading = "lazy";
      thumb.appendChild(im);
    }
    row.appendChild(thumb);
    var info = el("div", "cgp-bundle__content-info");
    var nameLine = el("div", "cgp-bundle__content-nameline");
    var nameEl = el(link ? "a" : "div", "cgp-bundle__content-name", data.title);
    if (link) nameEl.href = link;
    nameLine.appendChild(nameEl);
    if (tag) nameLine.appendChild(el("span", "cgp-bundle__content-tag", tag));
    info.appendChild(nameLine);
    if (sel) info.appendChild(sel); // variant picker
    row.appendChild(info);
    var p = el("div", "cgp-bundle__content-price");
    p.appendChild(
      el(
        "span",
        "cgp-bundle__now",
        money(discounted(data.price, percent), ctx.currency),
      ),
    );
    if (percent > 0 && ctx.showStrike) {
      p.appendChild(el("span", "cgp-bundle__was", money(data.price, ctx.currency)));
    }
    row.appendChild(p);
    return row;
  }

  /* ---------- Limited-offer helpers (countdown; bundles only) ---------- */

  // Authoritative time gate lives on the discount node; this is display only.
  function offerState(group) {
    var lim = group.limited || {};
    var now = Date.now();
    var s = lim.startsAt ? Date.parse(lim.startsAt) : NaN;
    var e = lim.endsAt ? Date.parse(lim.endsAt) : NaN;
    if (!isNaN(e) && now >= e) return "ended";
    if (!isNaN(s) && now < s) return "upcoming";
    return "active";
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function fmtRemaining(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400);
    s -= d * 86400;
    var h = Math.floor(s / 3600);
    s -= h * 3600;
    var m = Math.floor(s / 60);
    s -= m * 60;
    return (d > 0 ? d + "d " : "") + pad2(h) + ":" + pad2(m) + ":" + pad2(s);
  }

  function startCountdown(node, target, onExpire) {
    var timer;
    function tick() {
      var rem = target - Date.now();
      node.textContent = fmtRemaining(rem);
      if (rem <= 0) {
        clearInterval(timer);
        if (onExpire) onExpire();
      }
    }
    tick();
    timer = setInterval(tick, 1000);
    return timer;
  }

  /* ---------- FREE gift: auto-added, locked, 100% off ---------- */

  // Requirements used by the locked-restore in reconcile: each entry knows the
  // main it belongs to and the gift's current variant.
  var freeReqs = [];

  function renderFree(ctx, groups, root) {
    var wrap = root.querySelector("[data-cgp-free]");
    if (!wrap || !groups.length) return;
    wrap.hidden = false;
    groups.forEach(function (group) {
      var section = el("div", "cgp-free");
      section.appendChild(
        el("h2", "cgp-free__heading", group.title || "🎁 Free gift"),
      );
      var list = el("div", "cgp-free__list");
      section.appendChild(list);
      wrap.appendChild(section);
      (group.accessories || []).forEach(function (accessory) {
        var row = el("div", "cgp-free__row");
        row.appendChild(el("div", "cgp-free__skeleton"));
        list.appendChild(row);
        fetchProduct(accessory.handle).then(function (data) {
          if (!data) return row.remove();
          renderFreeItem(ctx, row, group, data);
        });
      });
    });
  }

  function renderFreeItem(ctx, row, group, data) {
    row.innerHTML = "";
    var offered = offeredVariants(group, data);
    var chosen = firstAvailableIn(offered);
    var link = data.handle ? "/products/" + data.handle : null;

    var thumb = el(link ? "a" : "div", "cgp-free__thumb");
    if (link) thumb.href = link;
    var img = data.featured_image || (data.images && data.images[0]);
    if (img) {
      var im = el("img");
      im.src = img;
      im.alt = data.title;
      im.loading = "lazy";
      thumb.appendChild(im);
    }
    row.appendChild(thumb);

    var info = el("div", "cgp-free__info");
    var nameRow = el("div", "cgp-free__name-row");
    var nameEl = el(link ? "a" : "span", "cgp-free__name", data.title);
    if (link) nameEl.href = link;
    nameRow.appendChild(nameEl);
    nameRow.appendChild(el("span", "cgp-free__badge", "FREE"));
    info.appendChild(nameRow);

    // Price sits in the info column (left), like add-on rows.
    var price = el("div", "cgp-free__price");
    price.appendChild(el("span", "cgp-free__now", money(0, ctx.currency)));
    if (ctx.showStrike) {
      price.appendChild(
        el("span", "cgp-free__was", money(data.price, ctx.currency)),
      );
    }
    info.appendChild(price);

    var select = null;
    if (offered.length > 1) {
      select = el("select", "cgp-free__variant");
      offered.forEach(function (v) {
        var opt = el("option", null, v.title + (v.available ? "" : " — sold out"));
        opt.value = v.id;
        if (!v.available) opt.disabled = true;
        select.appendChild(opt);
      });
      select.value = String(chosen.id);
      info.appendChild(select);
    }
    row.appendChild(info);

    // Always-selected, locked round selector (gift can't be removed here).
    var lockCheck = el("span", "cgp-check is-on is-locked", "✓");
    lockCheck.setAttribute("aria-label", "Free gift (included)");
    row.appendChild(lockCheck);

    function current() {
      if (select) {
        return (
          offered.filter(function (v) {
            return String(v.id) === select.value;
          })[0] || chosen
        );
      }
      return chosen;
    }

    ctx.freeItems.push({ productId: String(data.id), current: current });
    freeReqs.push({
      mainId: ctx.mainProductId,
      mainHandle: ctx.mainHandle,
      giftProductId: String(data.id),
      current: current,
    });
  }

  // Line item properties that mark a free gift. `_cgp_free_for` ties the gift
  // to its main product so reconcile can clean it up from any page once the
  // main is removed (one-to-one). The Function gives the line "🎁 Free Gift"
  // 100% off, so no extra visible tag is needed.
  function freeProps(mainId) {
    return { _cgp_free: "1", _cgp_free_for: String(mainId || "") };
  }

  /* ---------- Commit: add main + selected extras, then reset + open cart ---------- */

  function setupCTA(ctx) {
    if (!ctx.cta) return;
    ctx.cta.addEventListener("click", function () {
      commit(ctx);
    });
    // This block's CTA is now the single add-to-cart, so hide the theme's own
    // add button to avoid two competing buttons / two cart logics.
    hideThemeAddButton();
  }

  function hideThemeAddButton() {
    document
      .querySelectorAll('form[action*="/cart/add"] [name="add"]')
      .forEach(function (b) {
        b.style.display = "none";
      });
  }

  // Add the main product + selected accessories in ONE request, asking for the
  // exact sections the theme's cart element wants, then hand the response to the
  // theme's own renderContents() — so the cart drawer/notification updates and
  // opens exactly like a native add, with no second cart logic to fight.
  function commit(ctx) {
    var cta = ctx.cta;
    var original = cta.textContent;
    cta.disabled = true;
    cta.classList.add("is-loading");

    var cart =
      document.querySelector("cart-notification") ||
      document.querySelector("cart-drawer");
    var mv = mainVariant(ctx);

    fetch("/cart.js", { headers: { Accept: "application/json" } })
      .then(function (r) {
        return r.json();
      })
      .then(function (state) {
        var mainInCart = (state.items || []).some(function (it) {
          return String(it.product_id) === ctx.mainProductId;
        });
        var plan = buildPlan(ctx, mainInCart);
        var items = [];
        // Shared main for add-ons (no bundle tag).
        if (plan.mainsForAddons > 0 && mv.id) {
          items.push({ id: mv.id, quantity: 1 });
        }
        plan.addonItems.forEach(function (it) {
          items.push({
            id: it.id,
            quantity: 1,
            properties: { _addon_for: ctx.mainHandle },
          });
        });
        // Each bundle = its OWN main + accessories, all tagged with a unique
        // instance id (`_cgp_grp`) + the visible bundle name, so the discount
        // Function pairs them and deleting that main reverts only this bundle.
        // Each bundle = its OWN main + accessories, tagged with a unique
        // instance id (`_cgp_grp`) + the visible bundle name. A bundle with a
        // LIVE limited offer also carries `_cgp_lo` (the offer id) so its
        // time-gated node applies the deep price inside the window and the main
        // node takes over after expiry. Same grouping/cleanup either way.
        plan.bundles.forEach(function (b) {
          var grp =
            "b" +
            Date.now().toString(36) +
            Math.random().toString(36).slice(2, 7);
          var n = String(b.items.length); // how many accessories a full kit has
          var props = function (extra) {
            var p = { _cgp_grp: grp, _cgp_n: n, Bundle: b.name };
            if (b.offerId) p._cgp_lo = b.offerId;
            if (extra) for (var k in extra) p[k] = extra[k];
            return p;
          };
          if (mv.id) {
            items.push({ id: mv.id, quantity: 1, properties: props() });
          }
          b.items.forEach(function (it) {
            items.push({
              id: it.id,
              quantity: 1,
              properties: props({ _addon_for: ctx.mainHandle }),
            });
          });
        });
        // Free gifts ride along with the main, unless already in the cart.
        ctx.freeItems.forEach(function (f) {
          var already = (state.items || []).some(function (it) {
            return (
              String(it.product_id) === f.productId &&
              it.properties &&
              it.properties._cgp_free
            );
          });
          if (already) return;
          var v = f.current();
          if (v)
            items.push({
              id: v.id,
              quantity: 1,
              properties: freeProps(ctx.mainProductId),
            });
        });
        if (!items.length && mv.id) items.push({ id: mv.id, quantity: 1 });

        var body = { items: items };
        if (cart && typeof cart.getSectionsToRender === "function") {
          body.sections = cart
            .getSectionsToRender()
            .map(function (s) {
              return s.id;
            })
            .join(",");
          body.sections_url = window.location.pathname;
        }
        return fetch("/cart/add.js", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        }).then(function (r) {
          return r.json().then(function (b) {
            if (b && b.status) throw b; // Shopify error payload
            if (!r.ok) throw b;
            return b;
          });
        });
      })
      .then(function (response) {
        cta.classList.remove("is-loading");
        cta.classList.add("is-done");
        cta.textContent = "✓ Added to cart";
        ctx.mainInCart = true; // the main is now in the cart
        clearSelection(ctx);
        document.dispatchEvent(new CustomEvent("cgp:addon:added"));
        if (cart && typeof cart.renderContents === "function") {
          // Dawn keeps an `is-empty` class on the cart element while the cart is
          // empty, which hides the line items. Its own product-form clears it
          // after adding; we must do the same or the drawer renders blank.
          if (cart.classList.contains("is-empty")) {
            cart.classList.remove("is-empty");
          }
          try {
            cart.renderContents(response);
          } catch (e) {
            return refreshCartUI();
          }
        } else {
          return refreshCartUI();
        }
      })
      .then(function () {
        setTimeout(function () {
          cta.classList.remove("is-done");
          cta.disabled = false;
          updateCTA(ctx);
        }, 1800);
      })
      .catch(function (err) {
        cta.classList.remove("is-loading");
        cta.disabled = false;
        cta.textContent = original;
        try {
          console.error("[cgp] add to cart failed:", err);
        } catch (e) {}
        var msg =
          (err && (err.description || err.message)) ||
          "Could not add to cart.";
        alert(msg);
      });
  }

  function clearSelection(ctx) {
    ctx.extras.clear();
    ctx.resetFns.forEach(function (fn) {
      try {
        fn();
      } catch (e) {}
    });
    updateCounter(ctx);
  }

  // Add items only. The cart UI refresh is a SEPARATE, best-effort step so a
  // theme-specific section quirk can never break the actual add-to-cart.
  function postAdd(ctx, items) {
    return fetch("/cart/add.js", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        items: items.map(function (it) {
          return {
            id: it.id,
            quantity: it.quantity || 1,
            properties: it.addon ? { _addon_for: ctx.mainHandle } : {},
          };
        }),
      }),
    }).then(function (r) {
      return r.json().then(function (b) {
        if (!r.ok) throw b;
        return b;
      });
    });
  }

  // Best-effort cart refresh, fully decoupled from the add. Re-renders the
  // theme's cart sections (Section Rendering API), updates the count, opens the
  // drawer. Any failure here never affects the completed add-to-cart.
  function refreshCartUI() {
    return renderCartSections()
      .then(updateCount)
      .then(openDrawer)
      .catch(function () {});
  }

  function detectSections() {
    var s = [];
    if (document.getElementById("cart-icon-bubble")) s.push("cart-icon-bubble");
    if (document.querySelector("cart-drawer")) s.push("cart-drawer");
    if (document.querySelector("cart-notification")) s.push("cart-notification");
    return s;
  }

  function renderCartSections() {
    var wanted = detectSections();
    if (!wanted.length) return Promise.resolve();
    return fetch(
      window.location.pathname + "?sections=" + encodeURIComponent(wanted.join(",")),
      { headers: { Accept: "application/json" } },
    )
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (sections) {
        if (!sections) return;
        injectSection(
          sections["cart-icon-bubble"],
          "#cart-icon-bubble",
          ".shopify-section",
        );
        injectSection(
          sections["cart-drawer"],
          "#CartDrawer .drawer__inner, .drawer__inner",
          ".drawer__inner",
        );
        injectSection(
          sections["cart-notification"],
          "#cart-notification",
          ".shopify-section",
        );
      })
      .catch(function () {});
  }

  function injectSection(html, targetSelector, innerSelector) {
    if (!html) return;
    var target = document.querySelector(targetSelector);
    if (!target) return;
    try {
      var doc = new DOMParser().parseFromString(html, "text/html");
      var src = doc.querySelector(innerSelector) || doc.body;
      if (src) target.innerHTML = src.innerHTML;
    } catch (e) {}
  }

  function updateCount() {
    return fetch("/cart.js", { headers: { Accept: "application/json" } })
      .then(function (r) {
        return r.json();
      })
      .then(function (cart) {
        document
          .querySelectorAll(".cart-count-bubble, [data-cart-count]")
          .forEach(function (n) {
            var span = n.querySelector("span[aria-hidden='true']") || n;
            if (span) span.textContent = cart.item_count;
          });
        document.dispatchEvent(
          new CustomEvent("cart:refresh", { bubbles: true }),
        );
      })
      .catch(function () {});
  }

  function openDrawer() {
    var drawer = document.querySelector("cart-drawer");
    if (drawer && typeof drawer.open === "function") {
      try {
        drawer.open();
      } catch (e) {}
    }
  }

  // Run reconcileBundles() after any cart mutation (delete main, change qty, …).
  function installCartWatcher() {
    if (window.__cgpWatch) return;
    window.__cgpWatch = true;
    var orig = window.fetch;
    if (typeof orig !== "function") return;
    window.fetch = function (input) {
      var res = orig.apply(this, arguments);
      try {
        var u = typeof input === "string" ? input : (input && input.url) || "";
        if (!reconciling && /\/cart\/(change|update|add|clear)/.test(u)) {
          res
            .then(function () {
              clearTimeout(window.__cgpRecTimer);
              window.__cgpRecTimer = setTimeout(reconcileBundles, 50);
            })
            .catch(function () {});
        }
      } catch (e) {}
      return res;
    };
  }

  function cartPost(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json();
      })
      .catch(function () {});
  }

  // Removing a line-item property in place via /cart/change.js is unreliable, so
  // we remove the tagged line and re-add the same variant/quantity as a PLAIN,
  // untagged product.
  function untagLine(it) {
    return cartPost("/cart/change.js", { id: it.key, quantity: 0 }).then(
      function () {
        return cartPost("/cart/add.js", {
          items: [{ id: it.variant_id, quantity: it.quantity || 1 }],
        });
      },
    );
  }

  // A bundle's main + accessories share a `_cgp_grp` tag; the main is the line
  // WITHOUT `_addon_for`. We keep bundle tags correct by:
  //   1. stripping tags from a group whose main was removed (orphans), and
  //   2. keeping only ONE tagged unit per accessory per bundle instance —
  //      splitting any extra quantity (or duplicate line) into a plain,
  //      untagged, full-price product.
  var reconciling = false;
  function reconcileBundles() {
    if (reconciling) return;
    reconciling = true;
    return fetch("/cart.js", { headers: { Accept: "application/json" } })
      .then(function (r) {
        return r.json();
      })
      .then(function (cart) {
        var byGrp = {};
        (cart.items || []).forEach(function (it) {
          var grp = it.properties && it.properties._cgp_grp;
          if (!grp) return;
          (byGrp[grp] = byGrp[grp] || []).push(it);
        });

        // Collect every fix into ONE batched quantity update + ONE batched add,
        // instead of remove+re-add per line, so the cart settles fast.
        var updates = {}; // lineKey -> new quantity (0 = remove the line)
        var adds = []; // plain (untagged) re-adds: { id: variantId, quantity }

        Object.keys(byGrp).forEach(function (grp) {
          var lines = byGrp[grp];
          var hasMain = lines.some(function (it) {
            return !(it.properties && it.properties._addon_for);
          });
          var accProducts = {};
          var expectedN = 0;
          lines.forEach(function (it) {
            var p = it.properties || {};
            if (p._cgp_n) expectedN = parseInt(p._cgp_n, 10) || expectedN;
            if (p._addon_for) accProducts[String(it.product_id)] = true;
          });
          var accCount = Object.keys(accProducts).length;

          // Broken kit (main removed OR an accessory removed): untag every line.
          if (!hasMain || (expectedN > 0 && accCount < expectedN)) {
            lines.forEach(function (it) {
              updates[it.key] = 0;
              adds.push({ id: it.variant_id, quantity: it.quantity || 1 });
            });
            return;
          }

          // Complete kit: keep ONE tagged unit per accessory; split the rest off
          // as plain, untagged products.
          var seen = {};
          lines.forEach(function (it) {
            if (!(it.properties && it.properties._addon_for)) return; // skip main
            var pid = String(it.product_id);
            if (!seen[pid]) {
              seen[pid] = true;
              if (it.quantity > 1) {
                updates[it.key] = 1;
                adds.push({ id: it.variant_id, quantity: it.quantity - 1 });
              }
            } else {
              updates[it.key] = 0;
              adds.push({ id: it.variant_id, quantity: it.quantity || 1 });
            }
          });
        });

        // Free gifts: one-to-one with their main, max ONE unit per gift product.
        // We scan all `_cgp_free` lines in the cart (page-independent) and group
        // them by `_cgp_free_for` (their main's product id) so cleanup works
        // even when the customer is on a different product page.
        //   - main gone         -> remove every free line tied to that main
        //   - main present, >1  -> keep ONE per gift product, split the rest off
        // Auto-restore (re-adding a deleted gift) only happens for the CURRENT
        // page's gifts (freeReqs).
        var items = cart.items || [];
        /** @type {Object<string, Array<any>>} */
        var freeByMain = {};
        items.forEach(function (it) {
          if (!(it.properties && it.properties._cgp_free)) return;
          var key = String(it.properties._cgp_free_for || "");
          (freeByMain[key] = freeByMain[key] || []).push(it);
        });
        Object.keys(freeByMain).forEach(function (mainId) {
          var lines = freeByMain[mainId];
          var mainPresent =
            mainId &&
            items.some(function (it) {
              return String(it.product_id) === mainId;
            });
          if (!mainPresent) {
            // Main gone -> gift is gone too (one-to-one). Just remove, don't
            // re-add at full price.
            lines.forEach(function (it) {
              updates[it.key] = 0;
            });
            return;
          }
          // Main present: at most ONE tagged unit per gift product.
          var seen = {};
          lines.forEach(function (it) {
            var pid = String(it.product_id);
            if (!seen[pid]) {
              seen[pid] = true;
              if (it.quantity > 1) {
                updates[it.key] = 1;
                adds.push({ id: it.variant_id, quantity: it.quantity - 1 });
              }
            } else {
              updates[it.key] = 0;
              adds.push({ id: it.variant_id, quantity: it.quantity || 1 });
            }
          });
        });

        // Auto-restore the current page's gifts if their main is present but
        // the gift line was deleted.
        freeReqs.forEach(function (req) {
          var mainPresent = items.some(function (it) {
            return String(it.product_id) === req.mainId;
          });
          if (!mainPresent) return;
          var has = items.some(function (it) {
            return (
              it.properties &&
              it.properties._cgp_free &&
              String(it.product_id) === req.giftProductId &&
              String(it.properties._cgp_free_for || "") === req.mainId &&
              updates[it.key] !== 0
            );
          });
          if (!has) {
            var v = req.current();
            if (v) {
              adds.push({
                id: v.id,
                quantity: 1,
                properties: {
                  _cgp_free: "1",
                  _cgp_free_for: req.mainId,
                },
              });
            }
          }
        });

        if (!Object.keys(updates).length && !adds.length) return;

        var step = Object.keys(updates).length
          ? cartPost("/cart/update.js", { updates: updates })
          : Promise.resolve();

        return step.then(function () {
          // Pure removals (e.g. deleting a main drops its free gift) have no
          // re-adds — still re-render the drawer so the change shows.
          if (!adds.length) return rerenderDrawer();
          var cartEl =
            document.querySelector("cart-notification") ||
            document.querySelector("cart-drawer");
          var body = {
            items: adds.map(function (a) {
              return {
                id: a.id,
                quantity: a.quantity,
                properties: a.properties || {},
              };
            }),
          };
          if (cartEl && typeof cartEl.getSectionsToRender === "function") {
            body.sections = cartEl.getSectionsToRender().map(function (s) {
              return s.id;
            });
            body.sections_url = window.location.pathname;
          }
          return cartPost("/cart/add.js", body).then(function (resp) {
            if (
              cartEl &&
              typeof cartEl.renderContents === "function" &&
              resp &&
              resp.sections
            ) {
              if (cartEl.classList.contains("is-empty")) {
                cartEl.classList.remove("is-empty");
              }
              try {
                cartEl.renderContents(resp);
              } catch (e) {}
            }
          });
        });
      })
      .then(function () {
        reconciling = false;
      })
      .catch(function () {
        reconciling = false;
      });
  }

  // Re-render the cart drawer via the theme's own renderContents, fed by a fresh
  // POST /cart/update.js (a no-op update that returns the rendered sections).
  // POST responses aren't cached, and renderContents is the theme's native path.
  function rerenderDrawer() {
    var cart =
      document.querySelector("cart-notification") ||
      document.querySelector("cart-drawer");
    if (
      !cart ||
      typeof cart.getSectionsToRender !== "function" ||
      typeof cart.renderContents !== "function"
    ) {
      return renderCartSections().then(updateCount);
    }
    var ids = cart.getSectionsToRender().map(function (s) {
      return s.id;
    });
    return fetch("/cart/update.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sections: ids,
        sections_url: window.location.pathname,
      }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (state) {
        try {
          cart.renderContents(state);
        } catch (e) {}
        // Keep the empty/not-empty class correct, or the empty-state layout
        // (which needs `is-empty`) renders broken.
        if (state && typeof state.item_count === "number") {
          cart.classList.toggle("is-empty", state.item_count === 0);
        }
      })
      .catch(function () {});
  }

  function boot() {
    document.querySelectorAll("[data-cgp-addon]").forEach(init);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
