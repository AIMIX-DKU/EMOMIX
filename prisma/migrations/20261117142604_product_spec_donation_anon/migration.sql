-- AlterTable
ALTER TABLE "Donation" ADD COLUMN     "isAnonymous" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "setSpec" JSONB;
