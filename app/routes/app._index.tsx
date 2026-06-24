import { useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  InlineStack,
  IndexTable,
  Badge,
  EmptyState,
  Box,
  ButtonGroup,
  Thumbnail,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { listConfigsDetailed } from "../models/addon-config.server";
import {
  displayCode,
  groupBucket,
  isEndedSale,
  offerStateOf,
  type Bucket,
} from "../models/addon-config";

function numericOf(gid: string) {
  return gid.replace("gid://shopify/Product/", "");
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const detailed = await listConfigsDetailed(admin, session.shop);

  const products = detailed.map((d) => {
    const counts: Record<Bucket, number> = { bundle: 0, sale: 0, addon: 0, free: 0 };
    let accessoryCount = 0;
    for (const g of d.config.groups) {
      if (g.archived) continue;
      counts[groupBucket(g)] += 1;
      accessoryCount += g.accessories.length;
    }
    return {
      id: d.productId,
      numericId: d.numericId,
      title: d.title,
      image: d.image,
      accessoryCount,
      updatedAt: d.updatedAt,
      counts,
    };
  });

  // Flatten every LIVE (non-archived) group into per-bucket lists.
  const lists: Record<Bucket, any[]> = { bundle: [], sale: [], addon: [], free: [] };
  for (const d of detailed) {
    for (const g of d.config.groups) {
      if (g.archived) continue;
      const bucket = groupBucket(g);
      lists[bucket].push({
        key: d.numericId + ":" + g.id,
        groupId: g.id,
        code: displayCode(g),
        title: g.title,
        productTitle: d.title,
        productImage: d.image,
        numericId: d.numericId,
        accessoryCount: g.accessories.length,
        discountPercent: g.discountPercent,
        saleState: bucket === "sale" ? offerStateOf(g.limited) : null,
        dim: bucket === "sale" ? isEndedSale(g) : false,
      });
    }
  }

  return {
    products,
    lists,
    stats: {
      products: products.length,
      bundle: lists.bundle.length,
      sale: lists.sale.length,
      addon: lists.addon.length,
      free: lists.free.length,
    },
  };
};

export default function Index() {
  const { products, lists, stats } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [tab, setTab] = useState(0);

  const openProductPicker = async () => {
    const picked = await window.shopify.resourcePicker({
      type: "product",
      action: "select",
      multiple: false,
    });
    if (picked && picked[0]) {
      navigate(`/app/products/${numericOf(picked[0].id)}`);
    }
  };

  const TABS = [
    `By product (${stats.products})`,
    `By bundle (${stats.bundle})`,
    `Sale bundle (${stats.sale})`,
    `By add-on (${stats.addon})`,
    `Free add-on (${stats.free})`,
  ];

  return (
    <Page>
      <TitleBar title="Add-ons & Bundles">
        <button variant="primary" onClick={openProductPicker}>
          Configure a product
        </button>
      </TitleBar>
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <BlockStack gap="300">
              <ButtonGroup variant="segmented">
                {TABS.map((label, i) => (
                  <Button key={i} pressed={tab === i} onClick={() => setTab(i)}>
                    {label}
                  </Button>
                ))}
              </ButtonGroup>

              <Card padding="0">
                {tab === 0 && (
                  <ByProduct
                    products={products}
                    navigate={navigate}
                    openProductPicker={openProductPicker}
                  />
                )}
                {tab === 1 && (
                  <ByGroup rows={lists.bundle} kind="bundle" navigate={navigate} />
                )}
                {tab === 2 && (
                  <ByGroup rows={lists.sale} kind="sale" navigate={navigate} />
                )}
                {tab === 3 && (
                  <ByGroup rows={lists.addon} kind="addon" navigate={navigate} />
                )}
                {tab === 4 && (
                  <ByGroup rows={lists.free} kind="free" navigate={navigate} />
                )}
              </Card>
            </BlockStack>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Before discounts work
                </Text>
                <Text as="p" variant="bodyMd">
                  The automatic discount that powers add-on & bundle pricing must
                  be activated once. Limited offers create their own timed
                  discounts automatically when you save.
                </Text>
                <InlineStack>
                  <Button onClick={() => navigate("/app/discount")}>
                    Discount settings
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

function CountBadges({ counts }: { counts: Record<Bucket, number> }) {
  const total = counts.bundle + counts.sale + counts.addon + counts.free;
  return (
    <InlineStack gap="150" wrap>
      {counts.bundle > 0 && <Badge tone="info">{`${counts.bundle} Bundle`}</Badge>}
      {counts.sale > 0 && (
        <Badge tone="attention">{`${counts.sale} Sale`}</Badge>
      )}
      {counts.addon > 0 && <Badge>{`${counts.addon} Add-on`}</Badge>}
      {counts.free > 0 && <Badge tone="success">{`${counts.free} Free`}</Badge>}
      {total === 0 && (
        <Text as="span" tone="subdued" variant="bodySm">
          —
        </Text>
      )}
    </InlineStack>
  );
}

function ByProduct({
  products,
  navigate,
  openProductPicker,
}: {
  products: any[];
  navigate: (to: string) => void;
  openProductPicker: () => void;
}) {
  if (products.length === 0) {
    return (
      <EmptyState
        heading="No products configured yet"
        action={{ content: "Configure a product", onAction: openProductPicker }}
        image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
      >
        <p>
          Pick a main product, then attach bundles & add-ons with a discount. The
          matching section appears on that product page.
        </p>
      </EmptyState>
    );
  }
  return (
    <IndexTable
      resourceName={{ singular: "product", plural: "products" }}
      itemCount={products.length}
      selectable={false}
      headings={[
        { title: "Main product" },
        { title: "What's configured" },
        { title: "Accessories" },
        { title: "Updated" },
        { title: "" },
      ]}
    >
      {products.map((p, index) => (
        <IndexTable.Row
          id={p.id}
          key={p.id}
          position={index}
          onClick={() => navigate(`/app/products/${p.numericId}`)}
        >
          <IndexTable.Cell>
            <InlineStack gap="300" blockAlign="center" wrap={false}>
              <Thumbnail source={p.image || ImageIcon} alt={p.title} size="small" />
              <Text variant="bodyMd" fontWeight="semibold" as="span">
                {p.title}
              </Text>
            </InlineStack>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <CountBadges counts={p.counts} />
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Badge>{String(p.accessoryCount)}</Badge>
          </IndexTable.Cell>
          <IndexTable.Cell>
            {new Date(p.updatedAt).toLocaleDateString()}
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Button
              variant="plain"
              onClick={() => navigate(`/app/products/${p.numericId}`)}
            >
              Edit
            </Button>
          </IndexTable.Cell>
        </IndexTable.Row>
      ))}
    </IndexTable>
  );
}

const KIND_META: Record<
  "bundle" | "sale" | "addon" | "free",
  { noun: string; plural: string; nameCol: string; empty: string }
> = {
  bundle: {
    noun: "bundle",
    plural: "bundles",
    nameCol: "Bundle",
    empty: "No standard bundles. Open a product to add one.",
  },
  sale: {
    noun: "sale bundle",
    plural: "sale bundles",
    nameCol: "Sale bundle",
    empty: "No sale bundles. Turn on a limited-time offer on a bundle.",
  },
  addon: {
    noun: "add-on",
    plural: "add-ons",
    nameCol: "Add-on",
    empty: "No add-ons yet. Open a product to add one.",
  },
  free: {
    noun: "free add-on",
    plural: "free add-ons",
    nameCol: "Free add-on",
    empty: "No free add-ons yet. Add a Free gift group on a product.",
  },
};

function ByGroup({
  rows,
  kind,
  navigate,
}: {
  rows: any[];
  kind: "bundle" | "sale" | "addon" | "free";
  navigate: (to: string) => void;
}) {
  const meta = KIND_META[kind];
  if (rows.length === 0) {
    return (
      <Box padding="800">
        <Text as="p" tone="subdued" alignment="center">
          {meta.empty}
        </Text>
      </Box>
    );
  }
  const lastCol =
    kind === "sale" ? "Status" : kind === "free" ? "Type" : "Discount";
  return (
    <IndexTable
      resourceName={{ singular: meta.noun, plural: meta.plural }}
      itemCount={rows.length}
      selectable={false}
      headings={[
        { title: "Code" },
        { title: meta.nameCol },
        { title: "Main product" },
        { title: lastCol },
        { title: "Items" },
      ]}
    >
      {rows.map((r, index) => (
        <IndexTable.Row
          id={r.key}
          key={r.key}
          position={index}
          onClick={() => navigate(`/app/products/${r.numericId}#${r.groupId}`)}
        >
          <IndexTable.Cell>
            <Text as="span" variant="bodySm" tone="subdued">
              <code>{r.code}</code>
            </Text>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Text
              variant="bodyMd"
              fontWeight="semibold"
              as="span"
              tone={r.dim ? "subdued" : undefined}
            >
              {r.title}
            </Text>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <InlineStack gap="200" blockAlign="center" wrap={false}>
              <Thumbnail
                source={r.productImage || ImageIcon}
                alt={r.productTitle}
                size="small"
              />
              <Text as="span" variant="bodyMd">
                {r.productTitle}
              </Text>
            </InlineStack>
          </IndexTable.Cell>
          <IndexTable.Cell>
            {kind === "sale" ? (
              r.saleState === "active" ? (
                <Badge tone="success">Live</Badge>
              ) : r.saleState === "upcoming" ? (
                <Badge>Scheduled</Badge>
              ) : (
                <Badge tone="critical">Ended</Badge>
              )
            ) : kind === "free" ? (
              <Badge tone="success">Free</Badge>
            ) : (
              <Text as="span" tone="subdued" variant="bodySm">
                {`${r.discountPercent}% off`}
              </Text>
            )}
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Badge>{String(r.accessoryCount)}</Badge>
          </IndexTable.Cell>
        </IndexTable.Row>
      ))}
    </IndexTable>
  );
}
