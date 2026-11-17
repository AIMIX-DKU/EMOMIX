import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env, isProd } from '../config.js';
import { ApiError } from '../common/envelope.js';

export interface TossPayment {
  paymentKey: string;
  orderId: string;
  status: string; // DONE | CANCELED | ABORTED | EXPIRED ...
  totalAmount: number;
  method?: string;
  approvedAt?: string;
}

const API = 'https://api.tosspayments.com/v1/payments';

/** 토스페이먼츠 API. 시제품은 테스트 키(test_sk_...)로 가상 결제만 한다.
 *  TOSS_MOCK=1 은 자동 테스트 전용(운영에서는 무시). 실제 결제창 없이 paymentKey 를 만들 수 없기 때문이다. */
@Injectable()
export class TossService {
  private get mock() {
    return env('TOSS_MOCK') === '1' && !isProd();
  }

  private headers() {
    return { Authorization: 'Basic ' + Buffer.from(env('TOSS_SECRET_KEY') + ':').toString('base64'), 'Content-Type': 'application/json' };
  }

  async confirm(paymentKey: string, orderId: string, amount: number): Promise<TossPayment> {
    if (this.mock) {
      if (paymentKey.startsWith('fail_')) throw new ApiError('PAYMENT_FAILED');
      return { paymentKey, orderId, status: 'DONE', totalAmount: amount, method: 'card', approvedAt: new Date().toISOString() };
    }
    const r = await fetch(`${API}/confirm`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ paymentKey, orderId, amount }) });
    const j = (await r.json().catch(() => ({}))) as Partial<TossPayment> & { message?: string };
    if (!r.ok || j.status !== 'DONE') throw new ApiError('PAYMENT_FAILED', j.message ? `결제에 실패하였습니다. (${j.message})` : undefined);
    return j as TossPayment;
  }

  /** PG 에 취소(환불)를 요청한다. 실패하면 PAYMENT_FAILED. */
  async cancel(paymentKey: string, reason: string) {
    if (this.mock) return;
    const r = await fetch(`${API}/${encodeURIComponent(paymentKey)}/cancel`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ cancelReason: reason.slice(0, 200) }),
    });
    if (!r.ok) throw new ApiError('PAYMENT_FAILED', '환불 요청에 실패했습니다.');
  }

  /** 웹훅 본문을 그대로 믿지 않고 PG 에서 결제 상태를 다시 조회한다. */
  async get(paymentKey: string, hint: { orderId: string; status: string; amount: number }): Promise<TossPayment | null> {
    if (this.mock) return { paymentKey, orderId: hint.orderId, status: hint.status, totalAmount: hint.amount };
    const r = await fetch(`${API}/${encodeURIComponent(paymentKey)}`, { headers: this.headers() });
    return r.ok ? ((await r.json()) as TossPayment) : null;
  }

  /** 웹훅 서명: HMAC-SHA256(원문 본문, 웹훅 비밀값)의 hex. */
  verifySignature(raw: Buffer | undefined, signature: string | undefined) {
    const secret = env('TOSS_WEBHOOK_SECRET') || env('TOSS_SECRET_KEY');
    if (!raw || !signature || !secret) return false;
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
