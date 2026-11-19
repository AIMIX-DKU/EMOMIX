import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StorageService } from '../src/common/storage.service.js';
import { SubscriptionService } from '../src/subscription/subscription.service.js';
import { becomeCreator, cleanup, client, createApp, idemKey, idemPost, signedUp, worker, type Client } from './helpers.js';

const DAY = 24 * 3600 * 1000;

describe('구독(정기결제)', () => {
  let app: INestApplication;
  let ctx: Awaited<ReturnType<typeof createApp>>;
  let subs: SubscriptionService;
  let w: ReturnType<typeof worker>;
  beforeAll(async () => {
    ctx = await createApp();
    app = ctx.app;
    subs = app.get(SubscriptionService);
    w = worker(app);
    await cleanup(ctx.prisma, app.get(StorageService));
  });
  afterAll(async () => {
    await cleanup(ctx.prisma, app.get(StorageService));
    await app.close();
  });

  const me = async (c: Client) => (await c.get('/subscriptions/me')).body.data;
  const wallet = async (c: Client) => (await c.get('/wallet')).body.data.credit as { balance: number; reserved: number; subscriptionBalance: number; subscriptionExpiresAt: string | null };
  const start = async (c: Client, planCode = 'STANDARD', authKey = `auth_${idemKey()}`) => {
    const key = (await me(c)).customerKey;
    return idemPost(c, '/subscriptions', { planCode, authKey, customerKey: key });
  };
  const subRow = (userId: string) => ctx.prisma.subscription.findUniqueOrThrow({ where: { userId } });
  /** 결제일이 지난 것처럼 만든다(시간 여행). */
  const makeDue = (userId: string, extra: Record<string, Date> = {}) =>
    ctx.prisma.subscription.update({ where: { userId }, data: { nextBillingAt: new Date(Date.now() - 1000), currentPeriodEnd: new Date(Date.now() - 1000), ...extra } });

  let u: Awaited<ReturnType<typeof signedUp>>;

  it('요금제 3종 조회(비로그인)와 내 구독(구독 없음)', async () => {
    const plans = (await client(app).get('/subscription-plans')).body.data.items;
    expect(plans.map((p: { code: string }) => p.code)).toEqual(['FREE', 'STANDARD', 'PRO']);
    expect(plans[1]).toMatchObject({ price: 4900, monthlyCredits: 70, dailyGenerationLimit: 100, priorityQueue: true, sellerFeeRate: 0.15 });
    expect(plans[2]).toMatchObject({ price: 9900, monthlyCredits: 160, dailyGenerationLimit: 200, sellerFeeRate: 0.1 });
    expect(plans[0]).toMatchObject({ price: 0, priorityQueue: false, sellerFeeRate: 0.2 });

    u = await signedUp(app, ctx.mail);
    const m = await me(u.c);
    expect(m.customerKey).toMatch(/^cus-[0-9a-f]{24}$/);
    expect(m.customerKey).toBe((await me(u.c)).customerKey); // 변하지 않는 값
    expect(m.plan.code).toBe('FREE');
    expect(m.subscription).toBeNull();
    expect((await client(app).get('/subscriptions/me')).status).toBe(401);
  });

  it('구독 시작 검증: FREE/잘못된 customerKey/카드 등록 실패(구독이 만들어지지 않음)', async () => {
    const key = (await me(u.c)).customerKey;
    expect((await idemPost(u.c, '/subscriptions', { planCode: 'FREE', authKey: 'a', customerKey: key })).body.errorCode).toBe('VALIDATION_ERROR');
    expect((await idemPost(u.c, '/subscriptions', { planCode: 'STANDARD', authKey: 'a', customerKey: 'cus-other' })).body.errorCode).toBe('VALIDATION_ERROR');
    expect((await u.c.post('/subscriptions', { planCode: 'STANDARD', authKey: 'a', customerKey: key })).body.errorCode).toBe('VALIDATION_ERROR'); // Idempotency-Key 없음
    const bad = await start(u.c, 'STANDARD', 'fail_card');
    expect(bad.status).toBe(402);
    expect(bad.body.errorCode).toBe('PAYMENT_FAILED');
    expect((await me(u.c)).subscription).toBeNull();
    expect((await wallet(u.c)).subscriptionBalance).toBe(0);
  });

  it('구독 시작: 첫 달 결제 + 월 크레딧 지급 + 주문·내역 기록, 중복 구독·환불 불가', async () => {
    const key = (await me(u.c)).customerKey;
    const authKey = `auth_${idemKey()}`;
    const idem = idemKey();
    const r = await idemPost(u.c, '/subscriptions', { planCode: 'STANDARD', authKey, customerKey: key }, idem);
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      planCode: 'STANDARD', status: 'ACTIVE', cancelAtPeriodEnd: false, scheduledPlanCode: null, failedAttempts: 0, grantedCredits: 70,
      card: { company: '삼성', numberMasked: '1234-56**-****-7890' },
    });
    expect(new Date(r.body.data.nextBillingAt).getTime()).toBe(new Date(r.body.data.currentPeriodEnd).getTime());
    expect(new Date(r.body.data.currentPeriodEnd).getTime()).toBeGreaterThan(Date.now() + 27 * DAY);
    // 같은 멱등성 키로 다시 보내면 같은 결과, 한 번만 결제
    expect((await idemPost(u.c, '/subscriptions', { planCode: 'STANDARD', authKey, customerKey: key }, idem)).body.data.currentPeriodStart).toBe(r.body.data.currentPeriodStart);
    expect((await start(u.c)).body.errorCode).toBe('ALREADY_SUBSCRIBED');

    const w1 = await wallet(u.c);
    expect(w1).toMatchObject({ balance: 90, subscriptionBalance: 70, reserved: 0 }); // 체험 20 + 구독 70
    expect(w1.subscriptionExpiresAt).toBe(r.body.data.currentPeriodEnd);
    const types = (await u.c.get('/wallet/credit-transactions?size=50')).body.data.items.map((t: { type: string }) => t.type);
    expect(types).toContain('SUBSCRIPTION_GRANT');
    expect((await u.c.get('/wallet/credit-transactions?type=SUBSCRIPTION_GRANT')).body.data.totalElements).toBe(1);

    const inv = (await u.c.get('/subscriptions/me/invoices')).body.data;
    expect(inv.totalElements).toBe(1);
    expect(inv.items[0]).toMatchObject({ planCode: 'STANDARD', amount: 4900, status: 'PAID', creditsGranted: 70, failReason: null });
    const orders = (await u.c.get('/orders?type=SUBSCRIPTION')).body.data;
    expect(orders.items[0]).toMatchObject({ type: 'SUBSCRIPTION', status: 'PAID', amount: 4900, orderNo: inv.items[0].orderNo });
    expect((await u.c.post(`/orders/${inv.items[0].orderNo}/cancel`, { reason: '환불해줘' })).body.errorCode).toBe('NOT_REFUNDABLE');

    const m = await me(u.c);
    expect(m.plan.code).toBe('STANDARD');
    expect(m.subscription).toMatchObject({ planCode: 'STANDARD', status: 'ACTIVE' });
    // 카드번호 원문/빌링키는 응답에 없다
    expect(JSON.stringify(r.body)).not.toMatch(/billingKey|mock_bk/);
  });

  it('생성: 구독 크레딧을 먼저 쓰고, 취소하면 구독 크레딧으로 돌아가며, 작업은 우선 대기열', async () => {
    const ch = (await u.c.post('/characters', { name: '구독곰', description: '갈색 곰', stylePreset: 'pastel' })).body.data.id;
    const job = await idemPost(u.c, `/characters/${ch}/candidates`, { count: 4 });
    expect(job.status).toBe(202);
    expect(await wallet(u.c)).toMatchObject({ balance: 86, reserved: 4, subscriptionBalance: 66 }); // 구독 70 → 66, 일반 20 그대로
    expect((await ctx.prisma.wallet.findUniqueOrThrow({ where: { userId: u.id } })).creditBalance).toBe(20);
    expect((await ctx.prisma.generationJob.findUniqueOrThrow({ where: { id: job.body.data.jobId } })).priority).toBe(1);
    expect((await u.c.post(`/generations/${job.body.data.jobId}/cancel`)).status).toBe(200);
    expect(await wallet(u.c)).toMatchObject({ balance: 90, reserved: 0, subscriptionBalance: 70 }); // 구독 통으로 반환
    expect((await u.c.post('/generations/estimates', { type: 'EMOTION_SET', count: 8 })).body.data).toMatchObject({ creditBalance: 90, sufficient: true });
  });

  it('요금제 변경 예약, 해지·해지 취소', async () => {
    expect((await u.c.patch('/subscriptions/me', { planCode: 'STANDARD' })).body.errorCode).toBe('VALIDATION_ERROR'); // 현재와 같음
    expect((await u.c.patch('/subscriptions/me', { planCode: 'FREE' })).body.errorCode).toBe('VALIDATION_ERROR');
    expect((await u.c.patch('/subscriptions/me', { planCode: 'PRO' })).body.data).toMatchObject({ planCode: 'STANDARD', scheduledPlanCode: 'PRO' }); // 지금 혜택은 그대로
    expect((await u.c.patch('/subscriptions/me', { planCode: 'STANDARD' })).body.data.scheduledPlanCode).toBeNull(); // 예약 취소
    expect((await u.c.patch('/subscriptions/me', { planCode: 'PRO' })).body.data.scheduledPlanCode).toBe('PRO');

    const cancel = await u.c.del('/subscriptions/me');
    expect(cancel.body.data).toMatchObject({ cancelAtPeriodEnd: true, nextBillingAt: null, scheduledPlanCode: null, status: 'ACTIVE' });
    expect((await me(u.c)).plan.code).toBe('STANDARD'); // 기간 끝까지 혜택 유지
    expect((await wallet(u.c)).subscriptionBalance).toBe(70);
    expect((await u.c.del('/subscriptions/me')).status).toBe(200); // 이미 해지 예약이어도 성공
    expect((await u.c.patch('/subscriptions/me', { planCode: 'PRO' })).body.errorCode).toBe('VALIDATION_ERROR'); // 해지 예약 중에는 변경 불가
    const resumed = await u.c.post('/subscriptions/me/resume');
    expect(resumed.body.data).toMatchObject({ cancelAtPeriodEnd: false });
    expect(resumed.body.data.nextBillingAt).toBe(resumed.body.data.currentPeriodEnd);
    expect((await u.c.patch('/subscriptions/me', { planCode: 'PRO' })).body.data.scheduledPlanCode).toBe('PRO'); // 다음 갱신용으로 다시 예약

    const stranger = await signedUp(app, ctx.mail);
    expect((await stranger.c.del('/subscriptions/me')).body.errorCode).toBe('NOT_SUBSCRIBED');
    expect((await stranger.c.post('/subscriptions/me/resume')).body.errorCode).toBe('NOT_SUBSCRIBED');
    expect((await stranger.c.patch('/subscriptions/me', { planCode: 'PRO' })).body.errorCode).toBe('NOT_SUBSCRIBED');
  });

  it('갱신 성공: 예약한 요금제로 바뀌고, 남은 구독 크레딧은 소멸(이월 없음)한 뒤 새로 지급, 두 번 청구하지 않음', async () => {
    const before = await subRow(u.id);
    await makeDue(u.id);
    expect(await subs.renewOne(before.id)).toBe('charged');
    const after = await subRow(u.id);
    expect(after).toMatchObject({ planCode: 'PRO', scheduledPlanCode: null, status: 'ACTIVE', failedAttempts: 0 });
    expect(after.currentPeriodStart.getTime()).toBeLessThanOrEqual(Date.now());
    expect(after.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now() + 25 * DAY);
    expect(after.nextBillingAt!.getTime()).toBe(after.currentPeriodEnd.getTime());

    expect(await wallet(u.c)).toMatchObject({ subscriptionBalance: 160, balance: 180 }); // 70 이 쌓이지 않고 160 으로 교체 + 일반 20
    const tx = (await u.c.get('/wallet/credit-transactions?size=50')).body.data.items as { type: string; amount: number }[];
    expect(tx.find((t) => t.type === 'SUBSCRIPTION_EXPIRE')).toMatchObject({ amount: -70 });
    expect(tx.filter((t) => t.type === 'SUBSCRIPTION_GRANT').map((t) => t.amount).sort()).toEqual([160, 70]);

    expect(await subs.renewOne(before.id)).toBe('skip'); // 결제일이 아직 안 됨 → 중복 청구 없음
    const inv = (await u.c.get('/subscriptions/me/invoices')).body.data.items;
    expect(inv).toHaveLength(2);
    expect(inv[0]).toMatchObject({ planCode: 'PRO', amount: 9900, status: 'PAID', creditsGranted: 160 });
    expect((await me(u.c)).plan).toMatchObject({ code: 'PRO', dailyGenerationLimit: 200, sellerFeeRate: 0.1 });
  });

  it('결제 실패: 유예(혜택 유지) 후 하루 간격 재시도, 4번 실패하면 종료·크레딧 소멸', async () => {
    const f = await signedUp(app, ctx.mail);
    expect((await start(f.c, 'STANDARD', 'auth_renewfail_1')).status).toBe(201); // 첫 결제는 성공, 갱신은 실패하는 카드
    const id = (await subRow(f.id)).id;

    await makeDue(f.id);
    expect(await subs.renewOne(id)).toBe('failed');
    let s = await subRow(f.id);
    expect(s).toMatchObject({ status: 'PAST_DUE', failedAttempts: 1 });
    expect(s.nextBillingAt!.getTime()).toBeGreaterThan(Date.now() + 20 * 3600 * 1000); // 다음 날 재시도
    expect((await me(f.c)).plan.code).toBe('STANDARD'); // 유예 기간에도 혜택 유지
    expect((await wallet(f.c)).subscriptionBalance).toBe(70);
    const inv = (await f.c.get('/subscriptions/me/invoices')).body.data.items;
    expect(inv[0]).toMatchObject({ status: 'FAILED', orderNo: null });
    expect(inv[0].failReason).toContain('잔액');
    expect(await subs.renewOne(id)).toBe('skip'); // 재시도 시각 전에는 다시 청구하지 않는다

    for (const n of [2, 3]) {
      await ctx.prisma.subscription.update({ where: { id }, data: { nextBillingAt: new Date(Date.now() - 1000) } });
      expect(await subs.renewOne(id)).toBe('failed');
      expect((await subRow(f.id)).failedAttempts).toBe(n);
    }
    await ctx.prisma.subscription.update({ where: { id }, data: { nextBillingAt: new Date(Date.now() - 1000) } });
    expect(await subs.renewOne(id)).toBe('ended'); // 4번째 실패
    s = await subRow(f.id);
    expect(s).toMatchObject({ status: 'CANCELED', nextBillingAt: null });
    expect((await me(f.c)).subscription).toBeNull();
    expect((await me(f.c)).plan.code).toBe('FREE');
    expect(await wallet(f.c)).toMatchObject({ subscriptionBalance: 0, balance: 20 }); // 구독 크레딧 소멸, 일반 크레딧은 유지
    const types = (await f.c.get('/wallet/credit-transactions?size=50')).body.data.items.map((t: { type: string }) => t.type);
    expect(types).toContain('SUBSCRIPTION_EXPIRE');
    expect(await subs.renewOne(id)).toBe('skip'); // 종료된 구독은 처리하지 않음
    expect((await f.c.del('/subscriptions/me')).body.errorCode).toBe('NOT_SUBSCRIBED');
    // 다시 시작할 수 있다
    expect((await start(f.c, 'PRO')).status).toBe(201);
    expect(await wallet(f.c)).toMatchObject({ subscriptionBalance: 160, balance: 180 });
  });

  it('결제 카드 변경: 미납(PAST_DUE)이면 새 카드로 바로 재결제', async () => {
    const f = await signedUp(app, ctx.mail);
    await start(f.c, 'STANDARD', 'auth_renewfail_2');
    const id = (await subRow(f.id)).id;
    await makeDue(f.id);
    expect(await subs.renewOne(id)).toBe('failed');
    expect((await f.c.get('/subscriptions/me')).body.data.subscription.status).toBe('PAST_DUE');

    const key = (await me(f.c)).customerKey;
    expect((await f.c.put('/subscriptions/me/payment-method', { authKey: 'fail_new', customerKey: key })).body.errorCode).toBe('PAYMENT_FAILED');
    expect((await f.c.put('/subscriptions/me/payment-method', { authKey: 'a', customerKey: 'cus-x' })).body.errorCode).toBe('VALIDATION_ERROR');
    const ok = await f.c.put('/subscriptions/me/payment-method', { authKey: 'new_good_card', customerKey: key });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'ACTIVE', failedAttempts: 0 }); // 새 카드로 미납분 결제 성공
    const inv = (await f.c.get('/subscriptions/me/invoices')).body.data.items.map((i: { status: string }) => i.status);
    expect(inv).toEqual(['PAID', 'FAILED', 'PAID']);
  });

  it('해지 예약은 기간이 끝나면 종료되고 크레딧이 소멸한다. PAST_DUE 에서 해지하면 바로 종료', async () => {
    const d = await signedUp(app, ctx.mail);
    await start(d.c);
    await d.c.del('/subscriptions/me');
    const id = (await subRow(d.id)).id;
    expect(await subs.renewOne(id)).toBe('skip'); // 아직 기간 중
    expect((await me(d.c)).subscription).toMatchObject({ cancelAtPeriodEnd: true });
    await ctx.prisma.subscription.update({ where: { id }, data: { currentPeriodEnd: new Date(Date.now() - 1000) } });
    expect(await subs.renewOne(id)).toBe('ended');
    expect(await subRow(d.id)).toMatchObject({ status: 'CANCELED' });
    expect(await wallet(d.c)).toMatchObject({ subscriptionBalance: 0, balance: 20 });
    expect((await d.c.post('/subscriptions/me/resume')).body.errorCode).toBe('VALIDATION_ERROR'); // 종료된 구독은 다시 시작해야 함

    const p = await signedUp(app, ctx.mail);
    await start(p.c, 'STANDARD', 'auth_renewfail_3');
    await makeDue(p.id);
    await subs.renewOne((await subRow(p.id)).id); // → PAST_DUE
    expect((await p.c.del('/subscriptions/me')).body.data.status).toBe('CANCELED');
    expect((await me(p.c)).subscription).toBeNull();
    expect((await wallet(p.c)).subscriptionBalance).toBe(0);
  });

  it('혜택: 구독자의 작업이 먼저 처리되고, 판매 수수료율이 요금제를 따른다', async () => {
    const free = await signedUp(app, ctx.mail);
    const sub = await signedUp(app, ctx.mail);
    await start(sub.c, 'PRO');
    const chF = (await free.c.post('/characters', { name: 'a', description: 'b', stylePreset: 'pastel' })).body.data.id;
    const chS = (await sub.c.post('/characters', { name: 'a', description: 'b', stylePreset: 'pastel' })).body.data.id;
    const jobFree = (await idemPost(free.c, `/characters/${chF}/candidates`, { count: 1 })).body.data; // 먼저 요청
    const jobSub = (await idemPost(sub.c, `/characters/${chS}/candidates`, { count: 1 })).body.data; // 나중에 요청
    expect(jobSub.queuePosition).toBe(1); // 나중에 왔지만 우선순위로 맨 앞
    expect((await free.c.get(`/generations/${jobFree.jobId}`)).body.data.queuePosition).toBe(2);
    const first = (await w.claim()).body.data.job;
    expect(first.jobId).toBe(jobSub.jobId);
    const second = (await w.claim()).body.data.job;
    expect(second.jobId).toBe(jobFree.jobId);
    await w.finish(jobSub.jobId, 1);
    await w.finish(jobFree.jobId, 1);

    await becomeCreator(sub.c);
    await becomeCreator(free.c);
    expect((await sub.c.get('/seller/balance')).body.data.feeRate).toBe(0.1); // PRO
    expect((await free.c.get('/seller/balance')).body.data.feeRate).toBe(0.2); // FREE
  });

  it('크론 엔드포인트: CRON_SECRET 이 없거나 틀리면 401, 맞으면 정기결제를 실행', async () => {
    const run = (auth?: string) => request(app.getHttpServer()).get('/api/v1/internal/billing/run').set(auth ? { Authorization: auth } : {});
    expect((await run()).status).toBe(401);
    expect((await run('Bearer wrong-secret')).body.errorCode).toBe('UNAUTHORIZED');
    expect((await client(app).get('/internal/billing/run')).status).toBe(401); // 사용자 쿠키로는 호출 불가
    // 실제 서비스 데이터를 건드리지 않도록, 테스트 계정이 아닌 결제 대상이 DB 에 없을 때만 실행해 본다
    const others = await ctx.prisma.subscription.count({
      where: { user: { email: { not: { startsWith: 'e2e-' } } }, OR: [{ nextBillingAt: { lte: new Date() } }, { cancelAtPeriodEnd: true, currentPeriodEnd: { lte: new Date() } }] },
    });
    if (others === 0) {
      const d = await signedUp(app, ctx.mail);
      await start(d.c);
      await makeDue(d.id);
      const r = await run(`Bearer ${process.env.CRON_SECRET}`);
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ processed: 1, charged: 1, failed: 0, ended: 0 });
      expect((await run(`Bearer ${process.env.CRON_SECRET}`)).body.data).toMatchObject({ processed: 0 }); // 같은 결제일을 두 번 청구하지 않는다
    }
  });
});
