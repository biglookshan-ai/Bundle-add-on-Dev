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
  Checkbox,
  Select,
  Button,
  Badge,
  Box,
  Banner,
  Thumbnail,
  Divider,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { ImageIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { getCampaign, saveCampaign } from "../models/gift-campaign.server";
import {
  emptyCampaign,
  campaignState,
  type GiftCampaign,
  type Ref,
} from "../models/gift-campaign";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (id && id !== "new") {
    const c = await getCampaign(session.shop, id);
    if (!c) throw new Response("Not found", { status: 404 });
    return { campaign: c, isNew: false };
  }
  return { campaign: emptyCampaign(), isNew: true };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  let campaign: GiftCampaign;
  try {
    campaign = JSON.parse(String(form.get("campaign")));
  } catch {
    return { ok: false, error: "Invalid payload" };
  }
  if (
    campaign.triggerProducts.length === 0 &&
    campaign.triggerCollections.length === 0
  ) {
    return { ok: false, error: "Add at least one trigger product or collection." };
  }
  if (campaign.giftProducts.length === 0) {
    return { ok: false, error: "Add at least one gift product." };
  }
  const r = await saveCampaign(admin, session.shop, campaign);
  if (!r.ok) return { ok: false, error: r.errors.join("; ") };
  return redirect("/app/gifts");
};

