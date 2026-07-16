/* Accessory offers — Function-FREE storefront (optional accessories + free
 * gifts). Native "Buy X Get Y" discounts (created by the app) do all the pricing
 * in the cart; this script only renders the selectors and adds the chosen
 * products to the cart. Works on any Shopify plan. */
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
  function mainVariantId(root) {
    var input =
      document.querySelector('form[action*="/cart/add"] [name="id"]') ||
      document.querySelector('[name="id"]');
    if (input && input.value) return input.value;
    var m = window.location.search.match(/[?&]variant=(\d+)/);
    return m ? m[1] : null;
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
    var currency = root.getAttribute("data-currency") || "USD";
    var host = root.querySelector("[data-cgp-acc-groups]");
    var cta = root.querySelector("[data-cgp-acc-cta]");

    // selected: itemProductId -> { variantId } ; free items default to selected.
    var selected = {};

    function renderGroup(group) {
      var box = el("div", "cgp-acc__group");
      box.style.cssText = "margin:14px 0;";
      var head = el("div", "cgp-acc__title", group.title || "Accessories");
      head.style.cssText = "font-weight:600;margin-bottom:8px;";
      box.appendChild(head);

      group.accessories.forEach(function (a) {
        var row = el("label", "cgp-acc__row");
        row.style.cssText =
          "display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid #eee;cursor:pointer;";
        var input = el("input");
        input.type = group.selectMode === "single" ? "radio" : "checkbox";
        input.name = "cgp-acc-" + group.id;
        input.value = a.productId;
        var media = el("span", "cgp-acc__thumb");
        media.style.cssText =
          "width:44px;height:44px;flex:0 0 auto;background:#f4f4f4;border-radius:6px;overflow:hidden;";
        var infoCol = el("span");
        infoCol.style.cssText = "flex:1;";
        var name = el("span", "cgp-acc__name", a.title || a.handle);
        name.style.cssText = "display:block;";
        var priceEl = el("span", "cgp-acc__price", "");
        priceEl.style.cssText = "display:block;font-size:13px;opacity:.8;";
        infoCol.appendChild(name);
        infoCol.appendChild(priceEl);
        row.appendChild(input);
        row.appendChild(media);
        row.appendChild(infoCol);
        box.appendChild(row);

        var pct = group.type === "free" ? 100 : Number(a.discountPercent) || 0;

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
            im.style.cssText = "width:100%;height:100%;object-fit:cover;";
            media.appendChild(im);
          }
          var offered = offeredVariants(a, data);
          var v = firstAvailable(offered);
          if (!v) {
            row.remove();
            return;
          }
          var base = v.price;
          var now = Math.round(base * (1 - pct / 100));
          if (pct > 0) {
            priceEl.innerHTML =
              '<s style="opacity:.6">' +
              money(base, currency) +
              "</s> " +
              '<b style="color:#e0435c">' +
              (pct >= 100 ? "FREE" : money(now, currency)) +
              "</b>";
          } else {
            priceEl.textContent = money(base, currency);
          }
          // A variant picker when >1 offered.
          if (offered.length > 1) {
            var sel = el("select");
            sel.style.cssText = "margin-top:4px;";
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
              if (selected[a.productId])
                selected[a.productId].variantId = sel.value;
            });
            infoCol.appendChild(sel);
            v = { id: sel.value };
          }
          // Free items default to selected.
          if (group.type === "free") {
            input.checked = true;
            selected[a.productId] = { variantId: v.id, group: group.id };
          }
          input.__variantGetter = function () {
            return offered.length > 1
              ? infoCol.querySelector("select").value
              : v.id;
          };
        });

        input.addEventListener("change", function () {
          if (group.selectMode === "single") {
            // Uncheck others in the group.
            box.querySelectorAll('input[name="cgp-acc-' + group.id + '"]').forEach(
              function (o) {
                if (o !== input)
                  delete selected[o.value];
              },
            );
          }
          if (input.checked) {
            selected[a.productId] = {
              variantId: input.__variantGetter ? input.__variantGetter() : null,
              group: group.id,
            };
          } else {
            delete selected[a.productId];
          }
        });
      });
      return box;
    }

    groups.forEach(function (g) {
      if (g.archived || !g.accessories.length) return;
      host.appendChild(renderGroup(g));
    });

    cta.hidden = false;
    cta.addEventListener("click", function () {
      var items = [];
      var mv = mainVariantId(root);
      if (mv) items.push({ id: mv, quantity: 1 });
      Object.keys(selected).forEach(function (pid) {
        var s = selected[pid];
        var vid = s.variantId;
        if (vid) items.push({ id: vid, quantity: 1 });
      });
      if (!items.length) return;
      cta.disabled = true;
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
          cta.disabled = false;
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
          cta.disabled = false;
        });
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
