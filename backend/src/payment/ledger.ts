import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** 판매자 장부에 한 줄을 추가한다. 같은 판매자의 동시 기록이 잔액을 꼬이지 않게 행 잠금을 건다. */
export async function ledgerAdd(
  tx: Tx,
  creatorId: string,
  type: 'SALE' | 'FEE' | 'REFUND' | 'DONATION' | 'SETTLEMENT',
  amount: number,
  ref: { type: string; id: string },
) {
  await tx.$queryRaw`SELECT id FROM "Creator" WHERE id = ${creatorId} FOR UPDATE`;
  const last = await tx.sellerLedger.findFirst({ where: { creatorId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  return tx.sellerLedger.create({
    data: { creatorId, type, amount, balanceAfter: (last?.balanceAfter ?? 0) + amount, refType: ref.type, refId: ref.id },
  });
}

/** 환불 때 되돌릴 활동 포인트(보유량 한도 안에서). 원래 지급 내역이 없으면 아무 것도 하지 않는다. */
export async function revokePoints(tx: Tx, userId: string, rule: string, ref: { type: string; id: string }) {
  const orig = await tx.pointTransaction.findFirst({ where: { userId, rule, refType: ref.type, refId: ref.id, type: 'EARN' } });
  if (!orig) return;
  const w = await tx.wallet.findUnique({ where: { userId } });
  const amount = Math.min(orig.amount, w?.pointBalance ?? 0);
  if (amount <= 0) return;
  const upd = await tx.wallet.update({ where: { userId }, data: { pointBalance: { decrement: amount } } });
  await tx.pointTransaction.create({
    data: { userId, type: 'REVOKE', rule, amount: -amount, balanceAfter: upd.pointBalance, refType: ref.type, refId: ref.id },
  });
}
