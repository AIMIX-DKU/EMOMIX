import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StorageService } from '../src/common/storage.service.js';
import { becomeCreator, cleanup, client, createApp, idemKey, idemPost, PASSWORD, readySet, signedUp, uniq, worker } from './helpers.js';

/** 코드 리뷰에서 나온 허점들을 막았는지 확인하는 회귀 테스트. */
describe('보강: 인증 시도 제한·이중 결제·정지 복구·탈퇴 창작자', () => {
  let app: INestApplication;
  let ctx: Awaited<ReturnType<typeof createApp>>;
  let w: ReturnType<typeof worker>;
  const withdrawn: string[] = [];
  beforeAll(async () => {
    ctx = await createApp();
    app = ctx.app;
    w = worker(app);
    await cleanup(ctx.prisma, app.get(StorageService));
  });
  afterAll(async () => {
    await cleanup(ctx.prisma, app.get(StorageService), withdrawn);
    await app.close();
  });

  const pay = (c: Awaited<ReturnType<typeof signedUp>>['c'], orderNo: string, amount: number, paymentKey = `pk_${idemKey()}`) =>
    idemPost(c, '/payments/confirm', { paymentKey, orderNo, amount });

  it('인증번호는 5번 틀리면 올바른 번호도 거부한다(병렬 추측 방지)', async () => {
    const c = client(app);
    const email = `e2e-${uniq('brute')}@example.test`;
    await c.post('/auth/email/verification-codes', { email, purpose: 'SIGNUP' });
    const code = /(\d{6})/.exec(ctx.mail.outbox.filter((o) => o.to === email).at(-1)!.text)![1];
    const wrong = code === '000000' ? '111111' : '000000';
    // 병렬로 8번 시도해도 한도(5)를 넘어 통과하지 못한다
    await Promise.all(Array.from({ length: 8 }, () => c.post('/auth/email/verification-codes/verify', { email, code: wrong, purpose: 'SIGNUP' })));
    const row = await ctx.prisma.emailVerification.findFirstOrThrow({ where: { email }, orderBy: { createdAt: 'desc' } });
    expect(row.attempts).toBe(5);
    expect((await c.post('/auth/email/verification-codes/verify', { email, code, purpose: 'SIGNUP' })).body.errorCode).toBe('INVALID_VERIFICATION_CODE');
  });

  it('로그아웃은 액세스 토큰이 만료돼도 refresh 쿠키로 세션을 폐기한다', async () => {
    const { c, email } = await signedUp(app, ctx.mail);
    const login = await c.post('/auth/login', { email, password: PASSWORD });
    const cookies = login.headers['set-cookie'] as unknown as string[];
    const refresh = cookies.find((x) => x.startsWith('refreshToken='))!.split(';')[0];
    const t = (await c.get('/auth/csrf')).body.data.csrfToken;
    // accessToken 없이(만료된 상태) refresh 쿠키만으로 로그아웃
    const out = await request(app.getHttpServer()).post('/api/v1/auth/logout').set('Cookie', [refresh, `csrfToken=${t}`]).set('X-CSRF-Token', t);
    expect(out.status).toBe(200);
    const again = await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', [refresh, `csrfToken=${t}`]).set('X-CSRF-Token', t);
    expect(again.status).toBe(401); // refresh 토큰이 폐기됨
  });

  describe('결제·상품', () => {
    let seller: Awaited<ReturnType<typeof signedUp>>;
    let buyer: Awaited<ReturnType<typeof signedUp>>;
    let productId: string;
    let tplId: string;
    let admin: ReturnType<typeof client>;

    beforeAll(async () => {
      seller = await signedUp(app, ctx.mail);
      buyer = await signedUp(app, ctx.mail);
      const { setId } = await readySet(seller.c, w, ['happy']);
      await becomeCreator(seller.c);
      const base = { sourceSetId: setId, description: '설명', licenseType: 'PERSONAL' };
      productId = (await seller.c.post('/products', { ...base, type: 'EMOTICON_SET', title: '이중결제 테스트', price: 2000 })).body.data.id;
      tplId = (await seller.c.post('/products', {
        ...base, type: 'PROMPT_TEMPLATE', title: '템플릿', price: 1000,
        template: { model: 'm', modelVersion: '1', promptText: '{x}', variables: [{ key: 'x', label: 'x', defaultValue: 'a' }], requiresReferenceImage: false, settings: {} },
      })).body.data.id;
      admin = client(app);
      await admin.post('/auth/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
    });

    it('같은 상품의 대기 주문 두 개를 모두 결제하면 두 번째는 자동 취소된다(이중 판매 방지)', async () => {
      const o1 = (await idemPost(buyer.c, '/orders', { type: 'PRODUCT', productId })).body.data;
      const o2 = (await idemPost(buyer.c, '/orders', { type: 'PRODUCT', productId })).body.data;
      expect((await pay(buyer.c, o1.orderNo, 2000)).status).toBe(200);
      expect((await pay(buyer.c, o2.orderNo, 2000)).body.errorCode).toBe('ALREADY_PURCHASED');
      expect((await buyer.c.get(`/orders/${o2.orderNo}`)).body.data.status).toBe('CANCELED');
      expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id: productId } })).salesCount).toBe(1);
      const sale = (await seller.c.get('/seller/ledger?type=SALE')).body.data.items;
      expect(sale).toHaveLength(1); // 매출이 한 번만 기록됨
    });

    it('웹훅이 먼저 처리한 결제를 같은 paymentKey 로 confirm 하면 같은 결과를 돌려준다', async () => {
      const o = (await idemPost(buyer.c, '/orders', { type: 'PRODUCT', productId: tplId })).body.data;
      const key = `pk_${idemKey()}`;
      const first = await pay(buyer.c, o.orderNo, 1000, key);
      expect(first.status).toBe(200);
      const again = await pay(buyer.c, o.orderNo, 1000, key); // 새 멱등성 키, 같은 paymentKey
      expect(again.status).toBe(200);
      expect(again.body.data.paymentId).toBe(first.body.data.paymentId);
    });

    it('템플릿을 생성에 사용하면 조회 이력으로 남아 환불할 수 없다', async () => {
      const { setId } = await readySet(buyer.c, w, ['happy']);
      const gen = await idemPost(buyer.c, `/sets/${setId}/generations`, { emotions: [{ key: 'sad' }], templateProductId: tplId, variables: { x: 'b' } });
      expect(gen.status).toBe(202);
      const orderNo = (await buyer.c.get('/orders?type=PRODUCT')).body.data.items.find((o: { orderName: string }) => o.orderName === '템플릿').orderNo;
      expect((await buyer.c.post(`/orders/${orderNo}/cancel`, { reason: '변심' })).body.errorCode).toBe('NOT_REFUNDABLE');
    });

    it('정지 해제는 정지로 숨긴 상품만 복구하고 따로 숨긴 상품은 그대로 둔다', async () => {
      await admin.patch(`/admin/contents/PRODUCT/${tplId}/visibility`, { hidden: true, reason: '신고 처리로 숨김' }); // 따로 숨김
      expect((await admin.post(`/admin/users/${seller.id}/suspension`, { reason: '테스트' })).status).toBe(201); // productId 가 정지로 숨겨짐
      expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id: productId } })).status).toBe('HIDDEN');
      expect((await admin.del(`/admin/users/${seller.id}/suspension`)).status).toBe(200);
      expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id: productId } })).status).toBe('ON_SALE'); // 복구
      expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id: tplId } })).status).toBe('HIDDEN'); // 따로 숨긴 건 유지
    });

    it('창작자가 탈퇴하면 상품 판매가 중단되고 새 주문을 받을 수 없다', async () => {
      const other = await signedUp(app, ctx.mail);
      withdrawn.push(seller.id);
      await seller.c.post('/auth/login', { email: seller.email, password: PASSWORD });
      expect((await seller.c.del('/users/me', { confirmText: '탈퇴' })).body.errorCode).toBe('HAS_PENDING_SETTLEMENT'); // 정산 대기 잔액이 있으면 탈퇴 불가
      // 잔액을 비운 것처럼: 정산 완료 처리 대신 장부를 직접 0으로 만든다
      await ctx.prisma.sellerLedger.deleteMany({ where: { creatorId: (await ctx.prisma.creator.findUniqueOrThrow({ where: { userId: seller.id } })).id } });
      expect((await seller.c.del('/users/me', { confirmText: '탈퇴' })).status).toBe(200);
      expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id: productId } })).status).toBe('STOPPED');
      expect((await idemPost(other.c, '/orders', { type: 'PRODUCT', productId })).body.errorCode).toBe('PRODUCT_UNAVAILABLE');
    });
  });
});
