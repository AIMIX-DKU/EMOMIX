import type { CreditTxType, Prisma } from '@prisma/client';
import { ApiError } from './envelope.js';

type Tx = Prisma.TransactionClient;

/** 지갑이 없으면 만든다. */
export const ensureWallet = (tx: Tx, userId: string) =>
  tx.wallet.upsert({ where: { userId }, create: { userId }, update: {} });

/** 크레딧 증감. amount 는 부호 있는 값. 사용 가능 잔액(creditBalance)이 음수가 되면 INSUFFICIENT_CREDIT. */
export async function creditChange(
  tx: Tx,
  userId: string,
  type: CreditTxType,
  amount: number,
  ref?: { type: string; id: string },
) {
  await ensureWallet(tx, userId);
  const w = await tx.wallet.update({ where: { userId }, data: { creditBalance: { increment: amount } } });
  if (w.creditBalance < 0) throw new ApiError('INSUFFICIENT_CREDIT');
  await tx.creditTransaction.create({
    data: { userId, type, amount, balanceAfter: w.creditBalance, refType: ref?.type, refId: ref?.id },
  });
  return w;
}

/** 활동 포인트 증감. */
export async function pointChange(
  tx: Tx,
  userId: string,
  type: string,
  amount: number,
  opts: { rule?: string; refType?: string; refId?: string } = {},
) {
  await ensureWallet(tx, userId);
  const w = await tx.wallet.update({ where: { userId }, data: { pointBalance: { increment: amount } } });
  if (w.pointBalance < 0) throw new ApiError('INSUFFICIENT_POINT');
  await tx.pointTransaction.create({
    data: { userId, type, amount, balanceAfter: w.pointBalance, rule: opts.rule, refType: opts.refType, refId: opts.refId },
  });
  return w;
}
