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

/** 생성 작업 크레딧 예약: 사용 가능 잔액에서 빼서 예약분으로 옮긴다. 잔액이 모자라면 INSUFFICIENT_CREDIT. */
export async function reserveCredits(tx: Tx, userId: string, cost: number, jobId: string) {
  await ensureWallet(tx, userId);
  const w = await tx.wallet.update({ where: { userId }, data: { creditBalance: { decrement: cost }, creditReserved: { increment: cost } } });
  if (w.creditBalance < 0) throw new ApiError('INSUFFICIENT_CREDIT');
  await tx.creditTransaction.create({
    data: { userId, type: 'RESERVE', amount: -cost, balanceAfter: w.creditBalance, refType: 'JOB', refId: jobId },
  });
}

/** 성공: 예약분을 확정(사용 완료). 잔액 변화는 없으므로 내역의 amount 는 0. */
export async function consumeCredits(tx: Tx, userId: string, cost: number, jobId: string) {
  const w = await tx.wallet.update({ where: { userId }, data: { creditReserved: { decrement: cost } } });
  await tx.creditTransaction.create({
    data: { userId, type: 'CONSUME', amount: 0, balanceAfter: w.creditBalance, refType: 'JOB', refId: jobId },
  });
}

/** 실패·취소: 예약분을 사용 가능 잔액으로 되돌린다. */
export async function releaseCredits(tx: Tx, userId: string, cost: number, jobId: string) {
  const w = await tx.wallet.update({ where: { userId }, data: { creditReserved: { decrement: cost }, creditBalance: { increment: cost } } });
  await tx.creditTransaction.create({
    data: { userId, type: 'RELEASE', amount: cost, balanceAfter: w.creditBalance, refType: 'JOB', refId: jobId },
  });
}
