import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Box,
  Thumbnail,
  EmptyState,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const rows = await prisma.bundleConfig.findMany({
    where: { shop: session.shop },
    orderBy: { updatedAt: "desc" },
  });
  return {
    products: rows.map((r) => ({
      id: r.productId,
      numericId: r.productId.replace("gid://shopify/Product/", ""),
      title: r.productTitle,
      image: r.productImage,
      groupCount: r.groupCount,
      accessoryCount: r.accessoryCount,
    })),
  };
};

export default function AccessoryOffers() {
  const { products } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  const configure = async () => {
    const picked = await shopify.resourcePicker({
      type: "product",
      multiple: false,
      action: "select",
    });
    if (!picked || !picked[0]) return;
    const num = String(picked[0].id).replace("gid://shopify/Product/", "");
    navigate(`/app/accessories/${num}`);
  };

  return (
    <Page>
      <TitleBar title="Accessory offers" />
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Optional accessories &amp; free gifts
          </Text>
          <Button variant="primary" onClick={configure}>
            Configure a product
          </Button>
        </InlineStack>

        {products.length === 0 ? (
          <Card>
            <EmptyState
              heading="No products configured yet"
              action={{ content: "Configure a product", onAction: configure }}
              image=""
            >
              <p>
                Let customers add optional accessories (at full price or a
                discount) and free gifts to a product — powered by native
                discounts, no Shopify Plus needed.
              </p>
            </EmptyState>
          </Card>
        ) : (
          <Card padding="0">
            <BlockStack>
              {products.map((p, i) => (
                <Box
                  key={p.id}
                  padding="400"
                  borderBlockEndWidth={i < products.length - 1 ? "025" : undefined}
                  borderColor="border"
                >
                  <InlineStack align="space-between" blockAlign="center" wrap={false}>
                    <InlineStack gap="300" blockAlign="center">
                      <Thumbnail source={p.image || ImageIcon} alt={p.title} size="small" />
                      <BlockStack gap="050">
                        <Text as="span" variant="bodyMd" fontWeight="medium">
                          {p.title}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {p.groupCount} group{p.groupCount === 1 ? "" : "s"} ·{" "}
                          {p.accessoryCount} accessor
                          {p.accessoryCount === 1 ? "y" : "ies"}
                        </Text>
                      </BlockStack>
                    </InlineStack>
                    <Button onClick={() => navigate(`/app/accessories/${p.numericId}`)}>
                      Edit
                    </Button>
                  </InlineStack>
                </Box>
              ))}
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
