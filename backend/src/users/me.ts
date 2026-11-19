import type { PrismaService } from '../prisma.service.js';
import type { StorageService } from '../common/storage.service.js';

/** USER_ME 응답 모양. */
export async function loadMe(prisma: PrismaService, storage: StorageService, userId: string) {
  const u = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { identities: true, creator: { select: { id: true, status: true } }, profileImage: true },
  });
  return {
    id: u.id,
    email: u.email,
    nickname: u.nickname,
    profileImageUrl: await storage.getUrl(u.profileImage?.storageKey),
    bio: u.bio,
    role: u.role,
    isCreator: u.creator?.status === 'ACTIVE',
    providers: u.identities.map((i) => i.provider),
    createdAt: u.createdAt,
  };
}
