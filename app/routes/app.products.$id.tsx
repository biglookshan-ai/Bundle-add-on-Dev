import {
  useState,
  useCallback,
  useEffect,
  useRef,
  Fragment,
  type ReactNode,
} from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Select,
  Button,
  ButtonGroup,
  Badge,
  Thumbnail,
  Box,
  Banner,
  Divider,
  Checkbox,
  Icon,
} from "@shopify/polaris";
import {
  DeleteIcon,
  PlusIcon,
  ImageIcon,
  ArchiveIcon,
  DragHandleIcon,
} from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  readConfig,
  saveConfig,
  fetchProductPrices,
} from "../models/addon-config.server";
import { reconcileLimitedOffers } from "../models/limited-offer.server";
import {
  newGroupId,
  newOfferId,
  newCode,
  clampPercent,
  displayCode,
  formLabel,
  effectiveAccessoryPercent,
  type AddonConfig,
  type AddonGroup,
  type AddonAccessory,
  type LimitedOffer,
} from "../models/addon-config";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const productId = `gid://shopify/Product/${params.id}`;
  const { product, config } = await readConfig(admin, productId);
  if (!product) {
    throw new Response("Product not found", { status: 404 });
  }
  const ids = [
    product.id,
    ...config.groups.flatMap((g) => g.accessories.map((a) => a.productId)),
  ];
  const { prices, compareAt, variants, info, currency } =
    await fetchProductPrices(admin, ids);
  return { product, config, prices, compareAt, variants, info, currency };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const productId = `gid://shopify/Product/${params.id}`;

  const formData = await request.formData();
  const raw = String(formData.get("config") ?? "");
  let parsed: AddonConfig;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid configuration payload." };
  }

  const { product } = await readConfig(admin, productId);
  if (!product) return { ok: false, error: "Product not found." };

  parsed.groups = (parsed.groups ?? []).map((g) => {
    const base: AddonGroup = {
      ...g,
      code: g.code && g.code.length ? g.code : newCode(),
      discountPercent:
        g.type === "free" ? 100 : clampPercent(g.discountPercent),
    };
    if (g.type === "bundle" && g.limited) {
      const enabled = Boolean(g.limited.enabled);
      base.limited = {
        enabled,
        discountPercent: clampPercent(g.limited.discountPercent),
        mode: g.limited.mode === "end" ? "end" : "revert",
        startsAt:
          typeof g.limited.startsAt === "string" ? g.limited.startsAt : "",
        endsAt: typeof g.limited.endsAt === "string" ? g.limited.endsAt : "",
      };
      if (enabled) {
        base.offerId = g.offerId && g.offerId.length ? g.offerId : newOfferId();
      }
    } else if (g.type !== "bundle") {
      delete base.limited;
      delete base.offerId;
    }
    // A bundle is one discount on the whole kit — drop any stale per-accessory
    // overrides (an add-on-only concept) so the cart/Function match the editor.
    if (g.type === "bundle") {
      base.accessories = base.accessories.map((a) => {
        const { discountPercent: _drop, ...rest } = a;
        return rest;
      });
    }
    return base;
  });

  // Keep each accessory's stored title/handle in sync with Shopify (renames,
  // handle changes) so the editor and the storefront (which fetches by handle)
  // stay correct.
  const accIds = parsed.groups.flatMap((g) =>
    g.accessories.map((a) => a.productId),
  );
  if (accIds.length) {
    const { info } = await fetchProductPrices(admin, accIds);
    parsed.groups = parsed.groups.map((g) => ({
      ...g,
      accessories: g.accessories.map((a) => {
        const m = info[a.productId];
        return m
          ? { ...a, title: m.title || a.title, handle: m.handle || a.handle }
          : a;
      }),
    }));
  }

  const result = await saveConfig(admin, session.shop, product, parsed);
  if (!result.ok) {
    return { ok: false, error: result.userErrors.join("; ") };
  }

  const reconcile = await reconcileLimitedOffers(admin, product, parsed);
  if (reconcile.userErrors.length > 0) {
    return {
      ok: false,
      error: `Saved, but limited offers had issues: ${reconcile.userErrors.join("; ")}`,
    };
  }
  return redirect("/app");
};

const LIMITED_MODE_OPTIONS = [
  { label: "Revert to normal bundle price", value: "revert" },
  { label: "End — hide the bundle (full price)", value: "end" },
];

const TAB_TYPES = ["bundle", "addon", "free"] as const;
type GroupType = (typeof TAB_TYPES)[number];

/** ISO string -> value for a <input type="datetime-local"> in the browser tz. */
function toLocalInput(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** datetime-local value (browser tz) -> ISO-8601 UTC for storage. */
function fromLocalInput(v: string) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

function fmtMoney(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(amount || 0);
  } catch {
    return "$" + (amount || 0).toFixed(2);
  }
}

const DEFAULT_LIMITED: LimitedOffer = {
  enabled: true,
  discountPercent: 30,
  mode: "revert",
  startsAt: "",
  endsAt: "",
};

function blankGroup(type: GroupType): AddonGroup {
  const titles: Record<GroupType, string> = {
    bundle: "Bundle & Save",
    addon: "Add On & Save",
    free: "🎁 Free gift",
  };
  return {
    id: newGroupId(),
    code: newCode(),
    title: titles[type],
    type,
    discountPercent: type === "free" ? 100 : 10,
    accessories: [],
  };
}