function toLocalInput(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(
    d.getHours(),
  )}:${p(d.getMinutes())}`;
}
function fromLocalInput(v: string) {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export default function GiftCampaignEditor() {
  const { campaign: initial } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const [c, setC] = useState<GiftCampaign>(initial);
  const busy = fetcher.state !== "idle";
  const patch = (p: Partial<GiftCampaign>) => setC((cur) => ({ ...cur, ...p }));

  const pick = async (
    type: "product" | "collection",
    current: Ref[],
    onPick: (refs: Ref[]) => void,
  ) => {
    const picked = await shopify.resourcePicker({
      type,
      multiple: true,
      action: "select",
      selectionIds: current.map((r) => ({ id: r.id })),
    });
    if (!picked) return;
    onPick(
      picked.map((p: any) => ({
        id: p.id,
        title: p.title || "",
        handle: p.handle || "",
        image:
          p.images?.[0]?.originalSrc ??
          p.images?.[0]?.src ??
          p.image?.originalSrc ??
          p.image?.src ??
          null,
      })),
    );
  };

  const refList = (
    refs: Ref[],
    onRemove: (id: string) => void,
  ) =>
    refs.length === 0 ? (
      <Text as="span" variant="bodySm" tone="subdued">
        None selected
      </Text>
    ) : (
      <BlockStack gap="150">
        {refs.map((r) => (
          <InlineStack key={r.id} align="space-between" blockAlign="center">
            <InlineStack gap="200" blockAlign="center">
              <Thumbnail source={r.image || ImageIcon} alt={r.title} size="small" />
              <Text as="span" variant="bodyMd">
                {r.title || r.handle || r.id}
              </Text>
            </InlineStack>
            <Button variant="tertiary" tone="critical" onClick={() => onRemove(r.id)}>
              Remove
            </Button>
          </InlineStack>
        ))}
      </BlockStack>
    );

  const save = () =>
    fetcher.submit({ campaign: JSON.stringify(c) }, { method: "POST" });

  const state = campaignState(c);

  return (
    <Page
      backAction={{ content: "Gift campaigns", onAction: () => navigate("/app/gifts") }}
    >
      <TitleBar title={initial.title || "Gift campaign"} />
      <BlockStack gap="400">
        {fetcher.data?.error && (
          <Banner tone="critical">{fetcher.data.error}</Banner>
        )}

        <Card>
          <BlockStack gap="400">
            <InlineStack gap="400" wrap={false} blockAlign="start">
              <Box width="70%">
                <TextField
                  label="Campaign name"
                  autoComplete="off"
                  value={c.title}
                  onChange={(v) => patch({ title: v })}
                  helpText="Internal name, e.g. “Buy a camera, get a free battery”."
                />
              </Box>
              <Box width="30%">
                <BlockStack gap="150">
                  <Checkbox
                    label="Enabled"
                    checked={c.enabled}
                    onChange={(v) => patch({ enabled: v })}
                  />
                  <Badge
                    tone={
                      state === "active"
                        ? "success"
                        : state === "scheduled"
                          ? "info"
                          : state === "ended"
                            ? "attention"
                            : undefined
                    }
                  >
                    {state}
                  </Badge>
                </BlockStack>
              </Box>
            </InlineStack>

            <InlineStack gap="400" wrap={false}>
              <Box width="50%">
                <TextField
                  label="Starts (optional)"
                  type={"datetime-local" as any}
                  autoComplete="off"
                  value={toLocalInput(c.startsAt)}
                  onChange={(v) => patch({ startsAt: fromLocalInput(v) })}
                  helpText="Blank = starts immediately."
                />
              </Box>
              <Box width="50%">
                <TextField
                  label="Ends (optional)"
                  type={"datetime-local" as any}
                  autoComplete="off"
                  value={toLocalInput(c.endsAt)}
                  onChange={(v) => patch({ endsAt: fromLocalInput(v) })}
                  helpText="Server-enforced end."
                />
              </Box>
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">
              Trigger — buy any of these
            </Text>
            <InlineStack align="space-between" blockAlign="center">
              <Text as="span" variant="bodySm" tone="subdued">
                Products ({c.triggerProducts.length})
              </Text>
              <Button
                onClick={() =>
                  pick("product", c.triggerProducts, (refs) =>
                    patch({ triggerProducts: refs }),
                  )
                }
              >
                Select products
              </Button>
            </InlineStack>
            {refList(c.triggerProducts, (id) =>
              patch({
                triggerProducts: c.triggerProducts.filter((r) => r.id !== id),
              }),
            )}
            <Divider />
            <InlineStack align="space-between" blockAlign="center">
              <Text as="span" variant="bodySm" tone="subdued">
                Collections ({c.triggerCollections.length})
              </Text>
              <Button
                onClick={() =>
                  pick("collection", c.triggerCollections, (refs) =>
                    patch({ triggerCollections: refs }),
                  )
                }
              >
                Select collections
              </Button>
            </InlineStack>
            {refList(c.triggerCollections, (id) =>
              patch({
                triggerCollections: c.triggerCollections.filter(
                  (r) => r.id !== id,
                ),
              }),
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">
              Gift — get free
            </Text>
            <InlineStack align="space-between" blockAlign="center">
              <Text as="span" variant="bodySm" tone="subdued">
                Gift products ({c.giftProducts.length})
              </Text>
              <Button
                onClick={() =>
                  pick("product", c.giftProducts, (refs) =>
                    patch({ giftProducts: refs }),
                  )
                }
              >
                Select gifts
              </Button>
            </InlineStack>
            {refList(c.giftProducts, (id) =>
              patch({ giftProducts: c.giftProducts.filter((r) => r.id !== id) }),
            )}
            <Divider />
            <InlineStack gap="400" wrap={false} blockAlign="start">
              <Box width="33%">
                <TextField
                  label="Free per qualifying unit"
                  type="number"
                  min={1}
                  autoComplete="off"
                  value={String(c.perQualifying)}
                  onChange={(v) =>
                    patch({ perQualifying: Math.max(1, Number(v) || 1) })
                  }
                  helpText="Buy 2 → 2 free."
                />
              </Box>
              <Box width="33%">
                <Select
                  label="Reward mode"
                  options={[
                    { label: "Fixed — auto-add the gift", value: "fixed" },
                    { label: "Choice — customer picks (coming soon)", value: "choice" },
                  ]}
                  value={c.rewardMode}
                  onChange={(v) => patch({ rewardMode: v as "fixed" | "choice" })}
                />
              </Box>
              <Box width="33%">
                <TextField
                  label="Badge text"
                  autoComplete="off"
                  value={c.badgeText}
                  onChange={(v) => patch({ badgeText: v })}
                  helpText="Shown on product / search."
                />
              </Box>
            </InlineStack>
          </BlockStack>
        </Card>

        <InlineStack align="end">
          <Button variant="primary" loading={busy} onClick={save}>
            Save campaign
          </Button>
        </InlineStack>
      </BlockStack>
    </Page>
  );
}
