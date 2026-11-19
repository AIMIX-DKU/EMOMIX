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
    if (this.mock) {
      if (paymentKey.startsWith('nocancel_')) throw new ApiError('PAYMENT_FAILED', '환불 요청에 실패했습니다.');
      return;
    }
    const r = await fetch(`${API}/${encodeURIComponent(paymentKey)}/cancel`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ cancelReason: reason.slice(0, 200) }),
    });
    if (!r.ok) throw new ApiError('PAYMENT_FAILED', '환불 요청에 실패했습니다.');
  }

  // ───────── 자동결제(빌링) ─────────
  /** 카드 등록 성공 후 받은 authKey 로 billingKey 를 발급받는다. 카드번호 원문은 받지도 저장하지도 않는다(마스킹 값만). */
  async issueBillingKey(authKey: string, customerKey: string): Promise<{ billingKey: string; cardCompany: string; cardNumberMasked: string }> {
    if (this.mock) {
      if (authKey.startsWith('fail_')) throw new ApiError('PAYMENT_FAILED', '카드 등록에 실패했습니다.');
      // authKey 에 renewfail 이 들어 있으면 이후 갱신 결제가 실패하는 카드로 흉내낸다(테스트 전용)
      return { billingKey: `mock_bk_${authKey.includes('renewfail') ? 'renewfail_' : ''}${Math.random().toString(36).slice(2, 10)}`, cardCompany: '삼성', cardNumberMasked: '1234-56**-****-7890' };
    }
    const r = await fetch(`${API.replace('/payments', '/billing')}/authorizations/issue`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ authKey, customerKey }),
    });
    const j = (await r.json().catch(() => ({}))) as { billingKey?: string; cardCompany?: string; card?: { number?: string; issuerCode?: string }; cardNumber?: string; message?: string };
    if (!r.ok || !j.billingKey) throw new ApiError('PAYMENT_FAILED', j.message ? `카드 등록에 실패했습니다. (${j.message})` : '카드 등록에 실패했습니다.');
    const num = (j.cardNumber ?? j.card?.number ?? '').replace(/(\d{4})(\d{2})(\d*)(\d{4})?/, '$1-$2**-****-$4') || '카드';
    return { billingKey: j.billingKey, cardCompany: j.cardCompany ?? j.card?.issuerCode ?? '카드', cardNumberMasked: num };
  }

  /** 등록된 카드로 청구한다. orderId 는 청구마다 고유해야 한다(같은 orderId 로 다시 요청해도 PG 가 중복 결제를 막는다). */
  async chargeBilling(p: { billingKey: string; customerKey: string; amount: number; orderId: string; orderName: string }): Promise<TossPayment> {
    if (this.mock) {
      if (p.billingKey.includes('renewfail') && p.orderName.includes('갱신')) throw new ApiError('PAYMENT_FAILED', '카드 잔액 부족');
      return { paymentKey: `mock_pay_${p.orderId}`, orderId: p.orderId, status: 'DONE', totalAmount: p.amount, method: 'card', approvedAt: new Date().toISOString() };
    }
    const r = await fetch(`${API.replace('/payments', '/billing')}/${encodeURIComponent(p.billingKey)}`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ customerKey: p.customerKey, amount: p.amount, orderId: p.orderId, orderName: p.orderName }),
    });
    const j = (await r.json().catch(() => ({}))) as Partial<TossPayment> & { message?: string };
    if (!r.ok || j.status !== 'DONE') throw new ApiError('PAYMENT_FAILED', j.message ? `결제에 실패하였습니다. (${j.message})` : undefined);
    return j as TossPayment;
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