function priceOfPicked(p: any): number | null {
  const cand =
    p?.variants?.[0]?.price ??
    p?.priceRange?.minVariantPrice?.amount ??
    p?.priceRangeV2?.minVariantPrice?.amount;
  const n = Number(cand);
  return Number.isFinite(n) ? n : null;
}

export default function ProductConfig() {
  const {
    product,
    config: initial,
    prices,
    compareAt,
    variants,
    info,
    currency,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [groups, setGroups] = useState<AddonGroup[]>(initial.groups);
  const [tab, setTab] = useState(0);
  const [priceMap, setPriceMap] = useState<Record<string, number>>(prices);
  const compareMap = compareAt;
  const [variantMap, setVariantMap] =
    useState<Record<string, { id: string; title: string; price?: number; compareAt?: number }[]>>(variants);
  const [infoMap, setInfoMap] =
    useState<Record<string, { title: string; handle: string; image: string | null }>>(
      info,
    );
  const isSaving = fetcher.state !== "idle";

  // Deep link from the dashboard (#groupId): switch to that group's tab, then
  // scroll + flash it.
  useEffect(() => {
    const hash = decodeURIComponent(window.location.hash.replace("#", ""));
    if (!hash) return;
    const g = groups.find((x) => x.id === hash);
    if (g && !g.archived) setTab(Math.max(0, TAB_TYPES.indexOf(g.type)));
    const t = setTimeout(() => {
      const node = document.getElementById(hash);
      if (!node) return;
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      node.style.transition = "box-shadow .3s";
      node.style.boxShadow = "0 0 0 3px #2b44ff";
      setTimeout(() => (node.style.boxShadow = ""), 1600);
    }, 80);
    return () => clearTimeout(t);
  }, []);

  const addGroup = useCallback((type: GroupType) => {
    setGroups((prev) => [...prev, blankGroup(type)]);
  }, []);

  const updateGroup = useCallback((id: string, patch: Partial<AddonGroup>) => {
    setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  }, []);

  const updateAccessory = useCallback(
    (groupId: string, productId: string, patch: Partial<AddonAccessory>) => {
      setGroups((prev) =>
        prev.map((g) =>
          g.id === groupId
            ? {
                ...g,
                accessories: g.accessories.map((a) =>
                  a.productId === productId ? { ...a, ...patch } : a,
                ),
              }
            : g,
        ),
      );
    },
    [],
  );

  // Deleting a group ARCHIVES it (soft delete) so it can be restored/reused.
  const archiveGroup = useCallback((id: string) => {
    setGroups((prev) =>
      prev.map((g) => (g.id === id ? { ...g, archived: true } : g)),
    );
  }, []);
  const restoreGroup = useCallback((id: string) => {
    setGroups((prev) =>
      prev.map((g) => (g.id === id ? { ...g, archived: false } : g)),
    );
  }, []);
  const deleteGroup = useCallback((id: string) => {
    setGroups((prev) => prev.filter((g) => g.id !== id));
  }, []);

  // Drag-to-reorder groups within the current tab (same type only).
  const dragGroupId = useRef<string | null>(null);
  const moveGroup = useCallback((fromId: string, toId: string) => {
    if (fromId === toId) return;
    setGroups((prev) => {
      const fromGroup = prev.find((g) => g.id === fromId);
      if (!fromGroup) return prev;
      const type = fromGroup.type;
      const ids = prev
        .filter((g) => !g.archived && g.type === type)
        .map((g) => g.id);
      const fromIdx = ids.indexOf(fromId);
      const toIdx = ids.indexOf(toId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      ids.splice(fromIdx, 1);
      ids.splice(toIdx, 0, fromId);
      const byId = new Map(prev.map((g) => [g.id, g]));
      let i = 0;
      // Refill the slots that belong to this tab's type in the new order.
      return prev.map((g) =>
        !g.archived && g.type === type ? (byId.get(ids[i++]) as AddonGroup) : g,
      );
    });
  }, []);

  const pickAccessories = useCallback(
    async (groupId: string, existing: AddonAccessory[]) => {
      const picked = await shopify.resourcePicker({
        type: "product",
        action: "select",
        multiple: true,
        selectionIds: existing.map((a) => ({ id: a.productId })),
      });
      if (!picked) return;
      const prevById = new Map(existing.map((a) => [a.productId, a]));
      const captured: Record<string, number> = {};
      const capturedVars: Record<string, { id: string; title: string; price?: number; compareAt?: number }[]> = {};
      const capturedInfo: Record<
        string,
        { title: string; handle: string; image: string | null }
      > = {};
      const accessories: AddonAccessory[] = picked
        .filter((p: any) => p.id !== product.id)
        .map((p: any) => {
          const price = priceOfPicked(p);
          if (price != null) captured[p.id] = price;
          capturedInfo[p.id] = {
            title: p.title || "",
            handle: p.handle || "",
            image:
              p.images?.[0]?.originalSrc ??
              p.images?.[0]?.src ??
              p.featuredImage?.url ??
              null,
          };
          if (Array.isArray(p.variants) && p.variants.length) {
            capturedVars[p.id] = p.variants
              .filter((v: any) => v?.id)
              .map((v: any) => ({ id: v.id, title: v.title || "" }));
          }
          const prior = prevById.get(p.id);
          const acc: AddonAccessory = {
            productId: p.id,
            handle: p.handle,
            title: p.title,
          };
          if (prior?.discountPercent != null)
            acc.discountPercent = prior.discountPercent;
          if (prior?.variantIds) acc.variantIds = prior.variantIds;
          return acc;
        });
      if (Object.keys(captured).length) {
        setPriceMap((prev) => ({ ...prev, ...captured }));
      }
      if (Object.keys(capturedVars).length) {
        setVariantMap((prev) => ({ ...prev, ...capturedVars }));
      }
      setInfoMap((prev) => ({ ...prev, ...capturedInfo }));
      updateGroup(groupId, { accessories });
    },
    [shopify, product.id, updateGroup],
  );

  const removeAccessory = useCallback((groupId: string, productId: string) => {
    setGroups((prev) =>
      prev.map((g) =>
        g.id === groupId
          ? {
              ...g,
              accessories: g.accessories.filter((a) => a.productId !== productId),
            }
          : g,
      ),
    );
  }, []);

  const save = useCallback(() => {
    const payload: AddonConfig = { version: 1, groups };
    fetcher.submit({ config: JSON.stringify(payload) }, { method: "POST" });
  }, [groups, fetcher]);

  const numericId = product.id.replace("gid://shopify/Product/", "");
  const activeGroups = groups.filter((g) => !g.archived);
  const archivedGroups = groups.filter((g) => g.archived);
  const countOf = (t: GroupType) =>
    activeGroups.filter((g) => g.type === t).length;
  const currentType = TAB_TYPES[tab];
  const tabGroups = activeGroups.filter((g) => g.type === currentType);
  const mainPrice = priceMap[product.id] ?? null;

  const TAB_LABELS = [
    `Bundle (${countOf("bundle")})`,
    `Add-on (${countOf("addon")})`,
    `Free add-on (${countOf("free")})`,
  ];
  const addLabel =
    currentType === "bundle"
      ? "Add bundle"
      : currentType === "free"
        ? "Add free gift"
        : "Add add-on";

  return (
    <Page
      backAction={{ content: "Add-ons", url: "/app" }}
      title={product.title}
      titleMetadata={
        <Badge tone="info">{`${activeGroups.length} group(s)`}</Badge>
      }
      secondaryActions={[
        {
          content: "View product",
          url: `shopify:admin/products/${numericId}`,
          target: "_blank",
        },
      ]}
      primaryAction={{ content: "Save", loading: isSaving, onAction: save }}
    >
      <TitleBar title={`Configure: ${product.title}`} />
      <BlockStack gap="500">
        {fetcher.data?.error && (
          <Banner tone="critical" title="Could not save">
            <p>{fetcher.data.error}</p>
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <ButtonGroup variant="segmented">
                {TAB_LABELS.map((label, i) => (
                  <Button key={i} pressed={tab === i} onClick={() => setTab(i)}>
                    {label}
                  </Button>
                ))}
              </ButtonGroup>

              {tabGroups.length === 0 ? (
                <Card>
                  <BlockStack gap="200" inlineAlign="center">
                    <Text as="p" variant="bodyMd" tone="subdued">
                      No {currentType === "free" ? "free add-ons" : currentType + "s"}{" "}
                      yet.
                    </Text>
                    <Button
                      variant="primary"
                      icon={PlusIcon}
                      onClick={() => addGroup(currentType)}
                    >
                      {addLabel}
                    </Button>
                  </BlockStack>
                </Card>
              ) : (
                tabGroups.map((group) => (
                  <div
                    key={group.id}
                    id={group.id}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragGroupId.current)
                        moveGroup(dragGroupId.current, group.id);
                      dragGroupId.current = null;
                    }}
                  >
                    <GroupCard
                      group={group}
                      prices={priceMap}
                      compareAt={compareMap}
                      variants={variantMap}
                      info={infoMap}
                      mainVariants={variantMap[product.id] || []}
                      mainPrice={mainPrice}
                      mainCompareAt={compareMap[product.id] ?? mainPrice}
                      currency={currency}
                      dragHandle={
                        <span
                          draggable
                          onDragStart={(e) => {
                            dragGroupId.current = group.id;
                            e.dataTransfer.effectAllowed = "move";
                          }}
                          onDragEnd={() => {
                            dragGroupId.current = null;
                          }}
                          style={{ cursor: "grab", display: "inline-flex" }}
                          aria-label="Drag to reorder"
                          title="Drag to reorder"
                        >
                          <Icon source={DragHandleIcon} tone="subdued" />
                        </span>
                      }
                      onChange={(patch) => updateGroup(group.id, patch)}
                      onArchive={() => archiveGroup(group.id)}
                      onPickAccessories={() =>
                        pickAccessories(group.id, group.accessories)
                      }
                      onRemoveAccessory={(pid) => removeAccessory(group.id, pid)}
                      onUpdateAccessory={(pid, patch) =>
                        updateAccessory(group.id, pid, patch)
                      }
                    />
                  </div>
                ))
              )}

              {tabGroups.length > 0 && (
                <InlineStack>
                  <Button icon={PlusIcon} onClick={() => addGroup(currentType)}>
                    {addLabel}
                  </Button>
                </InlineStack>
              )}

              {archivedGroups.length > 0 && (
                <ArchivedSection
                  groups={archivedGroups}
                  onRestore={restoreGroup}
                  onDelete={deleteGroup}
                />
              )}
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  How it works
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  <b>Bundle</b> — a curated set sold together. The main product
                  stays full price; accessories get the discount. Toggle{" "}
                  <b>Limited-time offer</b> for a countdown + deeper price.
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  <b>Add-on</b> — individual extras. <b>Free add-on</b> rides
                  along at 100% off.
                </Text>
                <Divider />
                <Text as="p" variant="bodyMd" tone="subdued">
                  Each accessory can override the group discount — leave its box
                  blank to use the group %. Codes (e.g. <code>BDL-A1B2C3</code>)
                  track each group across the dashboard.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

function GroupCard({
  group,
  prices,
  compareAt,
  variants,
  info,
  mainVariants,
  mainPrice,
  mainCompareAt,
  currency,
  dragHandle,
  onChange,
  onArchive,
  onPickAccessories,
  onRemoveAccessory,
  onUpdateAccessory,
}: {
  group: AddonGroup;
  prices: Record<string, number>;
  compareAt: Record<string, number>;
  variants: Record<string, { id: string; title: string; price?: number; compareAt?: number }[]>;
  info: Record<string, { title: string; handle: string; image: string | null }>;
  mainVariants: { id: string; title: string; price?: number; compareAt?: number }[];
  mainPrice: number | null;
  mainCompareAt: number | null;
  currency: string;
  dragHandle: ReactNode;
  onChange: (patch: Partial<AddonGroup>) => void;
  onArchive: () => void;
  onPickAccessories: () => void;
  onRemoveAccessory: (productId: string) => void;
  onUpdateAccessory: (productId: string, patch: Partial<AddonAccessory>) => void;
}) {
  // Drag-to-reorder accessories within this group.
  const dragAccId = useRef<string | null>(null);
  const moveAccessory = (fromPid: string, toPid: string) => {
    if (fromPid === toPid) return;
    const arr = group.accessories.slice();
    const fromIdx = arr.findIndex((a) => a.productId === fromPid);
    const toIdx = arr.findIndex((a) => a.productId === toPid);
    if (fromIdx < 0 || toIdx < 0) return;
    const [m] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, m);
    onChange({ accessories: arr });
  };

  const isFree = group.type === "free";
  const isBundle = group.type === "bundle";
  const limitedOn = isBundle && Boolean(group.limited?.enabled);

  // Bundle = ONE discount on the whole kit. Each line carries its TRUE original
  // (compare-at, `orig`) and its current Shopify selling price (`now`). The
  // representative is the FIRST variant actually OFFERED to the customer (so a
  // cheaper, non-offered variant doesn't skew the estimate) — matching what the
  // storefront defaults to. Falls back to the product-level price if needed.
  const repFromOffered = (
    vs: { id: string; title: string; price?: number; compareAt?: number }[],
    offeredIds: string[] | undefined,
    fallbackNow: number,
    fallbackOrig: number,
  ): { now: number; orig: number } => {
    const offered =
      offeredIds && offeredIds.length
        ? vs.filter((v) => offeredIds.includes(v.id))
        : vs;
    const v = offered[0] || vs[0];
    if (v && typeof v.price === "number") {
      return { now: v.price, orig: v.compareAt ?? v.price };
    }
    return { now: fallbackNow, orig: fallbackOrig };
  };
  const haveAllPrices = group.accessories.every(
    (a) => prices[a.productId] != null,
  );
  const mainRep = repFromOffered(
    mainVariants,
    group.mainVariantIds,
    mainPrice ?? 0,
    mainCompareAt ?? mainPrice ?? 0,
  );
  const bundleLines: { label: string; orig: number; now: number }[] = [
    ...(mainPrice != null
      ? [{ label: "Main product", orig: mainRep.orig, now: mainRep.now }]
      : []),
    ...group.accessories.map((a) => {
      const fb = prices[a.productId] ?? 0;
      const rep = repFromOffered(
        variants[a.productId] || [],
        a.variantIds,
        fb,
        compareAt[a.productId] ?? fb,
      );
      return {
        label: info[a.productId]?.title || a.title || a.handle,
        orig: rep.orig,
        now: rep.now,
      };
    }),
  ];
  const bundleTotalNow = bundleLines.reduce((s, l) => s + l.now, 0);

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            {dragHandle}
            <Badge tone={limitedOn ? "attention" : "info"}>
              {displayCode(group)}
            </Badge>
            <Text as="span" variant="bodySm" tone="subdued">
              {formLabel(group)}
            </Text>
          </InlineStack>
          <Button
            icon={ArchiveIcon}
            variant="tertiary"
            onClick={onArchive}
            accessibilityLabel="Archive group"
          >
            Archive
          </Button>
        </InlineStack>

        <InlineStack gap="400" wrap={false} blockAlign="start">
          <Box width={isBundle ? "100%" : "65%"}>
            <TextField
              label={isFree ? "Section title" : "Card / tab title"}
              autoComplete="off"
              value={group.title}
              onChange={(v) => onChange({ title: v })}
              helpText={
                isFree
                  ? "Heading for the gift section, e.g. “🎁 Free gift”."
                  : isBundle
                    ? "Shown as the bundle card name, e.g. “Advanced Kit”."
                    : "Shown as the tab label, e.g. “T-Series Lenses”."
              }
            />
          </Box>
          {!isBundle && (
            <Box width="35%">
              <TextField
                label="Group discount %"
                type="number"
                min={0}
                max={100}
                autoComplete="off"
                suffix="%"
                disabled={isFree}
                value={String(isFree ? 100 : group.discountPercent)}
                onChange={(v) => onChange({ discountPercent: clampPercent(v) })}
                helpText={
                  isFree
                    ? "Free gifts are 100% off."
                    : "Default for accessories without their own %."
                }
              />
            </Box>
          )}
        </InlineStack>

        {!isFree && mainVariants.length > 1 && (
          <Box background="bg-surface-secondary" padding="300" borderRadius="200">
            <BlockStack gap="150">
              <Text as="span" variant="bodySm" tone="subdued">
                {isBundle ? "Main product variants in this bundle" : "Show this add-on for main variants"}{" "}
                ({group.mainVariantIds?.length ?? mainVariants.length}/
                {mainVariants.length})
              </Text>
              <InlineStack gap="150" wrap>
                {mainVariants.map((v) => {
                  const current =
                    group.mainVariantIds && group.mainVariantIds.length
                      ? group.mainVariantIds
                      : mainVariants.map((x) => x.id);
                  const on = current.includes(v.id);
                  return (
                    <Button
                      key={v.id}
                      size="micro"
                      pressed={on}
                      onClick={() => {
                        const next = on
                          ? current.filter((x) => x !== v.id)
                          : [...current, v.id];
                        if (next.length === 0) return;
                        onChange({
                          mainVariantIds:
                            next.length === mainVariants.length
                              ? undefined
                              : next,
                        });
                      }}
                    >
                      {v.title}
                    </Button>
                  );
                })}
              </InlineStack>
              <Text as="span" variant="bodySm" tone="subdued">
                {isBundle
                  ? "Offered as the main-product options inside the bundle — the customer picks one (synced with the product page selector)."
                  : "This add-on group only shows when the selected main variant is one of these — otherwise it's hidden."}
              </Text>
            </BlockStack>
          </Box>
        )}

        {!isBundle && (
          <Box background="bg-surface-secondary" padding="300" borderRadius="200">
            <Checkbox
              label="Hide items when sold out"
              helpText="Once an item has no available stock it disappears from the storefront; when every item is sold out the whole group hides."
              checked={!!group.hideWhenSoldOut}
              onChange={(v) => onChange({ hideWhenSoldOut: v })}
            />
          </Box>
        )}

        <Divider />

        <InlineStack align="space-between" blockAlign="center">
          <Text as="span" variant="headingSm">
            Accessories ({group.accessories.length})
          </Text>
          <Button onClick={onPickAccessories}>Select accessories</Button>
        </InlineStack>

        {group.accessories.length > 0 ? (
          <BlockStack gap="200">
            {group.accessories.map((a) => {
              const accVariants = variants[a.productId] || [];
              const offeredIds =
                a.variantIds && a.variantIds.length
                  ? a.variantIds
                  : accVariants.map((v) => v.id);
              // Show the FIRST offered variant's price (what the storefront
              // defaults to), not the cheapest non-offered one.
              const repV =
                accVariants.find((v) => offeredIds.includes(v.id)) ||
                accVariants[0];
              const price =
                typeof repV?.price === "number"
                  ? repV.price
                  : prices[a.productId];
              const pct = effectiveAccessoryPercent(group, a);
              const now = price != null ? price * (1 - pct / 100) : null;
              const toggleVariant = (vid: string) => {
                const next = offeredIds.includes(vid)
                  ? offeredIds.filter((x) => x !== vid)
                  : [...offeredIds, vid];
                if (next.length === 0) return; // keep at least one offered
                onUpdateAccessory(a.productId, {
                  variantIds:
                    next.length === accVariants.length ? undefined : next,
                });
              };
              return (
                <div
                  key={a.productId}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragAccId.current)
                      moveAccessory(dragAccId.current, a.productId);
                    dragAccId.current = null;
                  }}
                >
                  <BlockStack gap="150">
                    <InlineStack
                      align="space-between"
                      blockAlign="center"
                      wrap={false}
                    >
                      <InlineStack gap="200" blockAlign="center">
                        <span
                          draggable
                          onDragStart={(e) => {
                            dragAccId.current = a.productId;
                            e.dataTransfer.effectAllowed = "move";
                          }}
                          onDragEnd={() => {
                            dragAccId.current = null;
                          }}
                          style={{ cursor: "grab", display: "inline-flex" }}
                          title="Drag to reorder"
                        >
                          <Icon source={DragHandleIcon} tone="subdued" />
                        </span>
                        <Thumbnail
                          source={info[a.productId]?.image || ImageIcon}
                          alt={info[a.productId]?.title || a.title}
                          size="small"
                        />
                      <BlockStack gap="050">
                        <Text as="span" variant="bodyMd">
                          {info[a.productId]?.title || a.title || a.handle}
                        </Text>
                        {price != null && (
                          <Text as="span" variant="bodySm" tone="subdued">
                            {fmtMoney(price, currency)}
                          </Text>
                        )}
                      </BlockStack>
                    </InlineStack>

                      <Button
                        icon={DeleteIcon}
                        variant="tertiary"
                        tone="critical"
                        accessibilityLabel={`Remove ${a.title}`}
                        onClick={() => onRemoveAccessory(a.productId)}
                      />
                    </InlineStack>

                    {isFree ? (
                      <InlineStack align="end">
                        <Text as="span" variant="bodyMd" tone="subdued">
                          FREE
                        </Text>
                      </InlineStack>
                    ) : isBundle ? null : price != null ? (
                      <Box paddingInlineStart="800">
                        <InlineStack
                          align="space-between"
                          blockAlign="end"
                          wrap
                        >
                          <DiscountCalc
                            price={price}
                            percent={pct}
                            onChangePercent={(p) =>
                              onUpdateAccessory(a.productId, {
                                discountPercent: p,
                              })
                            }
                          />
                          {a.discountPercent != null && (
                            <Button
                              variant="plain"
                              onClick={() =>
                                onUpdateAccessory(a.productId, {
                                  discountPercent: undefined,
                                })
                              }
                            >
                              {`Reset to group ${pctStr(group.discountPercent)}%`}
                            </Button>
                          )}
                        </InlineStack>
                      </Box>
                    ) : (
                      <Box paddingInlineStart="800" width="120px">
                        <TextField
                          label="Discount %"
                          type="number"
                          min={0}
                          max={100}
                          suffix="%"
                          autoComplete="off"
                          placeholder={String(group.discountPercent)}
                          value={
                            a.discountPercent == null
                              ? ""
                              : String(a.discountPercent)
                          }
                          onChange={(v) =>
                            onUpdateAccessory(a.productId, {
                              discountPercent:
                                v === "" ? undefined : clampPercent(v),
                            })
                          }
                        />
                      </Box>
                    )}

                  {accVariants.length > 1 && (
                    <Box paddingInlineStart="800">
                      <BlockStack gap="100">
                        <Text as="span" variant="bodySm" tone="subdued">
                          Variants offered to the customer ({offeredIds.length}/
                          {accVariants.length})
                        </Text>
                        <InlineStack gap="150" wrap>
                          {accVariants.map((v) => (
                            <Button
                              key={v.id}
                              size="micro"
                              pressed={offeredIds.includes(v.id)}
                              onClick={() => toggleVariant(v.id)}
                            >
                              {v.title}
                            </Button>
                          ))}
                        </InlineStack>
                      </BlockStack>
                    </Box>
                  )}
                  </BlockStack>
                </div>
              );
            })}
          </BlockStack>
        ) : (
          <Text as="p" variant="bodyMd" tone="subdued">
            No accessories in this group yet.
          </Text>
        )}

        {isBundle && group.accessories.length > 0 && haveAllPrices && (
          <BundleTotals
            group={group}
            lines={bundleLines}
            currency={currency}
            onChange={onChange}
          />
        )}

        {isBundle && (
          <LimitedOfferCard
            group={group}
            totalNow={bundleTotalNow}
            haveTotal={haveAllPrices}
            currency={currency}
            onChange={onChange}
          />
        )}
      </BlockStack>
    </Card>
  );
}

