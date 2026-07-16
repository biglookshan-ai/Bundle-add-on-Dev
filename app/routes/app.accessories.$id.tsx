import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Select,
  Button,
  Box,
  Banner,
  Thumbnail,
  Badge,
  Divider,
  ChoiceList,
  Collapsible,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { ImageIcon, DeleteIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { readAccConfig, saveAccessoryConfig } from "../models/accessory-config.server";
import { fetchProductPrices } from "../models/addon-config.server";
import {
  newAccGroupId,
  clampPct,
  type AccessoryConfig,
  type AccessoryGroup,
  type AccessoryItem,
} from "../models/accessory-config";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const productId = `gid://shopify/Product/${params.id}`;
  const { product, config } = await readAccConfig(admin, productId);
  if (!product) throw new Response("Product not found", { status: 404 });
  const ids = [
    product.id, // include the main product so we know its variants
    ...config.groups.flatMap((g) => g.accessories.map((a) => a.productId)),
  ];
  const { prices, info, currency, variants } = await fetchProductPrices(
    admin,
    ids,
  );
  return { product, config, prices, info, currency, variants };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const productId = `gid://shopify/Product/${params.id}`;
  const { product } = await readAccConfig(admin, productId);
  if (!product) return { ok: false, error: "Product not found" };
  const form = await request.formData();
  let config: AccessoryConfig;
  try {
    config = JSON.parse(String(form.get("config")));
  } catch {
    return { ok: false, error: "Invalid payload" };
  }
  const r = await saveAccessoryConfig(admin, session.shop, product, config);
  if (!r.ok) return { ok: false, error: r.errors.join("; ") };
  return redirect("/app/accessories");
};

function fmt(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(
      cents,
    );
  } catch {
    return `${cents}`;
  }
}

