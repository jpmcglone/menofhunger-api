-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationKind" ADD VALUE 'word_of_the_day';
ALTER TYPE "NotificationKind" ADD VALUE 'quote_of_the_day';

-- AlterTable
ALTER TABLE "DailyContentSnapshot" DROP COLUMN "websters1828RecheckedAt",
ADD COLUMN     "quoteFanoutCursor" TEXT,
ADD COLUMN     "quoteNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "wordFanoutCursor" TEXT,
ADD COLUMN     "wordNotifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "NotificationPreferences" ADD COLUMN     "pushDailyContent" BOOLEAN NOT NULL DEFAULT true;
