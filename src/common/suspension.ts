import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service.js';

type Db = PrismaService | Prisma.TransactionClient;

/** 정지로 숨긴 상품만 되돌린다. 신고 처리 등으로 따로 숨긴 상품은 건드리지 않는다. */
export async function restoreSuspendedProducts(prisma: Db, userId: string) {
  const log = await prisma.auditLog.findFirst({ where: { action: 'USER_SUSPEND_PRODUCTS', target: userId }, orderBy: { createdAt: 'desc' } });
  const ids = ((log?.detail as { productIds?: string[] } | null)?.productIds ?? []);
  if (ids.length) await prisma.product.updateMany({ where: { id: { in: ids }, status: 'HIDDEN' }, data: { status: 'ON_SALE' } });
}

/** 기간이 정해진 정지는 만료 시점에 자동으로 풀린다(크론 없이 접근할 때 처리). 현재 유효한 상태를 돌려준다. */
export async function effectiveStatus(
  prisma: PrismaService,
  u: { id: string; status: 'ACTIVE' | 'SUSPENDED' | 'WITHDRAWN'; suspendedUntil: Date | null },
) {
  if (u.status === 'SUSPENDED' && u.suspendedUntil && u.suspendedUntil < new Date()) {
    await prisma.user.update({ where: { id: u.id }, data: { status: 'ACTIVE', suspendedReason: null, suspendedUntil: null } });
    await restoreSuspendedProducts(prisma, u.id);
    return 'ACTIVE' as const;
  }
  return u.status;
}
