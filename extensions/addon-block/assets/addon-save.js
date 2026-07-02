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

  // Stock helpers for the "hide when sold out" option (add-on / free groups).
  function accInStock(group, data) {
    return offeredVariants(group, data).some(function (v) {
      return v.available;
    });
  }
  function groupInStock(group) {
    return Promise.all(
      (group.accessories || []).map(function (a) {
        return fetchProduct(a.handle);
      }),
    ).then(function (datas) {
      return datas.some(function (d) {
        return d && accInStock(group, d);
      });
    });
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

    // Gift campaigns run independently of the per-product add-on config — a pure
    // trigger product has gifts but no addon_config.
    bootGifts(root);

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
      bundleCounterEl: root.querySelector("[data-cgp-bundle-counter]"),
      extras: new Map(), // key -> { kind, percent, items: [{id, price}] }
      freeItems: [], // { productId, title, current() } auto-added free gifts
      resetFns: [], // visual de-selectors, run after a successful add
      bundlePaints: [], // re-render hooks, run once the main product loads
      mainVarSync: [], // bundles re-sync their main variant on a page variant change
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

    // When the customer changes the main product variant on the page, let
    // bundles re-sync their main-variant picker/price.
    document.addEventListener(
      "change",
      function (e) {
        var t = e.target;
        if (
          t &&
          t.closest &&
          t.closest(
            'variant-selects, variant-radios, .product-form__input, form[action*="/cart/add"]',
          )
        ) {
          holdScroll(600); // theme re-renders media async on variant change
          setTimeout(function () {
            ctx.mainVarSync.forEach(function (fn) {
              try {
                fn();
              } catch (e) {}
            });
          }, 50);
        }
      },
      true,
    );

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

  function mainVariantObj(ctx, vid) {
    var d = ctx.mainData;
    if (!d || !d.variants) return null;
    return (
      d.variants.filter(function (x) {
        return String(x.id) === String(vid);
      })[0] || null
    );
  }

  // The main variant a bundle uses: the currently-selected one when it's allowed
  // (or the bundle has no restriction), otherwise the first allowed variant.
  function bundleMainVar(ctx, group) {
    var cur = mainVariant(ctx); // { id, price }
    var ids = group && group.mainVariantIds;
    if (!ids || !ids.length) return cur;
    var allow = ids.map(gidTail);
    if (allow.indexOf(String(cur.id)) >= 0) return cur;
    var v = mainVariantObj(ctx, allow[0]);
    return v ? { id: v.id, price: v.price } : cur;
  }

  // Switch the product page's main variant (image + price + picker) — used when a
  // bundle tied to a specific main variant is selected. Best-effort, Dawn-style.
  function selectMainVariant(ctx, vid) {
    var v = mainVariantObj(ctx, vid);
    if (!v) return;
    // 1. Drive the theme's own variant picker so it updates price + image itself.
    try {
      var opts = v.options || [];
      var groups = document.querySelectorAll(
        "variant-selects fieldset, variant-radios fieldset, .product-form__input",
      );
      opts.forEach(function (val, i) {
        var fs = groups[i];
        if (!fs) return;
        var radio = fs.querySelector('input[type="radio"][value="' + cssEsc(val) + '"]');
        if (radio && !radio.checked) {
          radio.checked = true;
          radio.dispatchEvent(new Event("change", { bubbles: true }));
        }
        var sel = fs.querySelector("select");
        if (sel && sel.value !== val) {
          sel.value = val;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
    } catch (e) {}
    // 2. Hidden form id + URL (so add-to-cart / sharing reflect the variant).
    try {
      document
        .querySelectorAll('form[action*="/cart/add"] [name="id"]')
        .forEach(function (inp) {
          inp.value = v.id;
        });
      var url = new URL(window.location.href);
      url.searchParams.set("variant", v.id);
      window.history.replaceState({}, "", url);
    } catch (e) {}
    // 3. Fallback: swap the main gallery image directly.
    var img = v.featured_image && (v.featured_image.src || v.featured_image);
    if (img) {
      var main = document.querySelector(
        ".product__media-wrapper img, media-gallery img, .product__media img, .product-media img",
      );
      if (main) {
        main.src = img;
        main.removeAttribute("srcset");
      }
    }
  }

  function cssEsc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
  }

  // Pin the page scroll to its current Y for a short window. Driving the
  // theme's variant picker makes Dawn re-render the media/info section
  // asynchronously, which nudges the page down; a one-frame restore isn't
  // enough, so we re-pin every frame until the re-render settles.
  function holdScroll(ms) {
    var y = window.pageYOffset;
    var until = Date.now() + (ms || 500);
    (function loop() {
      if (window.pageYOffset !== y) window.scrollTo(0, y);
      if (Date.now() < until) requestAnimationFrame(loop);
    })();
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
          bid: e.bid || null,
          mainVariantId: e.mainVariantId || null,
          mainPrice: e.mainPrice || 0,
          mainPercent: e.mainPercent || 0,
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
    // Every add-to-cart is a COMPLETE unit: it always brings a main product.
    // For add-ons (no bundle in this click) add one shared main; a bundle kit
    // already brings its own main. A bare add also adds a main.
    var mainsForAddons = bundles.length === 0 ? 1 : 0;
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
    var count = plan.mainsForAddons + plan.bundles.length;
    var total = plan.mainsForAddons * (mv.price || 0);
    plan.addonItems.forEach(function (it) {
      count += 1;
      total += discounted(it.price, it.percent);
    });
    plan.bundles.forEach(function (b) {
      // bundle's own main (discounted only if the bundle opts in) + accessories
      total += discounted(b.mainPrice || mv.price || 0, b.mainPercent || 0);
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
    if (ctx.counterEl) {
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
    // Bundle counter mirrors the add-on one: count of selected bundles + their
    // whole total (main full price + discounted accessories).
    if (ctx.bundleCounterEl) {
      var bn = 0,
        btotal = 0;
      ctx.extras.forEach(function (e) {
        if (e.kind !== "bundle") return;
        bn++;
        btotal += discounted(e.mainPrice || 0, e.mainPercent || 0);
        e.items.forEach(function (it) {
          btotal += discounted(it.price, it.percent || 0);
        });
      });
      ctx.bundleCounterEl.innerHTML = "";
      if (bn > 0) {
        ctx.bundleCounterEl.appendChild(
          el(
            "span",
            "cgp-addon__counter-n",
            "+" + bn + " BUNDLE" + (bn > 1 ? "S" : ""),
          ),
        );
        ctx.bundleCounterEl.appendChild(
          el("span", "cgp-addon__counter-price", money(btotal, ctx.currency)),
        );
      }
    }
  }

  /* ---------- ADD-ON groups: tabbed grid of toggle cards ---------- */

  // An add-on group shows only when the current main variant is allowed (or the
  // group has no main-variant restriction).
  function addonGroupVisible(ctx, group) {
    var ids = group.mainVariantIds;
    if (!ids || !ids.length) return true;
    var cur = String(readMainVariantId());
    return (
      ids
        .map(gidTail)
        .indexOf(cur) >= 0
    );
  }

  function renderAddons(ctx, groups, root) {
    var wrap = root.querySelector("[data-cgp-addons]");
    if (!wrap || !groups.length) {
      if (wrap) wrap.hidden = true;
      return;
    }
    var tabsEl = wrap.querySelector("[data-cgp-tabs]");
    var gridEl = wrap.querySelector("[data-cgp-grid]");
    ctx.gridEl = gridEl;

    function paintAddons() {
      // Candidates = groups allowed for the current main variant. Then resolve
      // each group's stock (async, cached) so a fully sold-out "hide when sold
      // out" group drops out of the tabs entirely.
      var byMain = groups.filter(function (g) {
        return addonGroupVisible(ctx, g);
      });
      Promise.all(
        byMain.map(function (g) {
          return g.hideWhenSoldOut ? groupInStock(g) : Promise.resolve(true);
        }),
      ).then(function (stocks) {
        var visible = byMain.filter(function (_g, i) {
          return stocks[i];
        });
        // Drop selections from groups no longer shown (hidden or sold out).
        groups.forEach(function (g) {
          if (visible.indexOf(g) >= 0) return;
          (g.accessories || []).forEach(function (a) {
            ctx.extras.delete("addon:" + gidTail(a.productId));
          });
        });
        paintVisible(visible);
      });
    }

    function paintVisible(visible) {
      if (!visible.length) {
        wrap.hidden = true;
        tabsEl.innerHTML = "";
        gridEl.innerHTML = "";
        ctx.onChange();
        return;
      }
      wrap.hidden = false;
      tabsEl.innerHTML = "";
      if (visible.length > 1) {
        tabsEl.style.display = "";
        visible.forEach(function (group, i) {
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
      renderGroup(ctx, visible[0]);
      ctx.onChange();
    }

    paintAddons();
    // Re-evaluate which add-on groups show when the page main variant changes.
    ctx.mainVarSync.push(paintAddons);
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
        // "Hide when sold out": drop accessories with no available variant.
        if (group.hideWhenSoldOut && !accInStock(group, data)) return;
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
      var expanded = false; // View-more open state (persists across re-renders)
      // Customer's chosen variant per accessory (numeric product id -> variant).
      var chosenVars = {};
      // Customer's chosen MAIN-product variant for this bundle.
      var chosenMainVar = null;

      function offeredFor(p) {
        return offeredVariants(group, p);
      }
      function chosenVarFor(p) {
        var off = offeredFor(p);
        if (off.length <= 1) return off[0];
        return chosenVars[gidTail(p.id)] || null;
      }

      // Which MAIN-product variants this bundle offers (mainVariantIds, else all).
      function offeredMainVar() {
        var all = (ctx.mainData && ctx.mainData.variants) || [];
        var ids = group.mainVariantIds;
        if (!ids || !ids.length) return all;
        var allow = {};
        ids.forEach(function (g) {
          allow[gidTail(g)] = true;
        });
        var f = all.filter(function (v) {
          return allow[String(v.id)];
        });
        return f.length ? f : all;
      }
      // Resolved main variant: chosen, or the only one offered, else null (pick).
      function curMainVar() {
        if (chosenMainVar) return chosenMainVar;
        var om = offeredMainVar();
        return om.length === 1 ? om[0] : null;
      }
      function mainPriceVal() {
        var v = curMainVar();
        if (v) return v.price || 0;
        var om = offeredMainVar();
        return (om[0] && om[0].price) || mainVariant(ctx).price || 0;
      }
      // A bundle is ONE discount on the whole kit: the main gets the SAME % as
      // the accessories, including the deep limited price while an offer runs.
      function mainPercentOf(state) {
        if (hasLimited && (state === "active" || state === "upcoming")) {
          return Number(group.limited.discountPercent) || 0;
        }
        if (hasLimited && state === "ended" && group.limited.mode !== "revert") {
          return 0;
        }
        return Math.max(0, Math.min(100, Number(group.discountPercent) || 0));
      }
      // Main thumbnail/row image — the chosen variant's own image when it has
      // one, so switching the bundle's main variant updates the small picture.
      function mainImg() {
        var v = curMainVar();
        if (v && v.featured_image) return v.featured_image.src || v.featured_image;
        return (
          (ctx.mainData &&
            (ctx.mainData.featured_image ||
              (ctx.mainData.images && ctx.mainData.images[0]))) ||
          null
        );
      }
      // Accessory thumbnail — chosen variant's own image when it has one, so
      // switching an accessory variant updates its small picture too.
      function accImg(p) {
        var v = chosenVarFor(p);
        if (v && v.featured_image) return v.featured_image.src || v.featured_image;
        return p.featured_image || (p.images && p.images[0]);
      }
      // Accessory price for the chosen variant (else first available), so the
      // displayed unit/total prices match exactly what gets added to the cart.
      function accPriceVal(p) {
        var v = chosenVarFor(p) || firstAvailableIn(offeredFor(p));
        return v && v.price != null ? v.price : p.price;
      }

      function bundleReady() {
        if (offeredMainVar().length > 1 && !chosenMainVar) return false;
        return products.every(function (p) {
          return !!chosenVarFor(p);
        });
      }

      // Re-sync the chosen main variant when the page variant changes (one-way:
      // page -> bundle). Registered globally; fired on a product-form change.
      function syncMain() {
        var om = offeredMainVar();
        if (om.length <= 1) return;
        var cur = readMainVariantId();
        var match = om.filter(function (v) {
          return String(v.id) === String(cur);
        })[0];
        if (
          match &&
          (!chosenMainVar || String(chosenMainVar.id) !== String(match.id))
        ) {
          chosenMainVar = match;
          paint();
        }
      }
      ctx.mainVarSync.push(syncMain);

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
        // A bundle is ONE discount on the whole kit — the group %, same as the
        // main. Per-accessory overrides are an add-on-only concept; ignore any
        // stale ones so the cart/Function match this card exactly.
        return Math.max(0, Math.min(100, Number(group.discountPercent) || 0));
      }
      // Tag `_cgp_lo` only while the offer is actually live, so the time-gated
      // node governs the price; after expiry the main node takes over.
      function offerIdFor(state) {
        return hasLimited && state === "active" ? group.offerId || null : null;
      }

      function storeSelection(state, offerId) {
        var mv = curMainVar() || offeredMainVar()[0] || mainVariant(ctx);
        ctx.extras.set(key, {
          kind: "bundle",
          percent: 0, // each item carries its own percent
          offerId: offerId || null,
          bid: group.id || null, // which bundle group (for main-line discount)
          title: group.title || "Bundle",
          mainVariantId: mv ? mv.id : null,
          mainPrice: (mv && mv.price) || 0,
          mainPercent: mainPercentOf(state), // whole-kit %, deep while offer runs
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

      // Rebuilding the card (innerHTML reset) can nudge the page scroll —
      // switching a variant repeatedly would creep it downward. Pin scrollY
      // around the rebuild so the bundle stays put.
      function paint() {
        var sy = window.pageYOffset;
        paintBody();
        if (window.pageYOffset !== sy) window.scrollTo(0, sy);
        requestAnimationFrame(function () {
          if (window.pageYOffset !== sy) window.scrollTo(0, sy);
        });
      }

      function paintBody() {
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

        // Default the main variant to the page's current one (if it's offered).
        if (!chosenMainVar) {
          var om0 = offeredMainVar();
          if (om0.length <= 1) chosenMainVar = om0[0] || null;
          else {
            var cur0 = readMainVariantId();
            var m0 = om0.filter(function (v) {
              return String(v.id) === String(cur0);
            })[0];
            if (m0) chosenMainVar = m0;
          }
        }

        var accNow = 0,
          accWas = 0;
        products.forEach(function (p) {
          var base = accPriceVal(p);
          accWas += base;
          accNow += discounted(base, itemPercentFor(p, state));
        });
        // The bundle shows its WHOLE total (main + accessories). The main is
        // full price unless this bundle opts into discounting the main too.
        var mainWas = mainPriceVal();
        var mainPct = mainPercentOf(state);
        var mainNow = discounted(mainWas, mainPct);
        var totalNow = mainNow + accNow;
        var totalWas = mainWas + accWas;
        var saved = totalWas - totalNow;
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
            var img = p === ctx.mainData ? mainImg() : accImg(p);
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
        card.appendChild(listEl);

        function variantSelect(offered, currentId, onPick) {
          var s = el("select", "cgp-bundle__variant");
          var ph = el("option", null, "Choose an option…");
          ph.value = "";
          s.appendChild(ph);
          offered.forEach(function (v) {
            var o = el("option", null, v.title + (v.available ? "" : " — sold out"));
            o.value = v.id;
            if (!v.available) o.disabled = true;
            s.appendChild(o);
          });
          s.value = currentId ? String(currentId) : "";
          s.addEventListener("change", function () {
            s.classList.remove("cgp-needs-choice");
            onPick(
              offered.filter(function (x) {
                return String(x.id) === s.value;
              })[0] || null,
            );
          });
          return s;
        }

        // Detail list: the MAIN product (with its own variant picker, like the
        // accessories) first, then each accessory.
        function buildContents() {
          listEl.innerHTML = "";
          if (ctx.mainData) {
            var om = offeredMainVar();
            var mainSel =
              om.length > 1
                ? variantSelect(om, chosenMainVar && chosenMainVar.id, function (v) {
                    holdScroll(600); // Dawn re-renders media async; keep page put
                    chosenMainVar = v;
                    if (v) selectMainVariant(ctx, v.id); // sync to the page picker
                    if (selected) {
                      // Keep the cart selection in sync with the new variant.
                      if (bundleReady()) storeSelection(state, offerIdFor(state));
                      else setSelected(false, state, offerIdFor(state));
                    }
                    paint();
                    ctx.onChange(); // refresh totals above the Add-to-cart button
                  })
                : null;
            listEl.appendChild(
              contentRow(
                ctx,
                ctx.mainData,
                mainPercentOf(state),
                "Current product",
                true,
                mainSel,
                mainImg(),
                mainPriceVal(),
              ),
            );
          }
          products.forEach(function (p) {
            var off = offeredFor(p);
            var sel =
              off.length > 1
                ? variantSelect(off, chosenVars[gidTail(p.id)] && chosenVars[gidTail(p.id)].id, function (v) {
                    chosenVars[gidTail(p.id)] = v;
                    if (selected) {
                      if (bundleReady()) storeSelection(state, offerIdFor(state));
                      else setSelected(false, state, offerIdFor(state));
                    }
                    paint(); // refresh this accessory's thumbnail + price
                    ctx.onChange(); // refresh totals above the Add-to-cart button
                  })
                : null;
            listEl.appendChild(
              contentRow(ctx, p, itemPercentFor(p, state), null, false, sel, accImg(p), accPriceVal(p)),
            );
          });
        }

        function setExpanded(open) {
          expanded = open;
          listEl.hidden = !open;
          thumbs.hidden = open;
          if (open && !listEl.childNodes.length) buildContents();
          toggleLine.textContent = open ? "Hide ▴" : "View more ▾";
        }
        setExpanded(expanded); // restore open state across re-renders
        toggleLine.addEventListener("click", function (e) {
          e.stopPropagation();
          setExpanded(!expanded);
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

  function contentRow(ctx, data, percent, tag, isMain, sel, imgOverride, priceOverride) {
    var basePrice = priceOverride != null ? priceOverride : data.price;
    var row = el("div", "cgp-bundle__content-row");
    var link = !isMain && data.handle ? "/products/" + data.handle : null;
    var thumb = el(link ? "a" : "div", "cgp-bundle__content-thumb");
    if (link) thumb.href = link;
    var img = imgOverride || data.featured_image || (data.images && data.images[0]);
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
        money(discounted(basePrice, percent), ctx.currency),
      ),
    );
    if (percent > 0 && ctx.showStrike) {
      p.appendChild(el("span", "cgp-bundle__was", money(basePrice, ctx.currency)));
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
    groups.forEach(function (group) {
      Promise.all(
        (group.accessories || []).map(function (a) {
          return fetchProduct(a.handle);
        }),
      ).then(function (datas) {
        var items = datas.filter(function (d) {
          if (!d) return false;
          // "Hide when sold out": drop gifts with no available variant.
          if (group.hideWhenSoldOut && !accInStock(group, d)) return false;
          return true;
        });
        if (!items.length) return; // whole gift group sold out -> hide section
        wrap.hidden = false;
        var section = el("div", "cgp-free");
        section.appendChild(
          el("h2", "cgp-free__heading", group.title || "🎁 Free gift"),
        );
        var list = el("div", "cgp-free__list");
        section.appendChild(list);
        wrap.appendChild(section);
        items.forEach(function (data) {
          var row = el("div", "cgp-free__row");
          list.appendChild(row);
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
            if (b.bid) p._cgp_bid = b.bid; // which bundle group (main discount)
            if (extra) for (var k in extra) p[k] = extra[k];
            return p;
          };
          // A bundle tied to a specific main variant adds THAT variant as its main.
          var bundleMainId = b.mainVariantId || mv.id;
          if (bundleMainId) {
            items.push({ id: bundleMainId, quantity: 1, properties: props() });
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

  // ---- Gift campaigns (cross-product "gift with purchase") ----
  // Theme-readable snapshot of active campaigns (set by bootGifts).
  var giftCampaigns = null;
  var giftReconciling = false;

  function giftActive(c) {
    var now = Date.now();
    var s = c.startsAt ? Date.parse(c.startsAt) : NaN;
    var e = c.endsAt ? Date.parse(c.endsAt) : NaN;
    if (!isNaN(e) && now >= e) return false;
    if (!isNaN(s) && now < s) return false;
    return true;
  }

  // Keep each fixed campaign's gift line at the unlocked allowance
  // (qualifying qty x perQualifying). The Function caps the discount server-side;
  // this is the UX side that adds/trims the gift line.
  function reconcileGifts() {
    if (giftReconciling || !giftCampaigns || !giftCampaigns.length)
      return Promise.resolve();
    giftReconciling = true;
    return fetch("/cart.js", { headers: { Accept: "application/json" } })
      .then(function (r) {
        return r.json();
      })
      .then(function (cart) {
        var items = cart.items || [];
        var updates = {};
        var adds = []; // { handle, quantity, campId }
        giftCampaigns.forEach(function (c) {
          if (c.rewardMode !== "fixed") return; // "choice" picker is a later phase
          var giftHandle = (c.giftHandles || [])[0];
          if (!giftHandle) return;
          var trig = {};
          (c.triggerProductIds || []).forEach(function (id) {
            trig[String(id)] = true;
          });
          var qty = 0;
          items.forEach(function (it) {
            if (it.properties && it.properties._cgp_gift) return; // skip gifts
            if (trig[String(it.product_id)]) qty += it.quantity || 0;
          });
          var allowance = giftActive(c) ? qty * (Number(c.perQualifying) || 1) : 0;
          var giftLines = items.filter(function (it) {
            return it.properties && String(it.properties._cgp_gift) === String(c.id);
          });
          if (allowance <= 0) {
            giftLines.forEach(function (it) {
              updates[it.key] = 0;
            });
          } else if (giftLines.length === 0) {
            adds.push({ handle: giftHandle, quantity: allowance, campId: c.id });
          } else {
            giftLines.forEach(function (it, idx) {
              if (idx === 0) {
                if ((it.quantity || 0) !== allowance) updates[it.key] = allowance;
              } else {
                updates[it.key] = 0; // collapse duplicates into one line
              }
            });
          }
        });
        var chain = Promise.resolve();
        if (Object.keys(updates).length) {
          chain = chain.then(function () {
            return cartPost("/cart/update.js", { updates: updates });
          });
        }
        adds.forEach(function (a) {
          chain = chain.then(function () {
            return fetchProduct(a.handle).then(function (data) {
              if (!data) return;
              var v = firstAvailable(data);
              if (!v) return;
              return cartPost("/cart/add.js", {
                items: [
                  {
                    id: v.id,
                    quantity: a.quantity,
                    properties: { _cgp_gift: a.campId },
                  },
                ],
              });
            });
          });
        });
        return chain;
      })
      .catch(function () {})
      .then(function () {
        giftReconciling = false;
      });
  }

  function bootGifts(root) {
    if (window.__cgpGiftsBooted) return;
    var node = root.querySelector("[data-cgp-gifts]");
    if (!node) return;
    var raw;
    try {
      raw = JSON.parse(node.textContent);
    } catch (e) {
      raw = null;
    }
    if (!raw || !raw.length) return;
    // Normalise the product's gift_trigger entries into the campaign shape
    // reconcileGifts expects (accepts both `triggers`/`gifts` and the older
    // `triggerProductIds`/`giftHandles`).
    giftCampaigns = raw.map(function (e) {
      return {
        id: e.id,
        rewardMode: e.rewardMode || "fixed",
        perQualifying: Number(e.perQualifying) || 1,
        startsAt: e.startsAt || "",
        endsAt: e.endsAt || "",
        triggerProductIds: e.triggers || e.triggerProductIds || [],
        giftHandles: e.gifts || e.giftHandles || [],
      };
    });
    if (!giftCampaigns.length) return;
    window.__cgpGiftsBooted = true;
    installCartWatcher();
    reconcileGifts();
  }

  // Run reconcile after any cart mutation (delete main, change qty, …).
  function installCartWatcher() {
    if (window.__cgpWatch) return;
    window.__cgpWatch = true;
    var orig = window.fetch;
    if (typeof orig !== "function") return;
    window.fetch = function (input) {
      var res = orig.apply(this, arguments);
      try {
        var u = typeof input === "string" ? input : (input && input.url) || "";
        if (
          !reconciling &&
          !giftReconciling &&
          /\/cart\/(change|update|add|clear)/.test(u)
        ) {
          res
            .then(function () {
              clearTimeout(window.__cgpRecTimer);
              window.__cgpRecTimer = setTimeout(function () {
                var p = reconcileBundles();
                if (p && p.then) p.then(reconcileGifts);
                else reconcileGifts();
              }, 50);
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

        // NOTE: a gift the customer deletes is NOT auto-restored — once removed
        // in the cart it stays gone. It can still be re-added by adding the kit
        // again (commit re-adds a gift that isn't already in the cart).

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
