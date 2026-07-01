import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Badge,
  Box,
  Banner,
  EmptyState,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  listCampaigns,
  deleteCampaign,
  resyncAll,
} from "../models/gift-campaign.server";
import { campaignState } from "../models/gift-campaign";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const campaigns = await listCampaigns(session.shop);
  return { campaigns };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "delete") {
    const id = String(form.get("id") || "");
    const r = await deleteCampaign(admin, session.shop, id);
    return { ok: r.ok, error: r.errors.join("; ") || null, message: null };
  }
  if (intent === "resync") {
    const r = await resyncAll(admin, session.shop);
    return {
      ok: r.ok,
      error: r.errors.join("; ") || null,
      message: r.ok ? "Trigger products re-synced." : null,
    };
  }
  return { ok: false, error: "Unknown action", message: null };
};

const STATE_TONE: Record<string, "success" | "info" | "attention" | undefined> =
  {
    active: "success",
    scheduled: "info",
    ended: "attention",
    disabled: undefined,
  };

export default function GiftCampaigns() {
  const { campaigns } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const busy = fetcher.state !== "idle";

  return (
    <Page>
      <TitleBar title="Gift campaigns" />
      <BlockStack gap="400">
        {fetcher.data?.error && (
          <Banner tone="critical">{fetcher.data.error}</Banner>
        )}
        {fetcher.data?.message && (
          <Banner tone="success">{fetcher.data.message}</Banner>
        )}

        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Gift with purchase
          </Text>
          <InlineStack gap="200">
            <Button
              loading={busy}
              onClick={() =>
                fetcher.submit({ intent: "resync" }, { method: "POST" })
              }
            >
              Re-sync collections
            </Button>
            <Button
              variant="primary"
              onClick={() => navigate("/app/gifts/new")}
            >
              New campaign
            </Button>
          </InlineStack>
        </InlineStack>

        {campaigns.length === 0 ? (
          <Card>
            <EmptyState
              heading="No gift campaigns yet"
              action={{
                content: "New campaign",
                onAction: () => navigate("/app/gifts/new"),
              }}
              image=""
            >
              <p>
                Reward customers with a free gift when they buy chosen products
                or collections — buy 2, get 2.
              </p>
            </EmptyState>
          </Card>
        ) : (
          <Card padding="0">
            <BlockStack>
              {campaigns.map((c, i) => {
                const state = campaignState(c);
                const triggers =
                  c.triggerProducts.length + c.triggerCollections.length;
                return (
                  <Box
                    key={c.id}
                    padding="400"
                    borderBlockEndWidth={
                      i < campaigns.length - 1 ? "025" : undefined
                    }
                    borderColor="border"
                  >
                    <InlineStack align="space-between" blockAlign="center" wrap={false}>
                      <BlockStack gap="100">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="span" variant="bodyMd" fontWeight="medium">
                            {c.title || "Untitled campaign"}
                          </Text>
                          <Badge tone={STATE_TONE[state]}>{state}</Badge>
                        </InlineStack>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {triggers} trigger
                          {triggers === 1 ? "" : "s"} · {c.giftProducts.length}{" "}
                          gift{c.giftProducts.length === 1 ? "" : "s"} · buy 1 get{" "}
                          {c.perQualifying} · {c.rewardMode}
                        </Text>
                      </BlockStack>
                      <InlineStack gap="200">
                        <Button onClick={() => navigate(`/app/gifts/${c.id}`)}>
                          Edit
                        </Button>
                        <Button
                          tone="critical"
                          variant="tertiary"
                          loading={busy}
                          onClick={() =>
                            fetcher.submit(
                              { intent: "delete", id: c.id },
                              { method: "POST" },
                            )
                          }
                        >
                          Delete
                        </Button>
                      </InlineStack>
                    </InlineStack>
                  </Box>
                );
              })}
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
