-- AlterTable
ALTER TABLE "Character" ADD COLUMN     "appearanceDescription" TEXT;

-- AlterTable
ALTER TABLE "EmoticonSet" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "EmoticonVersion" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'GENERATED';

-- AlterTable
ALTER TABLE "EmotionPreset" ADD COLUMN     "category" TEXT NOT NULL DEFAULT 'EMOTION',
ADD COLUMN     "exampleUrl" TEXT;

-- AlterTable
ALTER TABLE "GenerationJob" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "result" JSONB;
