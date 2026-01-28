-- CreateTable
CREATE TABLE "SiteConfig" (
    "id" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "postsPerWindow" INTEGER NOT NULL DEFAULT 5,
    "windowSeconds" INTEGER NOT NULL DEFAULT 300,

    CONSTRAINT "SiteConfig_pkey" PRIMARY KEY ("id")
);

-- Seed singleton row
INSERT INTO "SiteConfig" ("id", "postsPerWindow", "windowSeconds", "updatedAt")
VALUES (1, 5, 300, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