/**
 * Limited-time offer — a DEEPER whole-kit discount that runs on a timer. Same
 * three-way calculator as the normal bundle price (on the current total), plus
 * the mode + start/end window. Server-enforced via the time-gated discount node.
 */
function LimitedOfferCard({
  group,
  totalNow,
  haveTotal,
  currency,
  onChange,
}: {
  group: AddonGroup;
  totalNow: number;
  haveTotal: boolean;
  currency: string;
  onChange: (patch: Partial<AddonGroup>) => void;
}) {
  const limited = group.limited;
  const limitedOn = Boolean(limited?.enabled);
  const ended =
    limitedOn && !!limited?.endsAt && Date.parse(limited.endsAt) < Date.now();
  const patchLimited = (patch: Partial<LimitedOffer>) =>
    onChange({
      limited: { ...(limited ?? DEFAULT_LIMITED), ...patch },
      offerId: group.offerId || newOfferId(),
    });
  const deepPct = clampPercent(limited?.discountPercent ?? 0);
  return (
    <Box background="bg-surface-secondary" padding="300" borderRadius="200">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Checkbox
            label="Limited-time offer (countdown + deeper price)"
            checked={limitedOn}
            onChange={(checked) =>
              onChange(
                checked
                  ? {
                      limited: { ...(limited ?? DEFAULT_LIMITED), enabled: true },
                      offerId: group.offerId || newOfferId(),
                    }
                  : {
                      limited: limited
                        ? { ...limited, enabled: false }
                        : { ...DEFAULT_LIMITED, enabled: false },
                    },
              )
            }
          />
          {limitedOn &&
            (ended ? (
              <Badge tone="critical">Ended</Badge>
            ) : (
              <Badge tone="success">Active</Badge>
            ))}
        </InlineStack>

        {limitedOn && (
          <>
            {ended && (
              <Banner tone="warning">
                <p>
                  This promotion has ended — the bundle is now at its
                  {limited?.mode === "end"
                    ? " normal full price (hidden on the storefront)."
                    : " normal price."}{" "}
                  Set a new end date below to start a fresh promotion.
                </p>
                <Box paddingBlockStart="200">
                  <Button
                    onClick={() => patchLimited({ startsAt: "", endsAt: "" })}
                  >
                    Start a new promotion
                  </Button>
                </Box>
              </Banner>
            )}
            <BlockStack gap="100">
              <Text as="span" variant="headingSm">
                Deal price — deeper bundle discount while the timer runs
              </Text>
              {haveTotal ? (
                <DiscountCalc
                  price={totalNow}
                  percent={deepPct}
                  onChangePercent={(p) =>
                    patchLimited({ discountPercent: clampPercent(p) })
                  }
                />
              ) : (
                <Box width="110px">
                  <TextField
                    label="Deal discount"
                    type="text"
                    inputMode="decimal"
                    suffix="%"
                    autoComplete="off"
                    disabled={ended}
                    value={pctStr(deepPct)}
                    onChange={(v) =>
                      patchLimited({ discountPercent: clampPercent(v) })
                    }
                  />
                </Box>
              )}
            </BlockStack>
            <InlineStack gap="400" wrap blockAlign="start">
              <Box minWidth="220px">
                <Select
                  label="When the timer ends"
                  options={LIMITED_MODE_OPTIONS}
                  disabled={ended}
                  value={limited?.mode ?? "revert"}
                  onChange={(v) => patchLimited({ mode: v as "revert" | "end" })}
                />
              </Box>
              <Box minWidth="220px">
                <TextField
                  label="Starts"
                  type={"datetime-local" as any}
                  autoComplete="off"
                  disabled={ended}
                  value={toLocalInput(limited?.startsAt)}
                  onChange={(v) => patchLimited({ startsAt: fromLocalInput(v) })}
                  helpText="Leave blank to start immediately."
                />
              </Box>
              <Box minWidth="220px">
                <TextField
                  label="Ends"
                  type={"datetime-local" as any}
                  autoComplete="off"
                  value={toLocalInput(limited?.endsAt)}
                  onChange={(v) => patchLimited({ endsAt: fromLocalInput(v) })}
                  helpText="Server-enforced — reverts even for unpaid carts."
                />
              </Box>
            </InlineStack>
          </>
        )}
      </BlockStack>
    </Box>
  );
}

