import type { INestApplication } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { StorageService } from '../src/common/storage.service.js';
import { becomeCreator, cleanup, client, createApp, idemKey, idemPost, readySet, signedUp, worker } from './helpers.js';

describe('커뮤니티·마켓·주문·결제·후원·정산', () => {
  let app: INestApplication;
  let ctx: Awaited<ReturnType<typeof createApp>>;
  let w: ReturnType<typeof worker>;
  beforeAll(async () => {
    ctx = await createApp();
    app = ctx.app;
    w = worker(app);
    await cleanup(ctx.prisma, app.get(StorageService));
  });
  afterAll(async () => {
    await cleanup(ctx.prisma, app.get(StorageService));
    await app.close();
  });

  // 공유 상태: 판매자(창작자)와 구매자, 판매자의 완성된 세트
  let seller: Awaited<ReturnType<typeof signedUp>>;
  let buyer: Awaited<ReturnType<typeof signedUp>>;
  let other: Awaited<ReturnType<typeof signedUp>>;
  let setId: string;
  let postId: string;
  let productId: string;
  let tplId: string;

  const pay = async (c: Awaited<ReturnType<typeof signedUp>>['c'], orderNo: string, amount: number, paymentKey = `pk_${idemKey()}`) =>
    idemPost(c, '/payments/confirm', { paymentKey, orderNo, amount });
  const order = (c: Awaited<ReturnType<typeof signedUp>>['c'], body: object) => idemPost(c, '/orders', body);

  it('준비: 판매자·구매자 가입, 판매자 세트 생성과 창작자 등록', async () => {
    seller = await signedUp(app, ctx.mail);
    buyer = await signedUp(app, ctx.mail);
    other = await signedUp(app, ctx.mail);
    setId = (await readySet(seller.c, w)).setId;
    await becomeCreator(seller.c);
    expect((await seller.c.get('/creators/me')).status).toBe(200);
  });

  // ───────── 커뮤니티 ─────────
  it('게시: 본인 세트만, 중복·금칙어 거부, 스냅샷 고정', async () => {
    expect((await other.c.post('/posts', { setId, title: '남의 세트' })).body.errorCode).toBe('FORBIDDEN');
    expect((await seller.c.post('/posts', { setId, title: 'nude 곰' })).body.errorCode).toBe('CONTENT_BLOCKED');
    const r = await seller.c.post('/posts', { setId, title: '귀여운 곰 이모티콘', description: '기본 세트', tags: ['곰', '감사', '곰'], sharePrompt: true });
    expect(r.status).toBe(201);
    postId = r.body.data.id;
    expect((await seller.c.post('/posts', { setId, title: '또' })).body.errorCode).toBe('ALREADY_PUBLISHED');
    const pts = await seller.c.get('/wallet/point-transactions');
    expect(pts.body.data.items.map((p: { reason: string }) => p.reason)).toContain('POST_PUBLISHED');
  });

  it('목록·검색·상세(비로그인), 프롬프트 공개, 수정', async () => {
    const anon = client(app);
    const list = await anon.get('/posts?keyword=귀여운');
    expect(list.body.data.items.map((p: { id: string }) => p.id)).toContain(postId);
    const byTag = (await anon.get('/posts?tag=감사')).body.data.items[0];
    expect(byTag).toMatchObject({ id: postId, isLiked: false });
    expect([...byTag.tags].sort()).toEqual(['감사', '곰']);
    expect((await anon.get(`/posts?keyword=${encodeURIComponent(seller.nick)}`)).body.data.totalElements).toBeGreaterThanOrEqual(1);
    const d = (await anon.get(`/posts/${postId}`)).body.data;
    expect(d.emoticons).toHaveLength(2);
    expect(d.promptInfo).toMatchObject({ model: expect.any(String) });
    expect((await fetch(d.emoticons[0].imageUrl)).status).toBe(200);
    expect((await other.c.patch(`/posts/${postId}`, { title: '해킹' })).body.errorCode).toBe('FORBIDDEN');
    expect((await seller.c.patch(`/posts/${postId}`, { sharePrompt: false, tags: ['곰'] })).status).toBe(200);
    expect((await anon.get(`/posts/${postId}`)).body.data.promptInfo).toBeNull();
  });

  it('좋아요(작성자 알림·포인트), 북마크, 댓글/답글, 인기 태그·랭킹', async () => {
    expect((await seller.c.post(`/posts/${postId}/likes`)).body.errorCode).toBe('SELF_ACTION');
    const l = await other.c.post(`/posts/${postId}/likes`);
    expect(l.status).toBe(201);
    expect(l.body.data.likeCount).toBe(1);
    expect((await other.c.post(`/posts/${postId}/likes`)).body.errorCode).toBe('DUPLICATED');
    expect((await seller.c.get('/notifications/unread-count')).body.data.count).toBeGreaterThanOrEqual(1);
    const pts = (await seller.c.get('/wallet/point-transactions')).body.data.items.map((p: { reason: string }) => p.reason);
    expect(pts).toContain('POST_LIKED');
    expect((await other.c.get(`/posts/${postId}`)).body.data.isLiked).toBe(true);

    expect((await other.c.post(`/posts/${postId}/bookmarks`)).status).toBe(201);
    expect((await other.c.post(`/posts/${postId}/bookmarks`)).body.errorCode).toBe('DUPLICATED');
    expect((await other.c.get('/users/me/bookmarks')).body.data.items[0].id).toBe(postId);

    const c1 = await other.c.post(`/posts/${postId}/comments`, { content: '귀엽네요!' });
    expect(c1.status).toBe(201);
    const r1 = await seller.c.post(`/posts/${postId}/comments`, { content: '감사합니다', parentId: c1.body.data.id });
    expect(r1.status).toBe(201);
    expect((await other.c.post(`/posts/${postId}/comments`, { content: '답글의 답글', parentId: r1.body.data.id })).body.errorCode).toBe('VALIDATION_ERROR');
    expect((await seller.c.patch(`/comments/${c1.body.data.id}`, { content: '수정' })).body.errorCode).toBe('FORBIDDEN');
    const list = (await client(app).get(`/posts/${postId}/comments`)).body.data;
    expect(list.items.map((c: { parentId: string | null }) => c.parentId)).toEqual([null, c1.body.data.id]);
    expect((await other.c.del(`/comments/${c1.body.data.id}`)).status).toBe(200);
    const after = (await client(app).get(`/posts/${postId}/comments`)).body.data.items;
    expect(after[0].content).toBe('삭제된 댓글입니다.');
    expect((await client(app).get(`/posts/${postId}`)).body.data.commentCount).toBe(1);

    expect((await client(app).get('/tags/popular')).body.data.items.map((t: { name: string }) => t.name)).toContain('곰');
    const rank = (await client(app).get('/rankings/posts?period=DAILY')).body.data.items;
    expect(rank.find((r: { id: string }) => r.id === postId)).toMatchObject({ rank: expect.any(Number), likeCount: 1 });
    expect((await client(app).get('/rankings/creators')).body.data.items.some((r: { user: { id: string } }) => r.user.id === seller.id)).toBe(true);
    expect((await client(app).get('/rankings/prompts')).status).toBe(200);
  });

  // ───────── 마켓 ─────────
  it('상품 등록 검증(가격·템플릿·소유자)과 등록', async () => {
    const base = { type: 'EMOTICON_SET', sourceSetId: setId, title: '곰 이모티콘 세트', description: '귀여운 곰', price: 3900, licenseType: 'PERSONAL' };
    expect((await buyer.c.post('/products', base)).body.errorCode).toBe('NOT_CREATOR');
    expect((await seller.c.post('/products', { ...base, price: 100 })).body.errorCode).toBe('PRICE_OUT_OF_RANGE');
    expect((await seller.c.post('/products', { ...base, type: 'PROMPT_TEMPLATE' })).body.errorCode).toBe('VALIDATION_ERROR');
    const r = await seller.c.post('/products', base);
    expect(r.status).toBe(201);
    productId = r.body.data.id;
    expect(r.body.data.status).toBe('ON_SALE');
    expect((await seller.c.post('/products', base)).body.errorCode).toBe('ALREADY_PUBLISHED');

    // 템플릿 상품
    const tpl = await seller.c.post('/products', {
      ...base, type: 'PROMPT_TEMPLATE', title: '감정 템플릿', price: 1000,
      template: {
        model: 'FLUX.1 Kontext', modelVersion: 'dev', promptText: '{character}가 {emotion} 표정', requiresReferenceImage: true, settings: { steps: 28 },
        variables: [{ key: 'character', label: '캐릭터', defaultValue: '곰' }, { key: 'emotion', label: '감정', defaultValue: '기쁨' }],
      },
    });
    expect(tpl.status).toBe(201);
    tplId = tpl.body.data.id;
  });

  it('상품 목록·상세: 미리보기는 워터마크 이미지, 프롬프트·원본은 구매 전 비공개', async () => {
    const anon = client(app);
    const list = (await anon.get('/products?type=EMOTICON_SET&sort=PRICE_ASC&minPrice=1000')).body.data;
    expect(list.items.find((p: { id: string }) => p.id === productId)).toMatchObject({ price: 3900, ratingAvg: null, reviewCount: 0, seller: { id: seller.id } });
    expect((await anon.get('/products?keyword=곰&tag=곰')).body.data.totalElements).toBeGreaterThanOrEqual(1);
    const d = (await anon.get(`/products/${productId}`)).body.data;
    expect(d).toMatchObject({ isPurchased: false, isMine: false, templateInfo: null, setSpec: { emoticonCount: 2, formats: ['PNG', 'DISCORD'] } });
    expect(d.previewImageUrls).toHaveLength(2);
    expect((await fetch(d.previewImageUrls[0])).status).toBe(200);
    expect(JSON.stringify(d)).not.toContain('generated/'); // 원본 파일 경로는 노출되지 않는다
    const t = (await anon.get(`/products/${tplId}`)).body.data;
    expect(t.templateInfo).toMatchObject({ model: 'FLUX.1 Kontext', variableKeys: ['character', 'emotion'] });
    expect(JSON.stringify(t)).not.toContain('{character}'); // 프롬프트 본문은 구매 전 비공개
    expect((await seller.c.get(`/products/${productId}`)).body.data.isMine).toBe(true);
    expect((await buyer.c.get(`/products/${productId}/download?format=DISCORD`)).body.errorCode).toBe('NOT_PURCHASED');
    expect((await buyer.c.get(`/products/${tplId}/template`)).body.errorCode).toBe('NOT_PURCHASED');
  });

  // ───────── 주문·결제 ─────────
  it('주문 → 결제 승인: 금액 검증, 멱등성, 중복 구매 방지, 판매자 장부·알림·보상', async () => {
    expect((await order(seller.c, { type: 'PRODUCT', productId })).body.errorCode).toBe('SELF_ACTION');
    expect((await order(buyer.c, { type: 'PRODUCT', productId: 'nope' })).body.errorCode).toBe('NOT_FOUND');
    const key = idemKey();
    const o1 = await idemPost(buyer.c, '/orders', { type: 'PRODUCT', productId }, key);
    expect(o1.status).toBe(201);
    expect(o1.body.data).toMatchObject({ type: 'PRODUCT', amount: 3900, status: 'PENDING_PAYMENT', orderName: '곰 이모티콘 세트' });
    expect((await idemPost(buyer.c, '/orders', { type: 'PRODUCT', productId }, key)).body.data.orderNo).toBe(o1.body.data.orderNo); // 같은 키 = 같은 주문
    const no = o1.body.data.orderNo;

    expect((await pay(other.c, no, 3900)).body.errorCode).toBe('NOT_FOUND'); // 남의 주문
    expect((await pay(buyer.c, no, 100)).body.errorCode).toBe('AMOUNT_MISMATCH'); // 클라이언트 금액은 믿지 않는다
    expect((await pay(buyer.c, no, 3900, 'fail_x')).body.errorCode).toBe('PAYMENT_FAILED');
    const ok = await pay(buyer.c, no, 3900);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'DONE', orderType: 'PRODUCT', grantedCredits: 0 });
    expect((await pay(buyer.c, no, 3900)).body.errorCode).toBe('ORDER_NOT_PENDING'); // 새 멱등성 키로 다시 승인 시도

    expect((await order(buyer.c, { type: 'PRODUCT', productId })).body.errorCode).toBe('ALREADY_PURCHASED');
    const detail = (await buyer.c.get(`/orders/${no}`)).body.data;
    expect(detail).toMatchObject({ status: 'PAID', refundable: true, payment: { method: 'card' } });

    // 판매자 장부: 매출 +3900, 수수료 -780(20%)
    const ledger = (await seller.c.get('/seller/ledger?size=50')).body.data.items.map((l: { type: string; amount: number; balanceAfter: number }) => [l.type, l.amount, l.balanceAfter]);
    expect(ledger).toEqual(expect.arrayContaining([['SALE', 3900, 3900], ['FEE', -780, 3120]]));
    const sales = (await seller.c.get('/seller/sales')).body.data.items[0];
    expect(sales).toMatchObject({ orderNo: no, amount: 3900, fee: 780, net: 3120, status: 'PAID', buyerNickname: buyer.nick });
    const bal = (await seller.c.get('/seller/balance')).body.data;
    expect(bal).toMatchObject({ availableAmount: 0, pendingAmount: 3120, totalEarned: 3120, feeRate: 0.2 }); // 환불 가능 기간(7일) 동안은 대기
    expect((await seller.c.get('/notifications')).body.data.items.map((n: { type: string }) => n.type)).toContain('SALE');
    expect((await buyer.c.get('/wallet/point-transactions')).body.data.items.map((p: { reason: string }) => p.reason)).toContain('PURCHASE');
    expect((await seller.c.get('/seller/products')).body.data.items.find((p: { id: string }) => p.id === productId).salesCount).toBe(1);
  });

  it('구매자 전용: 다운로드(ZIP, Discord 규격), 라이브러리, 후기', async () => {
    const dl = await buyer.c.get(`/products/${productId}/download?format=DISCORD`);
    expect(dl.status).toBe(200);
    expect(Buffer.from(await (await fetch(dl.body.data.url)).arrayBuffer()).subarray(0, 2).toString()).toBe('PK');
    expect((await buyer.c.get(`/products/${tplId}/download?format=DISCORD`)).body.errorCode).toBe('NOT_PURCHASED');
    const lib = (await buyer.c.get('/users/me/purchases')).body.data;
    expect(lib.items[0]).toMatchObject({ productId, type: 'EMOTICON_SET', licenseType: 'PERSONAL' });
    expect((await other.c.post(`/products/${productId}/reviews`, { rating: 5, content: '구매 안 함' })).body.errorCode).toBe('NOT_PURCHASED');
    expect((await buyer.c.post(`/products/${productId}/reviews`, { rating: 6, content: 'x' })).body.errorCode).toBe('VALIDATION_ERROR');
    expect((await buyer.c.post(`/products/${productId}/reviews`, { rating: 5, content: '좋아요' })).status).toBe(201);
    expect((await buyer.c.post(`/products/${productId}/reviews`, { rating: 4, content: '또' })).body.errorCode).toBe('DUPLICATED');
    const rv = (await client(app).get(`/products/${productId}/reviews`)).body.data;
    expect(rv.items[0]).toMatchObject({ rating: 5, content: '좋아요', author: { id: buyer.id } });
    expect((await client(app).get(`/products/${productId}`)).body.data).toMatchObject({ ratingAvg: 5, reviewCount: 1 });
    // 다운로드 이력이 있으면 환불할 수 없다
    const no = (await buyer.c.get('/orders')).body.data.items.find((o: { type: string }) => o.type === 'PRODUCT').orderNo;
    expect((await buyer.c.post(`/orders/${no}/cancel`, { reason: '단순 변심' })).body.errorCode).toBe('NOT_REFUNDABLE');
  });

  it('환불: 템플릿 상품(조회 전) 환불 시 접근 권한·장부·포인트가 되돌아간다', async () => {
    const o = (await order(buyer.c, { type: 'PRODUCT', productId: tplId })).body.data;
    expect((await pay(buyer.c, o.orderNo, 1000)).status).toBe(200);
    const before = (await seller.c.get('/seller/balance')).body.data.pendingAmount;
    expect(before).toBe(3120 + 800);
    expect((await buyer.c.post(`/orders/${o.orderNo}/cancel`, {})).body.errorCode).toBe('VALIDATION_ERROR'); // 사유 필수
    const r = await buyer.c.post(`/orders/${o.orderNo}/cancel`, { reason: '단순 변심' });
    expect(r.body.data).toEqual({ orderNo: o.orderNo, status: 'REFUNDED', refundedAmount: 1000 });
    expect((await buyer.c.get(`/orders/${o.orderNo}`)).body.data.status).toBe('REFUNDED');
    expect((await buyer.c.get(`/products/${tplId}/template`)).body.errorCode).toBe('NOT_PURCHASED');
    expect((await seller.c.get('/seller/balance')).body.data.pendingAmount).toBe(3120); // 역분개
    const types = (await seller.c.get('/seller/ledger?size=50')).body.data.items.map((l: { type: string }) => l.type);
    expect(types).toContain('REFUND');
    expect((await buyer.c.post(`/orders/${o.orderNo}/cancel`, { reason: '다시' })).body.errorCode).toBe('NOT_REFUNDABLE');
    expect((await seller.c.get('/seller/sales')).body.data.items.find((s: { productId: string }) => s.productId === tplId).status).toBe('REFUNDED');
    // 환불 후 다시 구매하면 조회할 수 있다
    const o2 = (await order(buyer.c, { type: 'PRODUCT', productId: tplId })).body.data;
    expect((await pay(buyer.c, o2.orderNo, 1000)).status).toBe(200);
    const t = (await buyer.c.get(`/products/${tplId}/template`)).body.data;
    expect(t).toMatchObject({ model: 'FLUX.1 Kontext', promptText: '{character}가 {emotion} 표정', postProcess: null });
    expect(t.variables).toHaveLength(2);
  });

  it('크레딧 패키지: 구매 시 지급(보너스 포함), 사용 전 환불 가능·사용 후 불가, 만료 주문', async () => {
    const pkgs = (await client(app).get('/credit-packages')).body.data.items;
    const p50 = pkgs.find((p: { credits: number }) => p.credits === 50);
    const o = (await order(other.c, { type: 'CREDIT_PACKAGE', packageId: p50.id })).body.data;
    expect(o).toMatchObject({ type: 'CREDIT_PACKAGE', amount: p50.price });
    const ok = await pay(other.c, o.orderNo, p50.price);
    expect(ok.body.data).toMatchObject({ orderType: 'CREDIT_PACKAGE', grantedCredits: 55 });
    expect((await other.c.get('/wallet')).body.data.credit.balance).toBe(20 + 55);
    expect((await other.c.post(`/orders/${o.orderNo}/cancel`, { reason: '변심' })).body.data.status).toBe('REFUNDED');
    expect((await other.c.get('/wallet')).body.data.credit.balance).toBe(20);

    // 결제 후 크레딧을 일부 사용하면 환불 불가
    const o2 = (await order(other.c, { type: 'CREDIT_PACKAGE', packageId: p50.id })).body.data;
    await pay(other.c, o2.orderNo, p50.price);
    const ch = (await other.c.post('/characters', { name: 'x', description: 'y', stylePreset: 'pastel' })).body.data.id;
    expect((await idemPost(other.c, `/characters/${ch}/candidates`, { count: 1 })).status).toBe(202);
    expect((await other.c.post(`/orders/${o2.orderNo}/cancel`, { reason: '변심' })).body.errorCode).toBe('NOT_REFUNDABLE');

    // 결제하지 않은 주문은 취소(CANCELED), 기한이 지난 주문은 승인 불가(EXPIRED)
    const o3 = (await order(other.c, { type: 'CREDIT_PACKAGE', packageId: p50.id })).body.data;
    expect((await other.c.post(`/orders/${o3.orderNo}/cancel`, { reason: '안 사요' })).body.data).toEqual({ orderNo: o3.orderNo, status: 'CANCELED', refundedAmount: 0 });
    const o4 = (await order(other.c, { type: 'CREDIT_PACKAGE', packageId: p50.id })).body.data;
    await ctx.prisma.order.update({ where: { orderNo: o4.orderNo }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await pay(other.c, o4.orderNo, p50.price)).body.errorCode).toBe('ORDER_NOT_PENDING');
    expect((await other.c.get(`/orders/${o4.orderNo}`)).body.data.status).toBe('EXPIRED');
    expect((await other.c.get('/orders?status=EXPIRED')).body.data.totalElements).toBe(1);
  });

  it('웹훅: 서명 검증, 놓친 결제 보정, 중복 수신 멱등, PG 취소 동기화', async () => {
    const c = other.c;
    const pkg = (await client(app).get('/credit-packages')).body.data.items.find((p: { credits: number }) => p.credits === 10);
    const o = (await order(c, { type: 'CREDIT_PACKAGE', packageId: pkg.id })).body.data;
    const before = (await c.get('/wallet')).body.data.credit.balance;
    const send = (status: string, sig?: string) => {
      const body = JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', createdAt: new Date().toISOString(), data: { paymentKey: 'pk_hook_' + o.orderNo, orderId: o.orderNo, status } });
      const good = createHmac('sha256', process.env.TOSS_WEBHOOK_SECRET || process.env.TOSS_SECRET_KEY || '').update(body).digest('hex');
      return request(app.getHttpServer()).post('/api/v1/payments/webhook').set('Content-Type', 'application/json').set('X-Webhook-Signature', sig ?? good).send(body);
    };
    expect((await send('DONE', 'bad')).body.errorCode).toBe('INVALID_SIGNATURE');
    expect((await c.get('/wallet')).body.data.credit.balance).toBe(before);
    expect((await send('DONE')).status).toBe(200);
    expect((await c.get(`/orders/${o.orderNo}`)).body.data.status).toBe('PAID');
    expect((await c.get('/wallet')).body.data.credit.balance).toBe(before + 10);
    expect((await send('DONE')).status).toBe(200); // 중복 수신
    expect((await c.get('/wallet')).body.data.credit.balance).toBe(before + 10); // 두 번 지급되지 않음
    expect((await send('CANCELED')).status).toBe(200);
    expect((await c.get(`/orders/${o.orderNo}`)).body.data.status).toBe('REFUNDED');
    expect((await c.get('/wallet')).body.data.credit.balance).toBe(before);
  });

  // ───────── 후원·정산 ─────────
  it('후원: 범위·대상 검증, 결제 후에만 노출, 익명 처리, 판매자 장부 반영', async () => {
    const b = { creatorId: seller.id, amount: 3000, message: '응원합니다' };
    expect((await idemPost(seller.c, '/donations', b)).body.errorCode).toBe('SELF_ACTION');
    expect((await idemPost(buyer.c, '/donations', { ...b, creatorId: other.id })).body.errorCode).toBe('NOT_CREATOR');
    expect((await idemPost(buyer.c, '/donations', { ...b, amount: 500 })).body.errorCode).toBe('PRICE_OUT_OF_RANGE');
    const d = await idemPost(buyer.c, '/donations', b);
    expect(d.status).toBe(201);
    expect(d.body.data).toMatchObject({ type: 'DONATION', amount: 3000 });
    expect((await seller.c.get('/donations/received')).body.data.totalElements).toBe(0); // 결제 전에는 보이지 않는다
    expect((await pay(buyer.c, d.body.data.orderNo, 3000)).body.data.orderType).toBe('DONATION');
    const rec = (await seller.c.get('/donations/received')).body.data.items;
    expect(rec[0]).toMatchObject({ amount: 3000, message: '응원합니다', from: { id: buyer.id } });
    expect((await buyer.c.get('/donations/sent')).body.data.items[0].creator.id).toBe(seller.id);
    const d2 = await idemPost(other.c, '/donations', { ...b, amount: 1000, isAnonymous: true });
    await pay(other.c, d2.body.data.orderNo, 1000);
    expect((await seller.c.get('/donations/received')).body.data.items.find((x: { amount: number }) => x.amount === 1000).from).toBeNull();
    expect((await buyer.c.post(`/orders/${d.body.data.orderNo}/cancel`, { reason: '환불' })).body.errorCode).toBe('NOT_REFUNDABLE'); // 후원은 환불 없음
    // 후원은 환불 대기 없이 바로 정산 가능
    expect((await seller.c.get('/seller/balance')).body.data.availableAmount).toBe(4000);
    expect((await seller.c.get('/seller/ledger?type=DONATION')).body.data.items).toHaveLength(2);
  });

  // ───────── 관리자 ─────────
  describe('관리자', () => {
    let admin: ReturnType<typeof client>;
    beforeAll(async () => {
      admin = client(app);
      const r = await admin.post('/auth/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
      if (r.status !== 200) throw new Error('관리자 로그인 실패(seed 필요): ' + JSON.stringify(r.body));
    });

    it('일반 사용자는 접근할 수 없다', async () => {
      expect((await buyer.c.get('/admin/users')).body.errorCode).toBe('FORBIDDEN');
      expect((await client(app).get('/admin/policies')).status).toBe(401);
    });

    it('정책 조회·수정(범위 검증, 감사 로그), 정산 요청과 처리', async () => {
      const pol = (await admin.get('/admin/policies')).body.data;
      expect(pol).toMatchObject({ sellerFeeRate: 0.2, minSettlementAmount: 10000 });
      expect((await admin.put('/admin/policies', { ...pol, sellerFeeRate: 5 })).body.errorCode).toBe('VALIDATION_ERROR');
      expect((await seller.c.put('/admin/policies', pol)).body.errorCode).toBe('FORBIDDEN');
      try {
        const next = { ...pol, minSettlementAmount: 1000 };
        expect((await admin.put('/admin/policies', next)).body.data.minSettlementAmount).toBe(1000);
        expect((await ctx.prisma.auditLog.count({ where: { action: 'POLICY_UPDATE' } }))).toBeGreaterThanOrEqual(1);

        // 판매자 정산 요청: 정산 가능 금액(후원 4000) 안에서만
        expect((await idemPost(seller.c, '/seller/settlements', { amount: 500 })).body.errorCode).toBe('BELOW_MINIMUM');
        expect((await idemPost(seller.c, '/seller/settlements', { amount: 5000 })).body.errorCode).toBe('INSUFFICIENT_BALANCE');
        const key = idemKey();
        const s = await idemPost(seller.c, '/seller/settlements', { amount: 3000 }, key);
        expect(s.status).toBe(201);
        expect((await idemPost(seller.c, '/seller/settlements', { amount: 3000 }, key)).body.data.id).toBe(s.body.data.id);
        expect((await idemPost(seller.c, '/seller/settlements', { amount: 2000 })).body.errorCode).toBe('INSUFFICIENT_BALANCE'); // 요청 중인 금액은 차감해서 계산
        expect((await seller.c.get('/seller/balance')).body.data.availableAmount).toBe(1000);

        const list = (await admin.get('/admin/settlements?status=REQUESTED')).body.data.items;
        expect(list.map((x: { id: string }) => x.id)).toContain(s.body.data.id);
        expect((await seller.c.patch(`/admin/settlements/${s.body.data.id}`, { status: 'PAID' })).body.errorCode).toBe('FORBIDDEN');
        expect((await admin.patch(`/admin/settlements/${s.body.data.id}`, { status: 'PAID', note: '모의 지급' })).body.data.status).toBe('PAID');
        expect((await admin.patch(`/admin/settlements/${s.body.data.id}`, { status: 'APPROVED' })).body.errorCode).toBe('VALIDATION_ERROR'); // 종료된 건
        const types = (await seller.c.get('/seller/ledger?type=SETTLEMENT')).body.data.items;
        expect(types[0]).toMatchObject({ amount: -3000, refType: 'SETTLEMENT' });
        expect((await seller.c.get('/seller/settlements')).body.data.items[0]).toMatchObject({ status: 'PAID' });
      } finally {
        await admin.put('/admin/policies', pol); // 정책 원복
      }
      expect((await admin.get('/admin/policies')).body.data.minSettlementAmount).toBe(10000);
    });

    it('신고 접수 → 관리자 처리(콘텐츠 숨김) → 신고자 알림, 중복·본인 신고 방지', async () => {
      expect((await seller.c.post('/reports', { targetType: 'POST', targetId: postId, reason: 'SPAM' })).body.errorCode).toBe('SELF_ACTION');
      expect((await other.c.post('/reports', { targetType: 'POST', targetId: 'nope', reason: 'SPAM' })).body.errorCode).toBe('NOT_FOUND');
      const rp = await other.c.post('/reports', { targetType: 'POST', targetId: postId, reason: 'COPYRIGHT', detail: '무단 도용' });
      expect(rp.status).toBe(201);
      expect((await other.c.post('/reports', { targetType: 'POST', targetId: postId, reason: 'SPAM' })).body.errorCode).toBe('DUPLICATED_REPORT');
      expect((await other.c.get('/reports/me')).body.data.items[0]).toMatchObject({ status: 'RECEIVED', targetId: postId });

      const id = rp.body.data.reportId;
      expect((await admin.get(`/admin/reports?status=RECEIVED&targetType=POST`)).body.data.items.map((r: { reportId: string }) => r.reportId)).toContain(id);
      expect((await admin.get(`/admin/reports/${id}`)).body.data.targetSnapshot).toMatchObject({ authorId: seller.id, hidden: false });
      expect((await admin.patch(`/admin/reports/${id}`, { action: 'HIDE_CONTENT', note: '저작권 침해' })).body.data.status).toBe('RESOLVED');
      expect((await admin.patch(`/admin/reports/${id}`, { action: 'DISMISS' })).body.errorCode).toBe('VALIDATION_ERROR'); // 이미 처리됨
      expect((await client(app).get(`/posts/${postId}`)).body.errorCode).toBe('NOT_FOUND'); // 숨김
      expect((await seller.c.get(`/posts/${postId}`)).status).toBe(200); // 작성자는 볼 수 있다
      expect((await client(app).get('/posts?keyword=귀여운')).body.data.items.map((p: { id: string }) => p.id)).not.toContain(postId);
      expect((await other.c.get('/reports/me')).body.data.items[0].status).toBe('RESOLVED');
      expect((await other.c.get('/notifications')).body.data.items.map((n: { type: string }) => n.type)).toContain('REPORT_RESULT');
      // 다시 보이게
      expect((await admin.patch(`/admin/contents/POST/${postId}/visibility`, { hidden: false, reason: '재검토' })).status).toBe(200);
      expect((await client(app).get(`/posts/${postId}`)).status).toBe(200);
    });

    it('상품 숨김은 신규 구매만 막고 구매자 접근은 유지, 사용자 정지는 로그인 차단·세션 폐기', async () => {
      expect((await admin.patch(`/admin/contents/PRODUCT/${productId}/visibility`, { hidden: true, reason: '검토' })).status).toBe(200);
      expect((await client(app).get('/products?keyword=곰')).body.data.items.map((p: { id: string }) => p.id)).not.toContain(productId);
      expect((await client(app).get(`/products/${productId}`)).body.errorCode).toBe('NOT_FOUND');
      expect((await buyer.c.get(`/products/${productId}`)).status).toBe(200); // 구매자는 계속 볼 수 있다
      expect((await buyer.c.get(`/products/${productId}/download?format=ORIGINAL`)).status).toBe(200);
      expect((await order(other.c, { type: 'PRODUCT', productId })).body.errorCode).toBe('PRODUCT_UNAVAILABLE');
      await admin.patch(`/admin/contents/PRODUCT/${productId}/visibility`, { hidden: false, reason: '복구' });

      const victim = await signedUp(app, ctx.mail);
      expect((await admin.get(`/admin/users?keyword=${victim.nick}`)).body.data.items[0]).toMatchObject({ id: victim.id, status: 'ACTIVE', email: victim.email });
      expect((await admin.post(`/admin/users/${victim.id}/suspension`, { reason: '테스트 정지' })).status).toBe(201);
      expect((await victim.c.get('/users/me')).body.errorCode).toBe('ACCOUNT_SUSPENDED'); // 기존 세션도 즉시 차단
      expect((await client(app).post('/auth/login', { email: victim.email, password: 'Test!1234pw' })).body.errorCode).toBe('ACCOUNT_SUSPENDED');
      expect((await victim.c.post('/auth/refresh')).status).toBeGreaterThanOrEqual(401); // 토큰 폐기됨
      expect((await admin.get('/admin/users?status=SUSPENDED')).body.data.items.map((u: { id: string }) => u.id)).toContain(victim.id);
      expect((await admin.post(`/admin/users/${(await admin.get('/users/me')).body.data.id}/suspension`, { reason: '자기 정지' })).body.errorCode).toBe('SELF_ACTION');
      expect((await admin.del(`/admin/users/${victim.id}/suspension`)).status).toBe(200);
      expect((await client(app).post('/auth/login', { email: victim.email, password: 'Test!1234pw' })).status).toBe(200);

      // 기간이 지난 정지는 접근 시 자동으로 풀린다
      await admin.post(`/admin/users/${victim.id}/suspension`, { reason: '짧은 정지', until: new Date(Date.now() + 60_000).toISOString() });
      await ctx.prisma.user.update({ where: { id: victim.id }, data: { suspendedUntil: new Date(Date.now() - 1000) } });
      expect((await client(app).post('/auth/login', { email: victim.email, password: 'Test!1234pw' })).status).toBe(200);
    });

    it('크레딧 수동 지급(멱등), 생성 통계', async () => {
      const key = idemKey();
      const g = await idemPost(admin, '/admin/credits/grants', { userId: buyer.id, amount: 30, reason: '보상' }, key);
      expect(g.status).toBe(201);
      expect(g.body.data.creditBalance).toBe(50);
      expect((await idemPost(admin, '/admin/credits/grants', { userId: buyer.id, amount: 30, reason: '보상' }, key)).body.data.creditBalance).toBe(50); // 두 번 지급되지 않음
      expect((await buyer.c.get('/wallet/credit-transactions?type=ADMIN_GRANT')).body.data.items[0].amount).toBe(30);
      expect((await idemPost(buyer.c, '/admin/credits/grants', { userId: buyer.id, amount: 1, reason: 'x' })).body.errorCode).toBe('FORBIDDEN');
      const from = new Date(Date.now() - 86400_000).toISOString();
      const st = (await admin.get(`/admin/generations/stats?from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date().toISOString())}`)).body.data;
      expect(st.totalJobs).toBeGreaterThan(0);
      expect(st.succeeded).toBeGreaterThan(0);
      expect(st.daily.length).toBeGreaterThanOrEqual(1);
      expect(st.estimatedCostUsd).toBeNull();
    });
  });

  it('판매 중단(DELETE)은 목록에서만 내리고 구매자는 계속 받을 수 있다', async () => {
    expect((await other.c.del(`/products/${productId}`)).body.errorCode).toBe('NOT_CREATOR');
    expect((await seller.c.del(`/products/${productId}`)).status).toBe(200);
    expect((await client(app).get('/products?keyword=곰')).body.data.items.map((p: { id: string }) => p.id)).not.toContain(productId);
    expect((await client(app).get(`/products/${productId}`)).body.data.status).toBe('STOPPED');
    expect((await buyer.c.get(`/products/${productId}/download?format=DISCORD`)).status).toBe(200);
    expect((await order(other.c, { type: 'PRODUCT', productId })).body.errorCode).toBe('PRODUCT_UNAVAILABLE');
    // 판매 중이던 세트는 상품이 내려가면 삭제할 수 있지만, 게시물이 있으면 삭제할 수 없다
    expect((await seller.c.del(`/sets/${setId}`)).body.errorCode).toBe('SET_PUBLISHED');
  });
});
