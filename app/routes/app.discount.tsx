import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Button,
  Banner,
  InlineStack,
  Badge,
  List,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

// Must match the title given to the automatic discount we create.
const DISCOUNT_TITLE = "Add-on & Bundle discount";
// The Function's API type for product discounts.
const PRODUCT_DISCOUNT_API_TYPE = "product_discounts";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  // 1. Locate our deployed discount Function.
  const fnResp = await admin.graphql(
    `#graphql
      query DiscountFunctions {
        shopifyFunctions(first: 50) {
          nodes { id title apiType }
        }
      }`,
  );
  const fnJson = await fnResp.json();
  const fn = (fnJson?.data?.shopifyFunctions?.nodes ?? []).find(
    (n: any) => n.apiType === PRODUCT_DISCOUNT_API_TYPE,
  );

  // 2. See if the automatic discount already exists.
  const discResp = await admin.graphql(
    `#graphql
      query ExistingAutoDiscounts {
        automaticDiscountNodes(first: 50) {
          nodes {
            id
            automaticDiscount {
              __typename
              ... on DiscountAutomaticApp { title status }
            }
          }
        }
      }`,
  );
  const discJson = await discResp.json();
  const existing = (discJson?.data?.automaticDiscountNodes?.nodes ?? []).find(
    (n: any) => n.automaticDiscount?.title === DISCOUNT_TITLE,
  );

  return {
    functionId: fn?.id ?? null,
    activated: Boolean(existing),
    status: existing?.automaticDiscount?.status ?? null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const fnResp = await admin.graphql(
    `#graphql
      query DiscountFunctions {
        shopifyFunctions(first: 50) {
          nodes { id apiType }
        }
      }`,
  );
  const fnJson = await fnResp.json();
  const fn = (fnJson?.data?.shopifyFunctions?.nodes ?? []).find(
    (n: any) => n.apiType === PRODUCT_DISCOUNT_API_TYPE,
  );
  if (!fn) {
    return {
      ok: false,
      error:
        "No product-discount function found. Deploy the app first with `shopify app deploy`.",
    };
  }
  // (success path returns { ok: true, error: null } below)

  const resp = await admin.graphql(
    `#graphql
      mutation CreateAddonDiscount($automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount { discountId }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        automaticAppDiscount: {
          title: DISCOUNT_TITLE,
          functionId: fn.id,
          startsAt: new Date().toISOString(),
          combinesWith: {
            productDiscounts: true,
            orderDiscounts: true,
            shippingDiscounts: true,
          },
        },
      },
    },
  );
  const json = await resp.json();
  const errs = json?.data?.discountAutomaticAppCreate?.userErrors ?? [];
  if (errs.length > 0) {
    // "Title must be unique" means our discount already exists — it's already
    // doing its job, so treat any uniqueness/exists error as activated.
    const onlyDuplicate = errs.every((e: any) =>
      /unique|already exists|taken/i.test(e.message ?? ""),
    );
    if (onlyDuplicate) {
      return { ok: true, error: null };
    }
    return { ok: false, error: errs.map((e: any) => e.message).join("; ") };
  }
  return { ok: true, error: null };
};

export default function DiscountSettings() {
  const { functionId, activated, status } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const isWorking = fetcher.state !== "idle";
  const justActivated = fetcher.data?.ok;

  const isActive = activated || justActivated;

  return (
    <Page>
      <TitleBar title="Discount settings" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Automatic add-on discount
                </Text>
                {isActive ? (
                  <Badge tone="success">
                    {status === "ACTIVE" || justActivated ? "Active" : "Created"}
                  </Badge>
                ) : (
                  <Badge tone="attention">Not activated</Badge>
                )}
              </InlineStack>

              <Text as="p" variant="bodyMd">
                This single automatic discount powers every add-on group in the
                app. When a customer has a main product and one of its
                configured accessories in the cart, the discount Function applies
                the right percentage to the accessory — no codes, no manual work.
              </Text>

              {fetcher.data?.error && (
                <Banner tone="critical" title="Could not activate">
                  <p>{fetcher.data.error}</p>
                </Banner>
              )}

              {!functionId && !isActive && (
                <Banner tone="warning" title="Function not deployed yet">
                  <p>
                    Run <code>shopify app deploy</code> once so the discount
                    Function is registered, then reload this page.
                  </p>
                </Banner>
              )}

              {isActive ? (
                <Banner tone="success">
                  <p>
                    The automatic discount is in place. You don&apos;t need to do
                    anything else — configure products on the Home page.
                  </p>
                </Banner>
              ) : (
                <InlineStack>
                  <Button
                    variant="primary"
                    loading={isWorking}
                    disabled={!functionId}
                    onClick={() => fetcher.submit({}, { method: "POST" })}
                  >
                    Activate discount
                  </Button>
                </InlineStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Setup checklist
              </Text>
              <List type="number">
                <List.Item>
                  Deploy the app (<code>shopify app deploy</code>).
                </List.Item>
                <List.Item>Activate the discount here.</List.Item>
                <List.Item>
                  Add the “Add On &amp; Save” block to your product template in
                  the theme editor.
                </List.Item>
                <List.Item>Configure products on the Home page.</List.Item>
              </List>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