export default function AccessoryEditor() {
  const { product, config: initial, prices, info, currency, variants } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const [groups, setGroups] = useState<AccessoryGroup[]>(initial.groups);
  const [offerPercent, setOfferPercent] = useState<number>(
    initial.offerPercent ?? 10,
  );
  const [offerQuantity, setOfferQuantity] = useState<number>(
    initial.offerQuantity ?? 1,
  );
  // Which accessory rows have their "limit variants" panel open.
  const [openVariants, setOpenVariants] = useState<Record<string, boolean>>({});
  const busy = fetcher.state !== "idle";

  const mainVariants = variants[product.id] ?? [];

  const setGroup = (id: string, patch: Partial<AccessoryGroup>) =>
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  const setItem = (
    groupId: string,
    productId: string,
    patch: Partial<AccessoryItem>,
  ) =>
    setGroups((gs) =>
      gs.map((g) =>
        g.id === groupId
          ? {
              ...g,
              accessories: g.accessories.map((x) =>
                x.productId === productId ? { ...x, ...patch } : x,
              ),
            }
          : g,
      ),
    );
  const addGroup = (type: "optional" | "free") =>
    setGroups((gs) => [
      ...gs,
      {
        id: newAccGroupId(),
        title: type === "free" ? "Free gift" : "Accessories",
        type,
        selectMode: "multi",
        accessories: [],
      },
    ]);

  const pickAccessories = async (group: AccessoryGroup) => {
    const picked = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      action: "select",
      selectionIds: group.accessories.map((a) => ({ id: a.productId })),
    });
    if (!picked) return;
    const prev = new Map(group.accessories.map((a) => [a.productId, a]));
    const accessories: AccessoryItem[] = picked
      .filter((p: any) => p.id !== product.id)
      .map((p: any) => {
        const existing = prev.get(p.id);
        return (
          existing ?? {
            productId: p.id,
            handle: p.handle || "",
            title: p.title || "",
          }
        );
      });
    setGroup(group.id, { accessories });
  };

  const save = () =>
    fetcher.submit(
      {
        config: JSON.stringify({
          version: 1,
          groups,
          offerPercent: clampPct(offerPercent),
          offerQuantity: Math.max(1, Math.round(offerQuantity) || 1),
        }),
      },
      { method: "POST" },
    );

  return (
    <Page
      backAction={{ content: "Accessory offers", onAction: () => navigate("/app/accessories") }}
      title={product.title}
    >
      <TitleBar title={product.title} />
      <BlockStack gap="400">
        {fetcher.data?.error && (
          <Banner tone="critical">{fetcher.data.error}</Banner>
        )}
        <Banner tone="info">
          Uses a native “Buy X Get Y” automatic discount (works on any plan, no
          Shopify Plus). Because of Shopify’s native rules there is{" "}
          <b>one discount rate for all accessories</b>, and the customer must add{" "}
          <b>exactly the required number</b> of accessories to unlock it. The main
          product must be in the cart, so the discount can’t leak to accessory-only
          orders.
        </Banner>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              The offer
            </Text>
            <InlineStack gap="400" blockAlign="start">
              <Box width="160px">
                <TextField
                  label="Discount rate"
                  type="number"
                  min={0}
                  max={100}
                  suffix="% off"
                  autoComplete="off"
                  value={String(offerPercent)}
                  onChange={(v) => setOfferPercent(clampPct(v))}
                  helpText="Same rate for every accessory."
                />
              </Box>
              <Box width="200px">
                <TextField
                  label="Required accessories"
                  type="number"
                  min={1}
                  autoComplete="off"
                  value={String(offerQuantity)}
                  onChange={(v) =>
                    setOfferQuantity(Math.max(1, Math.round(Number(v)) || 1))
                  }
                  helpText="How many the customer must add to get the discount."
                />
              </Box>
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              Example: rate 15% + required 1 → “buy this product, add any 1
              accessory below and get 15% off it”. Required 2 → they must add 2.
            </Text>
          </BlockStack>
        </Card>

        {groups.map((group) => (
          <Card key={group.id}>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <Box width="240px">
                    <TextField
                      label="Group title"
                      labelHidden
                      autoComplete="off"
                      value={group.title}
                      onChange={(v) => setGroup(group.id, { title: v })}
                    />
                  </Box>
                  <Box width="150px">
                    <Select
                      label="Select mode"
                      labelHidden
                      options={[
                        { label: "Multi-select", value: "multi" },
                        { label: "Single-select", value: "single" },
                      ]}
                      value={group.selectMode}
                      onChange={(v) =>
                        setGroup(group.id, { selectMode: v as "single" | "multi" })
                      }
                    />
                  </Box>
                </InlineStack>
                <Button
                  icon={DeleteIcon}
                  tone="critical"
                  variant="tertiary"
                  onClick={() =>
                    setGroups((gs) => gs.filter((g) => g.id !== group.id))
                  }
                />
              </InlineStack>

              <TextField
                label="Subtitle (optional)"
                autoComplete="off"
                placeholder="e.g. Add filters to protect your lens"
                value={group.subtitle ?? ""}
                onChange={(v) =>
                  setGroup(group.id, { subtitle: v || undefined })
                }
              />

              {mainVariants.length > 1 && (
                <Box
                  background="bg-surface-secondary"
                  padding="300"
                  borderRadius="200"
                >
                  <ChoiceList
                    allowMultiple
                    title="Show this group only for these main variants (leave all unchecked = always show)"
                    choices={mainVariants.map((v) => ({
                      label: v.title,
                      value: v.id,
                    }))}
                    selected={group.mainVariantIds ?? []}
                    onChange={(sel) =>
                      setGroup(group.id, {
                        mainVariantIds: sel.length ? sel : undefined,
                      })
                    }
                  />
                </Box>
              )}

              <Divider />

              <InlineStack align="space-between" blockAlign="center">
                <Text as="span" variant="bodySm" tone="subdued">
                  Accessories ({group.accessories.length})
                </Text>
                <Button onClick={() => pickAccessories(group)}>
                  Select accessories
                </Button>
              </InlineStack>

              {group.accessories.map((a) => {
                const price = prices[a.productId];
                const pct = offerPercent;
                const now = price != null ? price * (1 - pct / 100) : null;
                const accVariants = variants[a.productId] ?? [];
                const offered = a.variantIds ?? [];
                const rowKey = `${group.id}:${a.productId}`;
                return (
                 <BlockStack key={a.productId} gap="150">
                  <InlineStack
                    align="space-between"
                    blockAlign="center"
                    wrap={false}
                  >
                    <InlineStack gap="200" blockAlign="center">
                      <Thumbnail
                        source={info[a.productId]?.image || ImageIcon}
                        alt={a.title}
                        size="small"
                      />
                      <BlockStack gap="050">
                        <Text as="span" variant="bodyMd">
                          {info[a.productId]?.title || a.title}
                        </Text>
                        {price != null && (
                          <Text as="span" variant="bodySm" tone="subdued">
                            {fmt(price, currency)}
                            {pct > 0 && now != null
                              ? ` → ${fmt(now, currency)}`
                              : ""}
                          </Text>
                        )}
                      </BlockStack>
                    </InlineStack>
                    <InlineStack gap="200" blockAlign="center">
                      {offerPercent > 0 && (
                        <Badge tone="attention">{`${offerPercent}% off`}</Badge>
                      )}
                      <Button
                        icon={DeleteIcon}
                        variant="tertiary"
                        tone="critical"
                        onClick={() =>
                          setGroup(group.id, {
                            accessories: group.accessories.filter(
                              (x) => x.productId !== a.productId,
                            ),
                          })
                        }
                      />
                    </InlineStack>
                  </InlineStack>

                  {accVariants.length > 1 && (
                    <Box paddingInlineStart="800">
                      <Button
                        variant="plain"
                        disclosure={openVariants[rowKey] ? "up" : "down"}
                        onClick={() =>
                          setOpenVariants((o) => ({
                            ...o,
                            [rowKey]: !o[rowKey],
                          }))
                        }
                      >
                        {offered.length
                          ? `${offered.length} of ${accVariants.length} variants offered`
                          : `All ${accVariants.length} variants offered`}
                      </Button>
                      <Collapsible
                        open={!!openVariants[rowKey]}
                        id={`vars-${rowKey}`}
                      >
                        <Box paddingBlockStart="200">
                          <ChoiceList
                            allowMultiple
                            title="Variants offered to customers"
                            titleHidden
                            choices={accVariants.map((v) => ({
                              label: v.title,
                              value: v.id,
                            }))}
                            selected={
                              offered.length
                                ? offered
                                : accVariants.map((v) => v.id)
                            }
                            onChange={(sel) =>
                              setItem(group.id, a.productId, {
                                variantIds:
                                  sel.length === 0 ||
                                  sel.length === accVariants.length
                                    ? undefined
                                    : sel,
                              })
                            }
                          />
                        </Box>
                      </Collapsible>
                    </Box>
                  )}
                 </BlockStack>
                );
              })}
            </BlockStack>
          </Card>
        ))}

        <InlineStack gap="200">
          <Button onClick={() => addGroup("optional")}>
            Add accessory group
          </Button>
        </InlineStack>

        <InlineStack align="end">
          <Button variant="primary" loading={busy} onClick={save}>
            Save
          </Button>
        </InlineStack>
      </BlockStack>
    </Page>
  );
}