/** Percent formatted without trailing zeros: 50, 52.6, 33.33. */
function pctStr(p: number) {
  return String(Math.round(p * 100) / 100);
}

/**
 * Three linked fields — New price / Disc % / Save — for one price. Editing any
 * one updates the other two; the source of truth is always the PERCENT (so it
 * tracks Shopify price changes). The field being typed in keeps the raw text
 * until blur so it doesn't fight the user as it reformats.
 */
function DiscountCalc({
  price,
  percent,
  onChangePercent,
}: {
  price: number;
  percent: number;
  onChangePercent: (pct: number) => void;
}) {
  type Field = "price" | "disc" | "save";
  const [active, setActive] = useState<Field | null>(null);
  const [draft, setDraft] = useState("");
  const newPrice = price * (1 - percent / 100);
  const save = price - newPrice;
  const disp: Record<Field, string> = {
    price: newPrice.toFixed(2),
    disc: pctStr(percent),
    save: save.toFixed(2),
  };
  const valOf = (f: Field) => (active === f ? draft : disp[f]);
  const onF = (f: Field, v: string) => {
    setActive(f);
    setDraft(v);
    if (v === "") return;
    const num = Number(v);
    if (!Number.isFinite(num)) return;
    const clampAmt = (n: number) => Math.min(Math.max(n, 0), price);
    let pct = percent;
    if (f === "price") pct = price > 0 ? ((price - clampAmt(num)) / price) * 100 : 0;
    else if (f === "save") pct = price > 0 ? (clampAmt(num) / price) * 100 : 0;
    else pct = num;
    onChangePercent(clampPercent(pct));
  };
  const onBlur = () => setActive(null);
  return (
    <InlineStack gap="200" blockAlign="end" wrap>
      <Box width="120px">
        <TextField
          label="New price"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={valOf("price")}
          onChange={(v) => onF("price", v)}
          onBlur={onBlur}
        />
      </Box>
      <Box width="110px">
        <TextField
          label="Discount"
          type="text"
          inputMode="decimal"
          suffix="%"
          autoComplete="off"
          value={valOf("disc")}
          onChange={(v) => onF("disc", v)}
          onBlur={onBlur}
        />
      </Box>
      <Box width="120px">
        <TextField
          label="Save"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={valOf("save")}
          onChange={(v) => onF("save", v)}
          onBlur={onBlur}
        />
      </Box>
    </InlineStack>
  );
}

