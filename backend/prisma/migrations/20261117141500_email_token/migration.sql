-- AlterTable
ALTER TABLE "EmailVerification" ADD COLUMN     "consumedAt" TIMESTAMP(3),
ADD COLUMN     "tokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "tokenHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerification_tokenHash_key" ON "EmailVerification"("tokenHash");

