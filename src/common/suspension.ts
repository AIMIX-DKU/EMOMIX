import type { PrismaService } from '../prisma.service.js';

/** 기간이 정해진 정지는 만료 시점에 자동으로 풀린다(크론 없이 접근할 때 처리). 현재 유효한 상태를 돌려준다. */
export async function effectiveStatus(
  prisma: PrismaService,
  u: { id: string; status: 'ACTIVE' | 'SUSPENDED' | 'WITHDRAWN'; suspendedUntil: Date | null },
) {
  if (u.status === 'SUSPENDED' && u.suspendedUntil && u.suspendedUntil < new Date()) {
    await prisma.user.update({ where: { id: u.id }, data: { status: 'ACTIVE', suspendedReason: null, suspendedUntil: null } });
    return 'ACTIVE' as const;
  }
  return u.status;
}