/**
 * Bundle pricing — ONE discount on the whole kit. A line per part shows its
 * true original (MSRP / compare-at), its current selling price, and any
 * pre-existing sale. Below: the MSRP total, the current total, then a single
 * three-way calculator that sets the bundle discount (applied on top of the
 * current selling prices, to the main and every accessory).
 */
function BundleTotals({
  group,
  lines,
  currency,
  onChange,
}: {
  group: AddonGroup;
  lines: { label: string; orig: number; now: number }[];
  currency: string;
  onChange: (patch: Partial<AddonGroup>) => void;
}) {
  const totalOrig = lines.reduce((s, l) => s + l.orig, 0); // Σ MSRP
  const totalNow = lines.reduce((s, l) => s + l.now, 0); // Σ current selling
  const preOffPct = totalOrig > 0 ? ((totalOrig - totalNow) / totalOrig) * 100 : 0;
  const pct = clampPercent(group.discountPercent); // our bundle discount
  const bundlePrice = totalNow * (1 - pct / 100);
  const bundleSave = totalNow - bundlePrice;
  const cell = (text: string, strong?: boolean) => (
    <Text as="span" variant={strong ? "bodyMd" : "bodySm"} tone={strong ? undefined : "subdued"}>
      {text}
    </Text>
  );
  const totalRow = (label: string, value: string, strong?: boolean) => (
    <InlineStack align="space-between" blockAlign="center">
      {cell(label, strong)}
      {cell(value, strong)}
    </InlineStack>
  );
  return (
    <Box background="bg-surface-secondary" padding="300" borderRadius="200">
      <BlockStack gap="200">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto auto auto",
            columnGap: "20px",
            rowGap: "6px",
            alignItems: "baseline",
          }}
        >
          <Text as="span" variant="bodySm" tone="subdued">
            Product
          </Text>
          <Text as="span" variant="bodySm" tone="subdued" alignment="end">
            Original
          </Text>
          <Text as="span" variant="bodySm" tone="subdued" alignment="end">
            Now
          </Text>
          <Text as="span" variant="bodySm" tone="subdued" alignment="end">
            Already off
          </Text>
          {lines.map((l, i) => {
            const off = l.orig > l.now ? ((l.orig - l.now) / l.orig) * 100 : 0;
            return (
              <Fragment key={i}>
                <Text as="span" variant="bodySm">
                  {l.label}
                </Text>
                <Text as="span" variant="bodySm" tone="subdued" alignment="end">
                  {fmtMoney(l.orig, currency)}
                </Text>
                <Text as="span" variant="bodySm" alignment="end">
                  {fmtMoney(l.now, currency)}
                </Text>
                <Text as="span" variant="bodySm" tone="subdued" alignment="end">
                  {off > 0 ? `${pctStr(off)}%` : "—"}
                </Text>
              </Fragment>
            );
          })}
        </div>

        <Divider />

        {totalRow("Original total (MSRP)", fmtMoney(totalOrig, currency))}
        {totalRow(
          preOffPct > 0.05
            ? `Current total (already ${pctStr(preOffPct)}% off)`
            : "Current total",
          fmtMoney(totalNow, currency),
          true,
        )}

        <Divider />

        <BlockStack gap="100">
          <Text as="span" variant="headingSm">
            Buy together — one bundle discount
          </Text>
          <DiscountCalc
            price={totalNow}
            percent={pct}
            onChangePercent={(p) => onChange({ discountPercent: clampPercent(p) })}
          />
        </BlockStack>

        {totalRow("Bundle price", fmtMoney(bundlePrice, currency), true)}
        {totalRow("Bundle discount", `${pctStr(pct)}%`)}
        {totalRow("You save", fmtMoney(bundleSave, currency))}
        <Text as="span" variant="bodySm" tone="subdued">
          The bundle discount applies on top of current prices — to the main and
          every accessory.
        </Text>
      </BlockStack>
    </Box>
  );
}

