-- AlterEnum
ALTER TYPE "ProductStatus" ADD VALUE 'HIDDEN';

-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "parentId" TEXT;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "targetId" TEXT,
ADD COLUMN     "targetType" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "refundReason" TEXT,
ADD COLUMN     "refundedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "promptInfo" JSONB,
ADD COLUMN     "sharePrompt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "snapshot" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "licenseNote" TEXT,
ADD COLUMN     "licenseType" TEXT NOT NULL DEFAULT 'PERSONAL',
ADD COLUMN     "snapshot" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN     "accessedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "handledAction" TEXT,
ADD COLUMN     "handledBy" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "suspendedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
