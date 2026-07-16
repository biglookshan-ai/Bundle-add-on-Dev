/* Accessory offers — Function-FREE storefront (optional accessories + free
 * gifts). Native "Buy X Get Y" discounts (created by the app) do all the pricing
 * in the cart; this script only renders the selectors, shows the live saving,
 * and adds the chosen products to the cart. Works on any Shopify plan. */
(function () {
  var cache = {};
  function fetchProduct(handle) {
    if (cache[handle]) return cache[handle];
    cache[handle] = fetch("/products/" + handle + ".js", {
      headers: { Accept: "application/json" },
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .catch(function () {
        return null;
      });
    return cache[handle];
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function money(cents, cur) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: cur || "USD",
      }).format((Number(cents) || 0) / 100);
    } catch (e) {
      return "$" + ((Number(cents) || 0) / 100).toFixed(2);
    }
  }
  function gidTail(id) {
    return String(id).split("/").pop();
  }
  function offeredVariants(item, data) {
    var all = (data && data.variants) || [];
    if (item.variantIds && item.variantIds.length) {
      var allow = {};
      item.variantIds.forEach(function (g) {
        allow[gidTail(g)] = true;
      });
      var f = all.filter(function (v) {
        return allow[String(v.id)];
      });
      if (f.length) return f;
    }
    return all;
  }
  function firstAvailable(list) {
    return (
      (list || []).filter(function (v) {
        return v.available;
      })[0] ||
      (list || [])[0]
    );
  }
  // The page's currently-selected main variant id (theme's own picker).
  function mainVariantId() {
    var input =
      document.querySelector('form[action*="/cart/add"] [name="id"]') ||
      document.querySelector('[name="id"]');
    if (input && input.value) return String(input.value);
    var m = window.location.search.match(/[?&]variant=(\d+)/);
    return m ? m[1] : null;
  }

  // Shared add-to-cart (re-renders the theme's cart drawer when possible).
  function addToCart(items, cta) {
    if (!items.length) return;
    var drawer =
      document.querySelector("cart-notification") ||
      document.querySelector("cart-drawer");
    var body = { items: items };
    if (drawer && typeof drawer.getSectionsToRender === "function") {
      body.sections = drawer.getSectionsToRender().map(function (s) {
        return s.id;
      });
      body.sections_url = window.location.pathname;
    }
    fetch("/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (resp) {
        if (cta) cta.disabled = false;
        if (drawer && typeof drawer.renderContents === "function" && resp.sections) {
          drawer.classList.remove("is-empty");
          try {
            drawer.renderContents(resp);
          } catch (e) {}
        } else {
          window.location.href = "/cart";
        }
      })
      .catch(function () {
        if (cta) cta.disabled = false;
      });
  }

  function paintPrice(priceEl, base, pct, currency) {
    var now = Math.round(base * (1 - pct / 100));
    if (pct > 0) {
      priceEl.innerHTML =
        '<span class="cgp-acc__old">' +
        money(base, currency) +
        "</span>" +
        (pct >= 100
          ? '<span class="cgp-acc__free">FREE</span>'
          : '<span class="cgp-acc__new">' + money(now, currency) + "</span>");
    } else {
      priceEl.textContent = money(base, currency);
    }
  }

  var bundleGroupSeq = 0;

  // Bundle mode: each group is a standalone, radio-selectable bundle. Only the
  // chosen bundle's components are added to the cart, so only its native BxGy
  // fires. Shows a per-bundle total (main + components) with the saving.
  function setupBundle(root, config, host, cta, ctaLabel, currency, defaultPct) {
    var groups = (config.groups || []).filter(function (g) {
      return !g.archived && (g.accessories || []).length;
    });
    if (!groups.length) return;
    var mainHandle = root.getAttribute("data-product-handle");
    var radioName = "cgp-bundle-" + bundleGroupSeq++;

    cta.textContent = "";
    var ctaMain = el("span", "cgp-acc__cta-main", ctaLabel || "Add to cart");
    var ctaSub = el("span", "cgp-acc__cta-sub", "");
    cta.appendChild(ctaMain);
    cta.appendChild(ctaSub);
    cta.hidden = false;

    var mainBase = 0; // current main variant price (cents)
    var bundles = [];
    var selectedIdx = -1;

    function selectBundle(idx) {
      selectedIdx = idx;
      bundles.forEach(function (b, i) {
        b.radio.checked = i === idx;
        b.tile.classList.toggle("is-selected", i === idx);
        b.body.hidden = i !== idx;
      });
      updateCta();
    }
    function updateCta() {
      if (selectedIdx < 0) {
        ctaSub.style.display = "none";
        return;
      }
      var s = bundles[selectedIdx].currentSave();
      if (s > 0) {
        ctaSub.textContent = "You save " + money(s, currency);
        ctaSub.style.display = "";
      } else {
        ctaSub.style.display = "none";
      }
    }

    groups.forEach(function (group, gi) {
      var pct =
        Number(group.bundlePercent != null ? group.bundlePercent : defaultPct) ||
        0;
      var tile = el("div", "cgp-bundle");
      var head = el("label", "cgp-bundle__head");
      var radio = el("input", "cgp-bundle__radio");
      radio.type = "radio";
      radio.name = radioName;
      var headInfo = el("span", "cgp-bundle__headinfo");
      var nameEl = el(
        "span",
        "cgp-bundle__name",
        group.title || "Bundle " + (gi + 1),
      );
      var priceRow = el("span", "cgp-bundle__pricerow");
      headInfo.appendChild(nameEl);
      headInfo.appendChild(priceRow);
      head.appendChild(radio);
      head.appendChild(headInfo);
      tile.appendChild(head);
      var body = el("div", "cgp-bundle__body");
      body.hidden = true;
      tile.appendChild(body);
      host.appendChild(tile);

      radio.addEventListener("change", function () {
        if (radio.checked) selectBundle(gi);
      });

      var rows = [];

      function currentSave() {
        var s = 0;
        if (pct > 0)
          rows.forEach(function (r) {
            s += Math.round((r.base * pct) / 100);
          });
        return s;
      }
      function recalc() {
        var compBase = 0;
        rows.forEach(function (r) {
          compBase += r.base;
        });
        var save = currentSave();
        var was = mainBase + compBase;
        var now = was - save;
        priceRow.innerHTML = "";
        priceRow.appendChild(el("span", "cgp-bundle__now", money(now, currency)));
        if (save > 0) {
          priceRow.appendChild(
            el("span", "cgp-bundle__was", money(was, currency)),
          );
          priceRow.appendChild(
            el("span", "cgp-bundle__save", "Save " + money(save, currency)),
          );
        }
        if (selectedIdx === gi) updateCta();
      }

      group.accessories.forEach(function (a) {
        var row = el("div", "cgp-acc__row is-selected");
        var media = el("span", "cgp-acc__thumb");
        var infoCol = el("span", "cgp-acc__info");
        var cname = el("span", "cgp-acc__name", a.title || a.handle);
        var priceEl = el("span", "cgp-acc__price", "");
        infoCol.appendChild(cname);
        infoCol.appendChild(priceEl);
        row.appendChild(media);
        row.appendChild(infoCol);
        body.appendChild(row);

        var rec = { getVariantId: null, base: 0 };
        rows.push(rec);

        fetchProduct(a.handle).then(function (data) {
          if (!data) {
            row.remove();
            return;
          }
          cname.textContent = data.title || a.title;
          var img = data.featured_image || (data.images && data.images[0]);
          if (img) {
            var im = el("img");
            im.src = img;
            media.appendChild(im);
          }
          var offered = offeredVariants(a, data);
          var v = firstAvailable(offered);
          if (!v) {
            row.remove();
            return;
          }
          rec.getVariantId = v.id;
          rec.base = v.price;
          paintPrice(priceEl, v.price, pct, currency);
          if (offered.length > 1) {
            var sel = el("select", "cgp-acc__variant");
            offered.forEach(function (o) {
              var opt = el(
                "option",
                null,
                o.title + (o.available ? "" : " — sold out"),
              );
              opt.value = o.id;
              if (!o.available) opt.disabled = true;
              sel.appendChild(opt);
            });
            sel.value = v.id;
            sel.addEventListener("change", function () {
              var chosen = offered.filter(function (o) {
                return String(o.id) === String(sel.value);
              })[0];
              rec.getVariantId = sel.value;
              rec.base = chosen ? chosen.price : rec.base;
              paintPrice(priceEl, rec.base, pct, currency);
              recalc();
            });
            infoCol.appendChild(sel);
          }
          recalc();
        });
      });

      bundles.push({
        tile: tile,
        body: body,
        radio: radio,
        rows: rows,
        recalc: recalc,
        currentSave: currentSave,
      });
    });

    function loadMain() {
      if (!mainHandle) {
        bundles.forEach(function (b) {
          b.recalc();
        });
        return;
      }
      fetchProduct(mainHandle).then(function (data) {
        if (data) {
          var cur = mainVariantId();
          var mv = null;
          (data.variants || []).forEach(function (v) {
            if (String(v.id) === String(cur)) mv = v;
          });
          if (!mv) mv = firstAvailable(data.variants);
          mainBase = mv ? mv.price : 0;
        }
        bundles.forEach(function (b) {
          b.recalc();
        });
      });
    }
    loadMain();
    var form = document.querySelector('form[action*="/cart/add"]');
    if (form) form.addEventListener("change", loadMain);

    selectBundle(0);

    cta.addEventListener("click", function () {
      if (selectedIdx < 0) return;
      var items = [];
      var mv = mainVariantId();
      if (mv) items.push({ id: mv, quantity: 1 });
      bundles[selectedIdx].rows.forEach(function (r) {
        if (r.getVariantId) items.push({ id: r.getVariantId, quantity: 1 });
      });
      if (!items.length) return;
      cta.disabled = true;
      addToCart(items, cta);
    });
  }

  function init(root) {
    if (root.__cgpAcc) return;
    root.__cgpAcc = true;
    var node = root.querySelector("[data-cgp-acc-config]");
    if (!node) return;
    var config;
    try {
      config = JSON.parse(node.textContent);
    } catch (e) {
      return;
    }
    var groups = (config && config.groups) || [];
    if (!groups.length) return;
    // Single native offer: one rate for every accessory, a fixed required qty.
    var offerPercent = Number(config.offerPercent) || 0;
    var requiredQty = Math.max(1, Number(config.offerQuantity) || 1);
    var currency = root.getAttribute("data-currency") || "USD";
    var host = root.querySelector("[data-cgp-acc-groups]");
    var cta = root.querySelector("[data-cgp-acc-cta]");
    var ctaLabel = cta.getAttribute("data-label") || "Add to cart";

    if (config.bundleMode) {
      setupBundle(root, config, host, cta, ctaLabel, currency, offerPercent);
      return;
    }

    // selected: itemProductId -> { variantId, group, base(cents), pct }
    var selected = {};
    var groupBoxes = {}; // group.id -> box element

    // Split the CTA into a main line + a live "you save" sub-line.
    cta.textContent = "";
    var ctaMain = el("span", "cgp-acc__cta-main", ctaLabel);
    var ctaSub = el("span", "cgp-acc__cta-sub", "");
    cta.appendChild(ctaMain);
    cta.appendChild(ctaSub);

    function groupVisible(groupId) {
      var box = groupBoxes[groupId];
      return box && !box.hidden;
    }

    function updateSummary() {
      // Only the cheapest `requiredQty` selected accessories actually discount,
      // and only once at least `requiredQty` are selected (native BxGy rule).
      var bases = [];
      var count = 0;
      Object.keys(selected).forEach(function (pid) {
        var s = selected[pid];
        if (!groupVisible(s.group)) return;
        count++;
        if (s.base) bases.push(s.base);
      });
      var save = 0;
      if (offerPercent > 0 && count >= requiredQty) {
        bases.sort(function (a, b) {
          return a - b;
        });
        for (var i = 0; i < requiredQty && i < bases.length; i++)
          save += Math.round((bases[i] * offerPercent) / 100);
      }
      if (save > 0) {
        ctaSub.textContent =
          count +
          (count === 1 ? " add-on · you save " : " add-ons · you save ") +
          money(save, currency);
        ctaSub.style.display = "";
      } else if (offerPercent > 0 && count > 0 && count < requiredQty) {
        var need = requiredQty - count;
        ctaSub.textContent =
          "Add " +
          need +
          " more add-on" +
          (need === 1 ? "" : "s") +
          " to get " +
          offerPercent +
          "% off";
        ctaSub.style.display = "";
      } else if (count > 0) {
        ctaSub.textContent =
          count + (count === 1 ? " add-on selected" : " add-ons selected");
        ctaSub.style.display = "";
      } else {
        ctaSub.style.display = "none";
      }
    }

    // Show/hide groups based on the selected main variant, then refresh summary.
    function applyVisibility() {
      var current = mainVariantId();
      groups.forEach(function (g) {
        var box = groupBoxes[g.id];
        if (!box) return;
        var only = (g.mainVariantIds || []).map(gidTail);
        box.hidden = only.length > 0 && (!current || only.indexOf(current) < 0);
      });
      updateSummary();
    }

    function renderGroup(group) {
      var box = el("div", "cgp-acc__group");
      groupBoxes[group.id] = box;
      var head = el("div", "cgp-acc__title", group.title || "Accessories");
      box.appendChild(head);
      if (group.subtitle)
        box.appendChild(el("div", "cgp-acc__subtitle", group.subtitle));
      var list = el("div", "cgp-acc__list");
      box.appendChild(list);

      group.accessories.forEach(function (a) {
        var row = el("label", "cgp-acc__row");
        var input = el("input", "cgp-acc__check");
        input.type = group.selectMode === "single" ? "radio" : "checkbox";
        input.name = "cgp-acc-" + group.id;
        input.value = a.productId;
        var media = el("span", "cgp-acc__thumb");
        var infoCol = el("span", "cgp-acc__info");
        var name = el("span", "cgp-acc__name", a.title || a.handle);
        var priceEl = el("span", "cgp-acc__price", "");
        infoCol.appendChild(name);
        infoCol.appendChild(priceEl);
        row.appendChild(input);
        row.appendChild(media);
        row.appendChild(infoCol);
        list.appendChild(row);

        var pct = offerPercent; // single native offer rate for every accessory

        function paintPrice(base) {
          var now = Math.round(base * (1 - pct / 100));
          if (pct > 0) {
            priceEl.innerHTML =
              '<span class="cgp-acc__old">' +
              money(base, currency) +
              "</span>" +
              (pct >= 100
                ? '<span class="cgp-acc__free">FREE</span>'
                : '<span class="cgp-acc__new">' +
                  money(now, currency) +
                  "</span>");
          } else {
            priceEl.textContent = money(base, currency);
          }
        }

        fetchProduct(a.handle).then(function (data) {
          if (!data) {
            row.remove();
            return;
          }
          name.textContent = data.title || a.title;
          var img = data.featured_image || (data.images && data.images[0]);
          if (img) {
            var im = el("img");
            im.src = img;
            media.appendChild(im);
          }
          var offered = offeredVariants(a, data);
          var v = firstAvailable(offered);
          if (!v) {
            row.remove();
            return;
          }
          paintPrice(v.price);
          var currentBase = v.price;
          var getVariantId = function () {
            return v.id;
          };
          // A variant picker when >1 offered.
          if (offered.length > 1) {
            var sel = el("select", "cgp-acc__variant");
            offered.forEach(function (o) {
              var opt = el(
                "option",
                null,
                o.title + (o.available ? "" : " — sold out"),
              );
              opt.value = o.id;
              if (!o.available) opt.disabled = true;
              sel.appendChild(opt);
            });
            sel.value = v.id;
            getVariantId = function () {
              return sel.value;
            };
            sel.addEventListener("change", function (e) {
              e.preventDefault();
              var chosen = offered.filter(function (o) {
                return String(o.id) === String(sel.value);
              })[0];
              currentBase = chosen ? chosen.price : currentBase;
              paintPrice(currentBase);
              if (selected[a.productId]) {
                selected[a.productId].variantId = sel.value;
                selected[a.productId].base = currentBase;
              }
              updateSummary();
            });
            // Clicking the dropdown shouldn't toggle the row's checkbox.
            sel.addEventListener("click", function (e) {
              e.preventDefault();
              e.stopPropagation();
            });
            infoCol.appendChild(sel);
          }

          function markSelected(on) {
            if (on) {
              selected[a.productId] = {
                variantId: getVariantId(),
                group: group.id,
                base: currentBase,
                pct: pct,
              };
              row.classList.add("is-selected");
            } else {
              delete selected[a.productId];
              row.classList.remove("is-selected");
            }
          }

          input.addEventListener("change", function () {
            if (group.selectMode === "single") {
              list
                .querySelectorAll('input[name="cgp-acc-' + group.id + '"]')
                .forEach(function (o) {
                  if (o !== input) {
                    delete selected[o.value];
                    var r = o.closest(".cgp-acc__row");
                    if (r) r.classList.remove("is-selected");
                  }
                });
            }
            markSelected(input.checked);
            updateSummary();
          });
        });
      });
      return box;
    }

    groups.forEach(function (g) {
      if (g.archived || !g.accessories.length) return;
      host.appendChild(renderGroup(g));
    });

    applyVisibility();

    // Re-evaluate group visibility when the theme's main variant changes.
    var form = document.querySelector('form[action*="/cart/add"]');
    if (form) form.addEventListener("change", applyVisibility);
    window.addEventListener("popstate", applyVisibility);
    var lastSearch = window.location.search;
    setInterval(function () {
      if (window.location.search !== lastSearch) {
        lastSearch = window.location.search;
        applyVisibility();
      }
    }, 600);

    cta.hidden = false;
    cta.addEventListener("click", function () {
      var items = [];
      var mv = mainVariantId();
      if (mv) items.push({ id: mv, quantity: 1 });
      Object.keys(selected).forEach(function (pid) {
        var s = selected[pid];
        if (!groupVisible(s.group)) return; // skip hidden groups
        if (s.variantId) items.push({ id: s.variantId, quantity: 1 });
      });
      if (!items.length) return;
      cta.disabled = true;
      addToCart(items, cta);
    });
  }

  function boot() {
    document.querySelectorAll("[data-cgp-acc]").forEach(init);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
