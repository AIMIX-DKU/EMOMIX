// 런타임 계약 점검: 실제 시나리오를 실행하며 모든 응답을 docs/openapi.json 과 대조한다.
//   npm run build && node scripts/contract-check.mjs
// 만든 데이터는 이메일이 e2e-contract- 로 시작하는 사용자 기준으로 정리한다.
process.env.MAIL_DRY = '1';
process.env.TOSS_MOCK = '1';
import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

await import('../dist/config.js');
const { NestFactory } = await import('@nestjs/core');
const { AppModule } = await import('../dist/app.module.js');
const { setupApp } = await import('../dist/setup.js');
const { MailService } = await import('../dist/common/mail.service.js');
const { PrismaService } = await import('../dist/prisma.service.js');
const { StorageService } = await import('../dist/common/storage.service.js');

const spec = JSON.parse(readFileSync(new URL('../docs/openapi.json', import.meta.url), 'utf8'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const TERMS = ['term-service', 'term-privacy', 'term-ai'];
const PW = 'Test!1234pw';
const tag = Date.now().toString(36);

// ───────── 스키마 검증기 ─────────
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const inline = (n) => {
  if (Array.isArray(n)) return n.map(inline);
  if (n && typeof n === 'object') {
    if (n.$ref) return inline(n.$ref.split('/').reduce((o, k) => (k === '#' ? o : o[k]), spec));
    const o = Object.fromEntries(Object.entries(n).map(([k, v]) => [k, inline(v)]));
    if (o.nullable && !o.type) delete o.nullable; // 타입 없는 nullable 은 "아무 값"이라 ajv 가 거부한다
    return o;
  }
  return n;
};
const routes = Object.entries(spec.paths).map(([p, ops]) => ({ p, ops, re: new RegExp('^' + p.replace(/\{\w+\}/g, '[^/]+') + '$') }));
const cache = new Map();
const validatorFor = (key, schema) => cache.get(key) ?? (cache.set(key, ajv.compile(inline(schema))), cache.get(key));

const issues = new Map(); // "METHOD /path status" -> Set(message)
const seen = new Set();
const note = (k, m) => (issues.get(k) ?? issues.set(k, new Set()).get(k)).add(m);

function check(method, url, res) {
  const path = url.split('?')[0].replace(/^\/api\/v1/, '');
  const hit = routes.find((r) => r.re.test(path) && r.ops[method.toLowerCase()]);
  const label = `${method} ${hit?.p ?? path}`;
  seen.add(label);
  if (!hit) return note(label, `명세에 없는 경로`);
  const op = hit.ops[method.toLowerCase()];
  const def = op.responses[String(res.status)];
  const key = `${label} → ${res.status}`;
  if (!def) return note(key, `명세에 없는 상태코드(문서화된 코드: ${Object.keys(op.responses).join(',')}) body=${JSON.stringify(res.body).slice(0, 140)}`);
  const schema = def.content?.['application/json']?.schema;
  if (!schema) return; // 302 등 본문 없음
  if (res.status >= 400) {
    const known = Object.keys(def.content['application/json'].examples ?? {});
    if (known.length && !known.includes(res.body?.errorCode)) note(key, `문서화되지 않은 errorCode ${res.body?.errorCode} (문서화: ${known.join(',')})`);
  }
  const v = validatorFor(`${hit.p}|${method}|${res.status}`, schema);
  if (!v(res.body)) for (const e of v.errors) note(key, `${e.instancePath || '(root)'} ${e.message}${e.params?.allowedValues ? ' ' + JSON.stringify(e.params.allowedValues) : ''}`);
}

// ───────── 앱 부팅 ─────────
const app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
setupApp(app);
await app.init();
const mail = app.get(MailService);
const prisma = app.get(PrismaService);
const storage = app.get(StorageService);
const srv = app.getHttpServer();

const scenario = []; // 시나리오 자체의 기대와 다른 결과
function client() {
  const agent = request.agent(srv);
  const st = { csrf: null };
  const run = async (method, url, { body, idem, expect = null, headers = {}, plain = false } = {}) => {
    const m = method.toLowerCase();
    if (!plain && m !== 'get' && !st.csrf) await run('GET', '/auth/csrf');
    let r = agent[m]('/api/v1' + url);
    if (!plain && m !== 'get') r = r.set('X-CSRF-Token', st.csrf);
    if (idem) r = r.set('Idempotency-Key', idem === true ? randomUUID() : idem);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    const res = await (body !== undefined ? r.send(body) : r);
    const sc = (res.headers['set-cookie'] ?? []).find((c) => c.startsWith('csrfToken='));
    if (sc) st.csrf = sc.split(';')[0].slice('csrfToken='.length);
    if (m === 'get' && url === '/auth/csrf') st.csrf = res.body?.data?.csrfToken ?? st.csrf;
    check(method, '/api/v1' + url, res);
    if (expect !== null && res.status !== expect) scenario.push(`${method} ${url} → ${res.status} (기대 ${expect}) ${JSON.stringify(res.body).slice(0, 160)}`);
    return res;
  };
  return { agent, st, get: (u, o) => run('GET', u, o), post: (u, b, o) => run('POST', u, { body: b, ...o }), put: (u, b, o) => run('PUT', u, { body: b, ...o }),
    patch: (u, b, o) => run('PATCH', u, { body: b, ...o }), del: (u, b, o) => run('DELETE', u, { body: b, ...o }) };
}

async function signup(label) {
  const c = client();
  const email = `e2e-contract-${label}${tag}@example.test`;
  const nick = `c${label}${tag}`.slice(0, 16);
  await c.post('/auth/email/verification-codes', { email, purpose: 'SIGNUP' }, { expect: 200 });
  const code = /(\d{6})/.exec(mail.outbox.filter((o) => o.to === email).at(-1).text)[1];
  const v = await c.post('/auth/email/verification-codes/verify', { email, code, purpose: 'SIGNUP' }, { expect: 200 });
  const r = await c.post('/auth/signup', { email, verificationToken: v.body.data.verificationToken, password: PW, nickname: nick, agreedTermIds: TERMS }, { expect: 201 });
  return { c, email, nick, id: r.body.data?.user?.id };
}

// 워커 흉내
const wcall = (path, body, key = process.env.WORKER_API_KEY) =>
  request(srv).post('/api/v1/worker/jobs' + path).set('X-Worker-Key', key).send(body).then((res) => (check('POST', '/api/v1/worker/jobs' + path.replace(/\/[0-9a-f-]{36}\//, '/{jobId}/'), res), res));
async function claim(jobId) {
  for (let i = 0; i < 6; i++) {
    const r = await wcall('/claim', { workerId: 'contract-gpu' });
    if (r.body.data?.job?.jobId === jobId) return r.body.data.job;
    if (!r.body.data?.job) break;
  }
  scenario.push(`claim 실패: ${jobId}`);
}
async function finish(jobId, n, labels = []) {
  await wcall(`/${jobId}/heartbeat`, { progress: 50 });
  const u = await wcall(`/${jobId}/upload-urls`, { count: n });
  const images = [];
  for (const [i, up] of (u.body.data?.uploads ?? []).entries()) {
    const put = await fetch(up.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: PNG });
    if (!put.ok) scenario.push('결과 업로드 실패 ' + put.status);
    images.push({ uploadKey: up.uploadKey, label: labels[i] });
  }
  const r = await wcall(`/${jobId}/complete`, { images });
  if (r.status !== 200) scenario.push(`complete → ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  return r;
}
async function job(c, jobPromise, n, labels) {
  const r = await jobPromise;
  const id = r.body.data?.jobId;
  if (r.status !== 202 || !id) { scenario.push(`작업 생성 실패 ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`); return null; }
  await claim(id);
  await finish(id, n, labels);
  await c.get(`/generations/${id}`, { expect: 200 });
  return id;
}
async function upload(c, purpose) {
  const p = await c.post('/uploads/images/presign', { contentType: 'image/png', sizeBytes: PNG.length, purpose }, { expect: 201 });
  const put = await fetch(p.body.data.uploadUrl, { method: 'PUT', headers: p.body.data.uploadHeaders, body: PNG });
  if (!put.ok) scenario.push('업로드 PUT ' + put.status);
  await c.post(`/uploads/images/${p.body.data.uploadId}/complete`, undefined, { expect: 200 });
  return p.body.data.uploadId;
}

const withdrawn = [];
try {
  // ───────── 비로그인 조회 ─────────
  const anon = client();
  for (const u of ['/health', '/auth/csrf', '/terms', '/terms/term-service', '/style-presets', '/emotion-presets', '/emotion-presets?category=EMOTION', '/credit-packages',
    '/rewards/rules', '/guides/export', '/tags/popular', '/rankings/posts', '/rankings/prompts', '/rankings/creators', '/posts', '/products', '/users/me', '/terms/nope']) {
    await anon.get(u);
  }
  await anon.post('/auth/login', { email: 'nobody@example.test', password: 'x' });
  await anon.post('/auth/signup', {});
  await anon.get('/auth/discord?redirectPath=/home');
  await anon.get('/auth/discord/callback?code=x&state=bad');
  await anon.post('/payments/webhook', { a: 1 }, { plain: true, headers: { 'X-Webhook-Signature': 'bad' } });

  // ───────── 사용자 A(판매자) ─────────
  const A = await signup('a');
  const a = A.c;
  await a.get('/users/me', { expect: 200 });
  await a.get(`/users/${A.id}`, { expect: 200 });
  await a.patch('/users/me', { bio: '소개', nickname: A.nick }, { expect: 200 });
  const profileUp = await upload(a, 'PROFILE');
  await a.patch('/users/me', { profileImageUploadId: profileUp }, { expect: 200 });
  await a.get('/users/me/settings', { expect: 200 });
  await a.patch('/users/me/settings', { notifications: { like: false } }, { expect: 200 });
  await a.put('/users/me/agreements', { agreedTermIds: [...TERMS, 'term-marketing'] }, { expect: 200 });
  await a.get('/users/me/identities', { expect: 200 });
  await a.del('/users/me/identities/EMAIL'); // LAST_IDENTITY
  await a.put('/users/me/password', { currentPassword: PW, newPassword: 'New!pass1234' }, { expect: 200 });
  await a.post('/auth/refresh', undefined, { expect: 200 });
  await a.post('/auth/logout', undefined, { expect: 200 });
  await a.post('/auth/login', { email: A.email, password: 'New!pass1234' }, { expect: 200 });
  // 비밀번호 재설정(인증번호 → 토큰 → 재설정)
  const c2 = client();
  await c2.post('/auth/email/verification-codes', { email: A.email, purpose: 'PASSWORD_RESET' }, { expect: 200 });
  const rc = /(\d{6})/.exec(mail.outbox.filter((o) => o.to === A.email).at(-1).text)[1];
  const rv = await c2.post('/auth/email/verification-codes/verify', { email: A.email, code: rc, purpose: 'PASSWORD_RESET' }, { expect: 200 });
  await c2.post('/auth/password/reset', { email: A.email, verificationToken: rv.body.data.verificationToken, newPassword: PW }, { expect: 200 });
  await a.post('/auth/login', { email: A.email, password: PW }, { expect: 200 });

  // ───────── 캐릭터 → 후보 → 확정 → 세트 → 감정 → 재생성 → 인페인트 ─────────
  const ch = (await a.post('/characters', { name: '곰', description: '노란 후드티를 입은 갈색 곰', stylePreset: 'pastel', referenceUploadIds: [await upload(a, 'REFERENCE')] }, { expect: 201 })).body.data.id;
  await a.get('/characters', { expect: 200 });
  await a.get(`/characters/${ch}`, { expect: 200 });
  await a.patch(`/characters/${ch}`, { name: '곰돌이' }, { expect: 200 });
  await a.post('/generations/estimates', { type: 'EMOTION_SET', count: 4 }, { expect: 200 });
  await a.post('/sets', { characterId: ch, title: 'x' }); // CHARACTER_NOT_CONFIRMED
  await job(a, a.post(`/characters/${ch}/candidates`, { count: 2 }, { idem: true }), 2);
  await a.get(`/characters/${ch}/candidates`, { expect: 200 });
  const cand = (await a.get(`/characters/${ch}/candidates`)).body.data.items[0].imageId;
  await a.post(`/characters/${ch}/confirm`, { candidateImageId: cand, appearanceDescription: '갈색 털' }, { expect: 200 });
  await a.patch(`/characters/${ch}`, { appearanceDescription: '갈색 털, 노란 후드티' }, { expect: 200 });
  const setId = (await a.post('/sets', { characterId: ch, title: '곰 세트', description: '설명' }, { expect: 201 })).body.data.id;
  await a.get('/sets', { expect: 200 });
  await job(a, a.post(`/sets/${setId}/generations`, { emotions: [{ key: 'happy' }, { key: 'thanks', customPrompt: '꽃다발' }] }, { idem: true }), 2, ['happy', 'thanks']);
  await a.patch(`/sets/${setId}`, { title: '곰 기본 세트' }, { expect: 200 });
  const detail = (await a.get(`/sets/${setId}`, { expect: 200 })).body.data;
  const emo = detail.emoticons?.[0]?.id;
  await a.get(`/emoticons/${emo}`, { expect: 200 });
  await a.patch(`/emoticons/${emo}`, { label: '기쁨' }, { expect: 200 });
  await job(a, a.post(`/emoticons/${emo}/regenerations`, { prompt: '더 크게' }, { idem: true }), 1);
  const versions = (await a.get(`/emoticons/${emo}/versions`, { expect: 200 })).body.data.items;
  await a.put(`/emoticons/${emo}/versions/${versions[0].versionId}/current`, undefined, { expect: 200 });
  const mask = await upload(a, 'MASK');
  await job(a, a.post(`/emoticons/${emo}/inpaints`, { maskUploadId: mask, prompt: '웃는 입' }, { idem: true }), 1);
  for (const f of ['ORIGINAL', 'TRANSPARENT_PNG', 'DISCORD']) await a.get(`/emoticons/${emo}/download?format=${f}`, { expect: 200 });
  await a.get(`/sets/${setId}/download?format=DISCORD`, { expect: 200 });
  // 대기 중 취소 / 워커 실패
  const q = await a.post(`/characters/${ch}/candidates`, { count: 1, extraPrompt: 'q1' }, { idem: true, expect: 202 });
  await a.post(`/generations/${q.body.data.jobId}/cancel`, undefined, { expect: 200 });
  const q2 = await a.post(`/characters/${ch}/candidates`, { count: 1, extraPrompt: 'q2' }, { idem: true, expect: 202 });
  await claim(q2.body.data.jobId);
  await wcall(`/${q2.body.data.jobId}/fail`, { reason: 'GPU_ERROR', message: 'oom' });
  await a.get('/generations', { expect: 200 });
  await a.get('/generations?status=FAILED', { expect: 200 });

  // ───────── 창작자·게시·상품 ─────────
  await a.post('/creators/me', { agreedTermIds: ['term-creator'], payoutAccount: { bankName: '테스트은행', accountHolder: '홍길동', accountNumber: '000-0000-0000' } }, { expect: 201 });
  await a.get('/creators/me', { expect: 200 });
  await a.patch('/creators/me', { payoutAccount: { bankName: '테스트은행', accountHolder: '홍길동', accountNumber: '111-1111-1111' } }, { expect: 200 });
  const postId = (await a.post('/posts', { setId, title: '귀여운 곰', description: '설명', tags: ['곰', '감사'], sharePrompt: true }, { expect: 201 })).body.data.id;
  await a.get(`/posts/${postId}`, { expect: 200 });
  await a.patch(`/posts/${postId}`, { title: '귀여운 곰 이모티콘' }, { expect: 200 });
  const prod = (await a.post('/products', { type: 'EMOTICON_SET', sourceSetId: setId, title: '곰 세트', description: '귀여운', price: 3900, licenseType: 'PERSONAL' }, { expect: 201 })).body.data.id;
  const tpl = (await a.post('/products', {
    type: 'PROMPT_TEMPLATE', sourceSetId: setId, title: '감정 템플릿', description: '템플릿', price: 1000, licenseType: 'PERSONAL',
    template: { model: 'FLUX.1 Kontext', modelVersion: 'dev', promptText: '{character} {emotion}', requiresReferenceImage: true, settings: { steps: 28 }, variables: [{ key: 'character', label: '캐릭터', defaultValue: '곰' }, { key: 'emotion', label: '감정', defaultValue: '기쁨' }] },
  }, { expect: 201 })).body.data.id;
  await a.patch(`/products/${prod}`, { description: '수정된 설명', price: 4000 }, { expect: 200 });
  await a.get('/products?keyword=곰', { expect: 200 });
  await a.get(`/products/${prod}`, { expect: 200 });
  await a.get('/seller/products', { expect: 200 });

  // ───────── 사용자 B(구매자) ─────────
  const B = await signup('b');
  const b = B.c;
  await b.get(`/users/${A.id}`, { expect: 200 });
  await b.post(`/users/${A.id}/follow`, undefined, { expect: 201 });
  await b.del(`/users/${A.id}/follow`, undefined, { expect: 200 });
  await b.post(`/posts/${postId}/likes`, undefined, { expect: 201 });
  await b.post(`/posts/${postId}/bookmarks`, undefined, { expect: 201 });
  await b.get('/users/me/bookmarks', { expect: 200 });
  const cm = await b.post(`/posts/${postId}/comments`, { content: '귀엽네요' }, { expect: 201 });
  await a.post(`/posts/${postId}/comments`, { content: '감사', parentId: cm.body.data.id }, { expect: 201 });
  await b.get(`/posts/${postId}/comments`, { expect: 200 });
  await b.patch(`/comments/${cm.body.data.id}`, { content: '수정' }, { expect: 200 });
  await b.del(`/comments/${cm.body.data.id}`, undefined, { expect: 200 });
  await b.get(`/posts?keyword=${encodeURIComponent('귀여운')}&sort=POPULAR`, { expect: 200 });
  await b.del(`/posts/${postId}/likes`, undefined, { expect: 200 });
  await b.del(`/posts/${postId}/bookmarks`, undefined, { expect: 200 });
  await b.post(`/posts/${postId}/likes`, undefined, { expect: 201 });

  // 주문·결제
  const o1 = (await b.post('/orders', { type: 'PRODUCT', productId: prod }, { idem: true, expect: 201 })).body.data;
  await b.post('/payments/confirm', { paymentKey: 'pk_' + randomUUID(), orderNo: o1.orderNo, amount: 1 }, { idem: true }); // AMOUNT_MISMATCH
  await b.post('/payments/confirm', { paymentKey: 'pk_' + randomUUID(), orderNo: o1.orderNo, amount: o1.amount }, { idem: true, expect: 200 });
  await b.get('/orders', { expect: 200 });
  await b.get(`/orders/${o1.orderNo}`, { expect: 200 });
  await b.get('/users/me/purchases', { expect: 200 });
  await b.get(`/products/${prod}/download?format=DISCORD`, { expect: 200 });
  await b.post(`/products/${prod}/reviews`, { rating: 5, content: '좋아요' }, { expect: 201 });
  await b.get(`/products/${prod}/reviews`, { expect: 200 });
  const o2 = (await b.post('/orders', { type: 'PRODUCT', productId: tpl }, { idem: true, expect: 201 })).body.data;
  await b.post('/payments/confirm', { paymentKey: 'pk_' + randomUUID(), orderNo: o2.orderNo, amount: o2.amount }, { idem: true, expect: 200 });
  await b.post(`/orders/${o2.orderNo}/cancel`, { reason: '변심' }, { expect: 200 });
  const o3 = (await b.post('/orders', { type: 'PRODUCT', productId: tpl }, { idem: true, expect: 201 })).body.data;
  await b.post('/payments/confirm', { paymentKey: 'pk_' + randomUUID(), orderNo: o3.orderNo, amount: o3.amount }, { idem: true, expect: 200 });
  await b.get(`/products/${tpl}/template`, { expect: 200 });
  const pkg = (await anon.get('/credit-packages')).body.data.items.find((p) => p.credits === 10);
  const o4 = (await b.post('/orders', { type: 'CREDIT_PACKAGE', packageId: pkg.id }, { idem: true, expect: 201 })).body.data;
  await b.post(`/orders/${o4.orderNo}/cancel`, { reason: '안 사요' }, { expect: 200 }); // 결제 전 취소
  const o5 = (await b.post('/orders', { type: 'CREDIT_PACKAGE', packageId: pkg.id }, { idem: true, expect: 201 })).body.data;
  const body = JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', createdAt: new Date().toISOString(), data: { paymentKey: 'pk_hook_' + o5.orderNo, orderId: o5.orderNo, status: 'DONE' } });
  const sig = createHmac('sha256', process.env.TOSS_WEBHOOK_SECRET || process.env.TOSS_SECRET_KEY || '').update(body).digest('hex');
  check('POST', '/api/v1/payments/webhook', await request(srv).post('/api/v1/payments/webhook').set('Content-Type', 'application/json').set('X-Webhook-Signature', sig).send(body));
  // 후원
  const d = (await b.post('/donations', { creatorId: A.id, amount: 3000, message: '응원', isAnonymous: false }, { idem: true, expect: 201 })).body.data;
  await b.post('/payments/confirm', { paymentKey: 'pk_' + randomUUID(), orderNo: d.orderNo, amount: 3000 }, { idem: true, expect: 200 });
  await b.get('/donations/sent', { expect: 200 });
  await a.get('/donations/received', { expect: 200 });
  // 판매자
  await a.get('/seller/sales', { expect: 200 });
  await a.get('/seller/ledger', { expect: 200 });
  await a.get('/seller/balance', { expect: 200 });
  await a.get('/seller/settlements', { expect: 200 });
  await a.post('/seller/settlements', { amount: 1000 }, { idem: true }); // BELOW_MINIMUM
  // 지갑·알림
  await b.get('/wallet', { expect: 200 });
  await b.get('/wallet/credit-transactions', { expect: 200 });
  await b.get('/wallet/point-transactions', { expect: 200 });
  await b.post('/wallet/point-exchanges', { points: 100 }, { idem: true }); // INSUFFICIENT_POINT
  await a.get('/notifications', { expect: 200 });
  await a.get('/notifications/unread-count', { expect: 200 });
  const n = (await a.get('/notifications')).body.data.items;
  if (n[0]) await a.patch(`/notifications/${n[0].id}/read`, undefined, { expect: 200 });
  await a.post('/notifications/read-all', undefined, { expect: 200 });
  if (n[1]) await a.del(`/notifications/${n[1].id}`, undefined, { expect: 200 });
  // 신고
  const rp = await b.post('/reports', { targetType: 'POST', targetId: postId, reason: 'COPYRIGHT', detail: '도용' }, { expect: 201 });
  await b.get('/reports/me', { expect: 200 });

  // ───────── 관리자 ─────────
  const adm = client();
  await adm.post('/auth/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, { expect: 200 });
  await adm.get('/admin/reports?status=RECEIVED', { expect: 200 });
  await adm.get(`/admin/reports/${rp.body.data.reportId}`, { expect: 200 });
  await adm.patch(`/admin/reports/${rp.body.data.reportId}`, { action: 'HIDE_CONTENT', note: '검토' }, { expect: 200 });
  await adm.patch(`/admin/contents/POST/${postId}/visibility`, { hidden: false, reason: '복구' }, { expect: 200 });
  await adm.get(`/admin/users?keyword=${A.nick}`, { expect: 200 });
  await adm.post(`/admin/users/${B.id}/suspension`, { reason: '테스트' }, { expect: 201 });
  await adm.del(`/admin/users/${B.id}/suspension`, undefined, { expect: 200 });
  await adm.post('/admin/credits/grants', { userId: B.id, amount: 5, reason: '테스트' }, { idem: true, expect: 201 });
  await adm.get(`/admin/generations/stats?from=${encodeURIComponent(new Date(Date.now() - 86400e3).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`, { expect: 200 });
  const pol = (await adm.get('/admin/policies', { expect: 200 })).body.data;
  await adm.put('/admin/policies', pol, { expect: 200 });
  await adm.get('/admin/settlements', { expect: 200 });
  await adm.patch('/admin/settlements/nope', { status: 'PAID' }); // NOT_FOUND

  // ───────── 정리 대상 삭제 API ─────────
  await a.del(`/products/${prod}`, undefined, { expect: 200 });
  await a.del(`/posts/${postId}`, undefined, { expect: 200 });
  await a.del(`/emoticons/${detail.emoticons[1]?.id}`, undefined, { expect: 200 });
  await a.del(`/sets/${setId}`, undefined, { expect: 200 });
  await a.del(`/characters/${ch}`, undefined);
  const C = await signup('c');
  withdrawn.push(C.id);
  await C.c.del('/users/me', { confirmText: '탈퇴' }, { expect: 200 });
} catch (e) {
  scenario.push('시나리오 중단: ' + (e?.stack ?? e));
} finally {
  // ───────── 정리 ─────────
  try {
    const users = await prisma.user.findMany({ where: { OR: [{ email: { startsWith: 'e2e-contract-' } }, { id: { in: withdrawn } }] }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length) {
      for (const u of await prisma.upload.findMany({ where: { ownerId: { in: ids } } })) await storage.remove(u.storageKey);
      const creators = await prisma.creator.findMany({ where: { userId: { in: ids } }, select: { id: true } });
      const cids = creators.map((x) => x.id);
      const chars = (await prisma.character.findMany({ where: { ownerId: { in: ids } }, select: { id: true } })).map((x) => x.id);
      const sets = (await prisma.emoticonSet.findMany({ where: { ownerId: { in: ids } }, select: { id: true } })).map((x) => x.id);
      const emos = (await prisma.emoticon.findMany({ where: { setId: { in: sets } }, select: { id: true } })).map((x) => x.id);
      const posts = (await prisma.post.findMany({ where: { authorId: { in: ids } }, select: { id: true } })).map((x) => x.id);
      const prods = (await prisma.product.findMany({ where: { creatorId: { in: cids } }, select: { id: true } })).map((x) => x.id);
      const orders = (await prisma.order.findMany({ where: { OR: [{ userId: { in: ids } }, { productId: { in: prods } }] }, select: { id: true } })).map((x) => x.id);
      await prisma.$transaction([
        prisma.report.deleteMany({ where: { OR: [{ reporterId: { in: ids } }, { targetId: { in: [...posts, ...prods, ...ids] } }] } }),
        prisma.comment.deleteMany({ where: { OR: [{ postId: { in: posts } }, { authorId: { in: ids } }] } }),
        prisma.like.deleteMany({ where: { OR: [{ postId: { in: posts } }, { userId: { in: ids } }] } }),
        prisma.bookmark.deleteMany({ where: { OR: [{ postId: { in: posts } }, { userId: { in: ids } }] } }),
        prisma.postTag.deleteMany({ where: { postId: { in: posts } } }),
        prisma.post.deleteMany({ where: { id: { in: posts } } }),
        prisma.review.deleteMany({ where: { OR: [{ productId: { in: prods } }, { authorId: { in: ids } }] } }),
        prisma.purchase.deleteMany({ where: { OR: [{ productId: { in: prods } }, { userId: { in: ids } }, { orderId: { in: orders } }] } }),
        prisma.donation.deleteMany({ where: { OR: [{ senderId: { in: ids } }, { creatorId: { in: cids } }, { orderId: { in: orders } }] } }),
        prisma.payment.deleteMany({ where: { orderId: { in: orders } } }),
        prisma.order.deleteMany({ where: { id: { in: orders } } }),
        prisma.product.deleteMany({ where: { id: { in: prods } } }),
        prisma.settlement.deleteMany({ where: { creatorId: { in: cids } } }),
      ]);
      await prisma.$transaction([
        prisma.emoticon.updateMany({ where: { id: { in: emos } }, data: { currentVersionId: null } }),
        prisma.emoticonVersion.deleteMany({ where: { emoticonId: { in: emos } } }),
        prisma.emoticon.deleteMany({ where: { id: { in: emos } } }),
        prisma.emoticonSet.deleteMany({ where: { id: { in: sets } } }),
        prisma.characterCandidate.deleteMany({ where: { characterId: { in: chars } } }),
        prisma.generationJob.deleteMany({ where: { userId: { in: ids } } }),
        prisma.character.deleteMany({ where: { id: { in: chars } } }),
        prisma.idempotencyRecord.deleteMany({ where: { userId: { in: ids } } }),
        prisma.user.updateMany({ where: { id: { in: ids } }, data: { profileImageId: null } }),
        prisma.upload.deleteMany({ where: { ownerId: { in: ids } } }),
        prisma.notification.deleteMany({ where: { userId: { in: ids } } }),
        prisma.follow.deleteMany({ where: { OR: [{ followerId: { in: ids } }, { followeeId: { in: ids } }] } }),
        prisma.sellerLedger.deleteMany({ where: { creatorId: { in: cids } } }),
        prisma.creator.deleteMany({ where: { id: { in: cids } } }),
        prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } }),
        prisma.creditTransaction.deleteMany({ where: { userId: { in: ids } } }),
        prisma.pointTransaction.deleteMany({ where: { userId: { in: ids } } }),
        prisma.wallet.deleteMany({ where: { userId: { in: ids } } }),
        prisma.userAgreement.deleteMany({ where: { userId: { in: ids } } }),
        prisma.identity.deleteMany({ where: { userId: { in: ids } } }),
        prisma.user.deleteMany({ where: { id: { in: ids } } }),
      ]);
    }
    await prisma.emailVerification.deleteMany({ where: { email: { startsWith: 'e2e-contract-' } } });
    await prisma.rateHit.deleteMany({ where: { key: { contains: 'e2e-contract-' } } });
    console.log(`정리 완료: 사용자 ${ids.length}명`);
  } catch (e) {
    console.log('정리 실패:', e.message);
  }
  await app.close();
}

console.log(`\n=== 호출한 엔드포인트 ${seen.size}개 (명세 ${routes.reduce((n, r) => n + Object.keys(r.ops).filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).length, 0)}개 중) ===`);
console.log(`\n=== 계약 불일치 ${issues.size}건 ===`);
for (const [k, v] of [...issues].sort()) console.log(`\n[${k}]\n  - ${[...v].slice(0, 8).join('\n  - ')}`);
console.log(`\n=== 시나리오 이상 ${scenario.length}건 ===`);
for (const s of scenario) console.log('  - ' + s);
const missing = routes.flatMap((r) => Object.keys(r.ops).filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).map((m) => `${m.toUpperCase()} ${r.p}`)).filter((l) => !seen.has(l));
console.log(`\n=== 호출하지 않은 엔드포인트 ${missing.length}개 ===\n  ${missing.join('\n  ')}`);
process.exit(0);
