-- CreateTable
CREATE TABLE "GiftCampaign" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "perQualifying" INTEGER NOT NULL DEFAULT 1,
    "rewardMode" TEXT NOT NULL DEFAULT 'fixed',
    "badgeText" TEXT NOT NULL DEFAULT '',
    "triggerProductsJson" TEXT NOT NULL DEFAULT '[]',
    "triggerCollectionsJson" TEXT NOT NULL DEFAULT '[]',
    "giftProductsJson" TEXT NOT NULL DEFAULT '[]',
    "nodeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GiftCampaign_shop_idx" ON "GiftCampaign"("shop");