function ArchivedSection({
  groups,
  onRestore,
  onDelete,
}: {
  groups: AddonGroup[];
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack gap="200" blockAlign="center">
          <ArchiveIcon width={18} height={18} />
          <Text as="h3" variant="headingSm">
            Archived ({groups.length})
          </Text>
        </InlineStack>
        <Text as="p" variant="bodySm" tone="subdued">
          Archived groups are hidden from the storefront and grant no discount.
          Restore one to use it again, or delete it permanently. Changes apply
          when you Save.
        </Text>
        <Divider />
        <BlockStack gap="200">
          {groups.map((group) => (
            <InlineStack
              key={group.id}
              align="space-between"
              blockAlign="center"
              wrap={false}
            >
              <InlineStack gap="200" blockAlign="center">
                <Badge>{displayCode(group)}</Badge>
                <Text as="span" variant="bodyMd">
                  {group.title || "Untitled"}
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  {formLabel(group)} · {group.accessories.length} item
                  {group.accessories.length === 1 ? "" : "s"}
                </Text>
              </InlineStack>
              <InlineStack gap="200">
                <Button onClick={() => onRestore(group.id)}>Restore</Button>
                <Button
                  icon={DeleteIcon}
                  tone="critical"
                  variant="tertiary"
                  accessibilityLabel="Delete permanently"
                  onClick={() => onDelete(group.id)}
                >
                  Delete
                </Button>
              </InlineStack>
            </InlineStack>
          ))}
        </BlockStack>
      </BlockStack>
    </Card>
  );
}
