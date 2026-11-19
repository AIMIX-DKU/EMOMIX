import type { CreditTxType, Prisma, Wallet } from '@prisma/client';
import { ApiError } from './envelope.js';

type Tx = Prisma.TransactionClient;

/** 크레딧(생성 이용권)은 두 통으로 센다.
 *  - creditBalance: 구매·체험·교환·운영자 지급(소멸 없음)
 *  - subscriptionCredits: 구독 월 크레딧(이월 없음, subscriptionExpiresAt 에 소멸)
 *  사용자에게 보이는 잔액 = 두 통의 합. 생성할 때는 소멸이 빠른 구독 크레딧을 먼저 쓴다. */

/** 구독 기간 끝과 갱신 크론 실행 사이의 시간 차이를 흡수하는 여유(갱신 전에 크레딧이 사라지지 않게). */
export const SUB_GRACE_MS = 6 * 3600 * 1000;

export const subAvailable = (w: Pick<Wallet, 'subscriptionCredits' | 'subscriptionExpiresAt'>, now = Date.now()) =>
  w.subscriptionExpiresAt && w.subscriptionExpiresAt.getTime() + SUB_GRACE_MS > now ? w.subscriptionCredits : 0;

export const totalCredits = (w: Pick<Wallet, 'creditBalance' | 'subscriptionCredits' | 'subscriptionExpiresAt'>) => w.creditBalance + subAvailable(w);

/** 지갑이 없으면 만든다. */
export const ensureWallet = (tx: Tx, userId: string) => tx.wallet.upsert({ where: { userId }, create: { userId }, update: {} });

