/*
  Warnings:

  - Added the required column `accountHolder` to the `Creator` table without a default value. This is not possible if the table is not empty.
  - Added the required column `accountNumber` to the `Creator` table without a default value. This is not possible if the table is not empty.
  - Added the required column `bankName` to the `Creator` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Creator" ADD COLUMN     "accountHolder" TEXT NOT NULL,
ADD COLUMN     "accountNumber" TEXT NOT NULL,
ADD COLUMN     "bankName" TEXT NOT NULL,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "RateHit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateHit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateHit_key_createdAt_idx" ON "RateHit"("key", "createdAt");
