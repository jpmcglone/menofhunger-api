-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('text', 'call');

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "callMeta" JSONB,
ADD COLUMN     "kind" "MessageKind" NOT NULL DEFAULT 'text';
