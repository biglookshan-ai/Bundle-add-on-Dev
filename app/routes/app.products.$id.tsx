import { useState, useCallback, useEffect, useRef, type ReactNode } from "react";
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
  const { prices, variants, info, currency } = await fetchProductPrices(
    admin,
    ids,
  );
  return { product, config, prices, variants, info, currency };
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
    variants,
    info,
    currency,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [groups, setGroups] = useState<AddonGroup[]>(initial.groups);
  const [tab, setTab] = useState(0);
  const [priceMap, setPriceMap] = useState<Record<string, number>>(prices);
  const [variantMap, setVariantMap] =
    useState<Record<string, { id: string; title: string }[]>>(variants);
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
      const capturedVars: Record<string, { id: string; title: string }[]> = {};
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
                      variants={variantMap}
                      info={infoMap}
                      mainVariants={variantMap[product.id] || []}
                      mainPrice={mainPrice}
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
  variants,
  info,
  mainVariants,
  mainPrice,
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
  variants: Record<string, { id: string; title: string }[]>;
  info: Record<string, { title: string; handle: string; image: string | null }>;
  mainVariants: { id: string; title: string }[];
  mainPrice: number | null;
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
  const limited = group.limited;
  const limitedOn = isBundle && Boolean(limited?.enabled);
  const ended =
    limitedOn && !!limited?.endsAt && Date.parse(limited.endsAt) < Date.now();

  const patchLimited = (patch: Partial<LimitedOffer>) =>
    onChange({
      limited: { ...(limited ?? DEFAULT_LIMITED), ...patch },
      offerId: group.offerId || newOfferId(),
    });

  // Bundle totals (main full price + discounted accessories).
  const accOrig = group.accessories.reduce(
    (s, a) => s + (prices[a.productId] ?? 0),
    0,
  );
  const accNew = group.accessories.reduce((s, a) => {
    const p = prices[a.productId] ?? 0;
    return s + p * (1 - effectiveAccessoryPercent(group, a) / 100);
  }, 0);
  const haveAllPrices = group.accessories.every(
    (a) => prices[a.productId] != null,
  );

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
          <Box width="65%">
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
          <Box width="35%">
            <TextField
              label={isBundle ? "Group discount %" : "Group discount %"}
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
        </InlineStack>

        {isBundle && (
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
                            limited: {
                              ...(limited ?? DEFAULT_LIMITED),
                              enabled: true,
                            },
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
                  <InlineStack gap="400" wrap={false} blockAlign="start">
                    <Box width="50%">
                      <TextField
                        label="Offer discount %"
                        type="number"
                        min={0}
                        max={100}
                        suffix="%"
                        autoComplete="off"
                        disabled={ended}
                        value={String(limited?.discountPercent ?? 0)}
                        onChange={(v) =>
                          patchLimited({ discountPercent: clampPercent(v) })
                        }
                        helpText="Deep price (whole bundle) while the timer runs."
                      />
                    </Box>
                    <Box width="50%">
                      <Select
                        label="When the timer ends"
                        options={LIMITED_MODE_OPTIONS}
                        disabled={ended}
                        value={limited?.mode ?? "revert"}
                        onChange={(v) => patchLimited({ mode: v as "revert" | "end" })}
                      />
                    </Box>
                  </InlineStack>
                  <InlineStack gap="400" wrap={false} blockAlign="start">
                    <Box width="50%">
                      <TextField
                        label="Starts"
                        type={"datetime-local" as any}
                        autoComplete="off"
                        disabled={ended}
                        value={toLocalInput(limited?.startsAt)}
                        onChange={(v) =>
                          patchLimited({ startsAt: fromLocalInput(v) })
                        }
                        helpText="Leave blank to start immediately."
                      />
                    </Box>
                    <Box width="50%">
                      <TextField
                        label="Ends"
                        type={"datetime-local" as any}
                        autoComplete="off"
                        value={toLocalInput(limited?.endsAt)}
                        onChange={(v) => patchLimited({ endsAt: fromLocalInput(v) })}
                        helpText="Server-enforced — reverts here even for unpaid carts."
                      />
                    </Box>
                  </InlineStack>
                </>
              )}
            </BlockStack>
          </Box>
        )}

        {isBundle && mainVariants.length > 1 && (
          <Box background="bg-surface-secondary" padding="300" borderRadius="200">
            <BlockStack gap="150">
              <Text as="span" variant="bodySm" tone="subdued">
                Main product variants in this bundle (
                {group.mainVariantIds?.length ?? mainVariants.length}/
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
                Picking this bundle on the storefront switches the main product
                to the matching variant (image + price).
              </Text>
            </BlockStack>
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
              const price = prices[a.productId];
              const pct = effectiveAccessoryPercent(group, a);
              const now = price != null ? price * (1 - pct / 100) : null;
              const accVariants = variants[a.productId] || [];
              const offeredIds =
                a.variantIds && a.variantIds.length
                  ? a.variantIds
                  : accVariants.map((v) => v.id);
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

                    <InlineStack gap="300" blockAlign="center">
                      {!isFree && (
                        <Box width="92px">
                          <TextField
                            label="Override %"
                            labelHidden
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
                      <Box minWidth="78px">
                        <Text as="span" variant="bodyMd" alignment="end">
                          {isFree
                            ? "FREE"
                            : now != null
                              ? fmtMoney(now, currency)
                              : "—"}
                        </Text>
                      </Box>
                      <Button
                        icon={DeleteIcon}
                        variant="tertiary"
                        tone="critical"
                        accessibilityLabel={`Remove ${a.title}`}
                        onClick={() => onRemoveAccessory(a.productId)}
                      />
                    </InlineStack>
                  </InlineStack>

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
            mainPrice={mainPrice}
            accOrig={accOrig}
            accNew={accNew}
            currency={currency}
          />
        )}
      </BlockStack>
    </Card>
  );
}

function BundleTotals({
  mainPrice,
  accOrig,
  accNew,
  currency,
}: {
  mainPrice: number | null;
  accOrig: number;
  accNew: number;
  currency: string;
}) {
  const main = mainPrice ?? 0;
  const orig = main + accOrig;
  const next = main + accNew;
  const saved = orig - next;
  const pct = orig > 0 ? Math.round((saved / orig) * 100) : 0;
  return (
    <Box background="bg-surface-secondary" padding="300" borderRadius="200">
      <BlockStack gap="150">
        {mainPrice != null && (
          <InlineStack align="space-between">
            <Text as="span" variant="bodySm" tone="subdued">
              Main product (full price)
            </Text>
            <Text as="span" variant="bodySm" tone="subdued">
              {fmtMoney(main, currency)}
            </Text>
          </InlineStack>
        )}
        <InlineStack align="space-between">
          <Text as="span" variant="bodySm" tone="subdued">
            Accessories
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            {fmtMoney(accNew, currency)}
          </Text>
        </InlineStack>
        <Divider />
        <InlineStack align="space-between" blockAlign="center">
          <Text as="span" variant="headingSm">
            Bundle total
          </Text>
          <InlineStack gap="200" blockAlign="center">
            {saved > 0 && (
              <Text as="span" variant="bodySm" tone="subdued">
                <s>{fmtMoney(orig, currency)}</s>
              </Text>
            )}
            <Text as="span" variant="headingMd">
              {fmtMoney(next, currency)}
            </Text>
          </InlineStack>
        </InlineStack>
        {saved > 0 && (
          <InlineStack align="end">
            <Badge tone="success">
              {`Save ${fmtMoney(saved, currency)} (${pct}% off)`}
            </Badge>
          </InlineStack>
        )}
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