/** 같은 사용자의 지갑 변경을 줄 세우기 위한 행 잠금. */
export const lockWallet = async (tx: Tx, userId: string) => {
  await ensureWallet(tx, userId);
  await tx.$queryRaw`SELECT "userId" FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
};

/** 기간이 지난 구독 크레딧을 소멸시키고 내역을 남긴다(크론 없이 지갑을 만질 때 처리). */
export async function settleSubscriptionExpiry(tx: Tx, userId: string) {
  const w = await tx.wallet.findUnique({ where: { userId } });
  if (!w || w.subscriptionCredits <= 0 || !w.subscriptionExpiresAt || w.subscriptionExpiresAt.getTime() + SUB_GRACE_MS > Date.now()) return;
  await tx.wallet.update({ where: { userId }, data: { subscriptionCredits: 0, subscriptionExpiresAt: null } });
  await tx.creditTransaction.create({
    data: { userId, type: 'SUBSCRIPTION_EXPIRE', amount: -w.subscriptionCredits, balanceAfter: w.creditBalance, refType: 'SUBSCRIPTION', refId: userId },
  });
}

/** 크레딧 증감(구매·체험·교환·환불·운영자 지급 등, 소멸 없는 통). amount 는 부호 있는 값. 잔액이 음수가 되면 INSUFFICIENT_CREDIT. */
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
    data: { userId, type, amount, balanceAfter: totalCredits(w), refType: ref?.type, refId: ref?.id },
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

/** 생성 작업 크레딧 예약: 구독 크레딧을 먼저, 모자라면 일반 크레딧에서 빼서 예약분으로 옮긴다. 합이 모자라면 INSUFFICIENT_CREDIT. */
export async function reserveCredits(tx: Tx, userId: string, cost: number, jobId: string) {
  await lockWallet(tx, userId);
  await settleSubscriptionExpiry(tx, userId);
  const cur = await tx.wallet.findUniqueOrThrow({ where: { userId } });
  const sub = subAvailable(cur);
  if (cur.creditBalance + sub < cost) throw new ApiError('INSUFFICIENT_CREDIT');
  const fromSub = Math.min(sub, cost);
  const w = await tx.wallet.update({
    where: { userId },
    data: { subscriptionCredits: { decrement: fromSub }, creditBalance: { decrement: cost - fromSub }, creditReserved: { increment: cost } },
  });
  await tx.generationJob.update({ where: { id: jobId }, data: { subCreditsUsed: fromSub } }); // 반환할 때 어느 통으로 돌려줄지 기억
  await tx.creditTransaction.create({
    data: { userId, type: 'RESERVE', amount: -cost, balanceAfter: totalCredits(w), refType: 'JOB', refId: jobId },
  });
}

/** 성공: 예약분을 확정(사용 완료). 잔액 변화는 없으므로 내역의 amount 는 0. */
export async function consumeCredits(tx: Tx, userId: string, cost: number, jobId: string) {
  const w = await tx.wallet.update({ where: { userId }, data: { creditReserved: { decrement: cost } } });
  await tx.creditTransaction.create({
    data: { userId, type: 'CONSUME', amount: 0, balanceAfter: totalCredits(w), refType: 'JOB', refId: jobId },
  });
}

/** 실패·취소: 예약분을 되돌린다. 구독 크레딧에서 나온 만큼은 구독 통으로(아직 소멸 전이면), 나머지는 일반 통으로. */
export async function releaseCredits(tx: Tx, userId: string, cost: number, jobId: string) {
  const job = await tx.generationJob.findUnique({ where: { id: jobId }, select: { subCreditsUsed: true } });
  const cur = await tx.wallet.findUniqueOrThrow({ where: { userId } });
  const alive = !!cur.subscriptionExpiresAt && cur.subscriptionExpiresAt.getTime() + SUB_GRACE_MS > Date.now();
  const subBack = alive ? Math.min(cost, job?.subCreditsUsed ?? 0) : 0;
  const w = await tx.wallet.update({
    where: { userId },
    data: { creditReserved: { decrement: cost }, subscriptionCredits: { increment: subBack }, creditBalance: { increment: cost - subBack } },
  });
  if (job) await tx.generationJob.update({ where: { id: jobId }, data: { subCreditsUsed: Math.max(0, job.subCreditsUsed - Math.min(cost, job.subCreditsUsed)) } });
  await tx.creditTransaction.create({
    data: { userId, type: 'RELEASE', amount: cost, balanceAfter: totalCredits(w), refType: 'JOB', refId: jobId },
  });
}

/** 구독 월 크레딧 지급: 남은 구독 크레딧은 소멸(이월 없음)하고 새로 지급한다. */
export async function grantSubscriptionCredits(tx: Tx, userId: string, amount: number, periodEnd: Date, refId: string) {
  await lockWallet(tx, userId);
  const cur = await tx.wallet.findUniqueOrThrow({ where: { userId } });
  if (cur.subscriptionCredits > 0) {
    await tx.creditTransaction.create({
      data: { userId, type: 'SUBSCRIPTION_EXPIRE', amount: -cur.subscriptionCredits, balanceAfter: cur.creditBalance, refType: 'SUBSCRIPTION', refId },
    });
  }
  const w = await tx.wallet.update({ where: { userId }, data: { subscriptionCredits: amount, subscriptionExpiresAt: periodEnd } });
  await tx.creditTransaction.create({
    data: { userId, type: 'SUBSCRIPTION_GRANT', amount, balanceAfter: totalCredits(w), refType: 'SUBSCRIPTION', refId },
  });
}

/** 구독이 끝날 때 남은 구독 크레딧을 소멸시킨다. */
export async function expireSubscriptionCredits(tx: Tx, userId: string, refId: string) {
  await lockWallet(tx, userId);
  const cur = await tx.wallet.findUniqueOrThrow({ where: { userId } });
  if (cur.subscriptionCredits > 0) {
    await tx.creditTransaction.create({
      data: { userId, type: 'SUBSCRIPTION_EXPIRE', amount: -cur.subscriptionCredits, balanceAfter: cur.creditBalance, refType: 'SUBSCRIPTION', refId },
    });
  }
  await tx.wallet.update({ where: { userId }, data: { subscriptionCredits: 0, subscriptionExpiresAt: null } });
}
