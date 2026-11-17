import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/setup.js';
import { MailService } from '../src/common/mail.service.js';
import { PrismaService } from '../src/prisma.service.js';
import type { StorageService } from '../src/common/storage.service.js';
import { randomUUID } from 'node:crypto';

process.env.MAIL_DRY = '1';
process.env.TOSS_MOCK = '1'; // 토스 결제 승인/취소를 가짜로 처리(운영에서는 무시됨)

export async function createApp() {
  const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = m.createNestApplication({ rawBody: true });
  setupApp(app);
  await app.init();
  return { app, mail: app.get(MailService), prisma: app.get(PrismaService) };
}

/** 쿠키를 유지하는 클라이언트. 상태 변경 요청마다 CSRF 토큰을 새로 받아 헤더에 넣는다. */
export function client(app: INestApplication) {
  const agent = request.agent(app.getHttpServer());
  const csrf = async () => (await agent.get('/api/v1/auth/csrf')).body.data.csrfToken as string;
  const call = async (method: 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) => {
    const token = await csrf(); // 쿠키는 요청 생성 시점에 붙으므로, 토큰을 먼저 받고 요청을 만든다
    return agent[method]('/api/v1' + url).set('X-CSRF-Token', token).send(body);
  };
  return {
    agent,
    get: (url: string) => agent.get('/api/v1' + url),
    post: (url: string, body?: object) => call('post', url, body),
    put: (url: string, body?: object) => call('put', url, body),
    patch: (url: string, body?: object) => call('patch', url, body),
    del: (url: string, body?: object) => call('delete', url, body),
  };
}

export type Client = ReturnType<typeof client>;

export const PASSWORD = 'Test!1234pw';
export const REQUIRED_TERMS = ['term-service', 'term-privacy', 'term-ai'];
export const uniq = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 이메일 인증 → 가입까지 마친 로그인 상태 클라이언트를 만든다. */
export async function signedUp(app: INestApplication, mail: MailService, nick = uniq('u')) {
  const c = client(app);
  const email = `e2e-${nick}@example.test`;
  await c.post('/auth/email/verification-codes', { email, purpose: 'SIGNUP' });
  const code = /(\d{6})/.exec(mail.outbox.filter((o) => o.to === email).at(-1)!.text)![1];
  const v = await c.post('/auth/email/verification-codes/verify', { email, code, purpose: 'SIGNUP' });
  if (v.status !== 200) throw new Error('인증 실패: ' + JSON.stringify(v.body));
  const r = await c.post('/auth/signup', {
    email, verificationToken: v.body.data.verificationToken, password: PASSWORD, nickname: nick, agreedTermIds: REQUIRED_TERMS,
  });
  if (r.status !== 201) throw new Error('가입 실패: ' + JSON.stringify(r.body));
  return { c, email, nick, id: r.body.data.user.id as string };
}

/** 테스트로 만든 사용자와 관련 데이터를 지운다(이메일이 e2e- 로 시작하거나 탈퇴한 e2e 사용자). */
export async function cleanup(prisma: PrismaService, storage?: StorageService, extraIds: string[] = []) {
  const users = await prisma.user.findMany({
    where: { OR: [{ email: { startsWith: 'e2e-' } }, { nickname: { startsWith: 'e2e-' } }, { identities: { some: { providerUserId: { startsWith: 'e2e-' } } } }] },
    select: { id: true },
  });
  const ids = [...new Set([...users.map((u) => u.id), ...extraIds])];
  if (ids.length) {
    const ups = await prisma.upload.findMany({ where: { ownerId: { in: ids } } });
    if (storage) for (const u of ups) await storage.remove(u.storageKey);
    const creators = await prisma.creator.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    const cids = creators.map((c) => c.id);
    const chars = await prisma.character.findMany({ where: { ownerId: { in: ids } }, select: { id: true } });
    const sets = await prisma.emoticonSet.findMany({ where: { ownerId: { in: ids } }, select: { id: true } });
    const emos = await prisma.emoticon.findMany({ where: { setId: { in: sets.map((x) => x.id) } }, select: { id: true } });
    const posts = await prisma.post.findMany({ where: { authorId: { in: ids } }, select: { id: true } });
    const prods = await prisma.product.findMany({ where: { creatorId: { in: cids } }, select: { id: true } });
    const orders = await prisma.order.findMany({ where: { OR: [{ userId: { in: ids } }, { productId: { in: prods.map((x) => x.id) } }] }, select: { id: true } });
    const pids = posts.map((x) => x.id);
    const prodIds = prods.map((x) => x.id);
    const orderIds = orders.map((x) => x.id);
    await prisma.$transaction([
      prisma.report.deleteMany({ where: { OR: [{ reporterId: { in: ids } }, { targetId: { in: [...pids, ...prodIds, ...ids] } }] } }),
      prisma.comment.deleteMany({ where: { OR: [{ postId: { in: pids } }, { authorId: { in: ids } }] } }),
      prisma.like.deleteMany({ where: { OR: [{ postId: { in: pids } }, { userId: { in: ids } }] } }),
      prisma.bookmark.deleteMany({ where: { OR: [{ postId: { in: pids } }, { userId: { in: ids } }] } }),
      prisma.postTag.deleteMany({ where: { postId: { in: pids } } }),
      prisma.post.deleteMany({ where: { id: { in: pids } } }),
      prisma.review.deleteMany({ where: { OR: [{ productId: { in: prodIds } }, { authorId: { in: ids } }] } }),
      prisma.purchase.deleteMany({ where: { OR: [{ productId: { in: prodIds } }, { userId: { in: ids } }, { orderId: { in: orderIds } }] } }),
      prisma.donation.deleteMany({ where: { OR: [{ senderId: { in: ids } }, { creatorId: { in: cids } }, { orderId: { in: orderIds } }] } }),
      prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } }),
      prisma.order.deleteMany({ where: { id: { in: orderIds } } }),
      prisma.product.deleteMany({ where: { id: { in: prodIds } } }),
      prisma.settlement.deleteMany({ where: { creatorId: { in: cids } } }),
    ]);
    await prisma.$transaction([
      prisma.emoticon.updateMany({ where: { id: { in: emos.map((x) => x.id) } }, data: { currentVersionId: null } }),
      prisma.emoticonVersion.deleteMany({ where: { emoticonId: { in: emos.map((x) => x.id) } } }),
      prisma.emoticon.deleteMany({ where: { id: { in: emos.map((x) => x.id) } } }),
      prisma.emoticonSet.deleteMany({ where: { id: { in: sets.map((x) => x.id) } } }),
      prisma.characterCandidate.deleteMany({ where: { characterId: { in: chars.map((x) => x.id) } } }),
      prisma.generationJob.deleteMany({ where: { userId: { in: ids } } }),
      prisma.character.deleteMany({ where: { id: { in: chars.map((x) => x.id) } } }),
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
  await prisma.emailVerification.deleteMany({ where: { email: { startsWith: 'e2e-' } } });
  await prisma.rateHit.deleteMany({ where: { key: { contains: 'e2e-' } } });
}

// 1x1 PNG (생성 결과/업로드 테스트용)
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** GPU 워커 흉내: X-Worker-Key 로 claim → 스토리지에 직접 업로드 → complete/fail. */
export function worker(app: INestApplication) {
  const call = (url: string, body: object, key = process.env.WORKER_API_KEY ?? '') =>
    request(app.getHttpServer()).post('/api/v1/worker/jobs' + url).set('X-Worker-Key', key).send(body);
  return {
    call,
    claim: (types?: string[]) => call('/claim', { workerId: 'test-gpu', types }),
    /** 특정 작업을 가져올 때까지 claim 한다(다른 테스트 데이터가 앞에 있을 수 있어서). */
    async claimJob(jobId: string) {
      for (let i = 0; i < 5; i++) {
        const r = await call('/claim', { workerId: 'test-gpu' });
        if (r.body.data?.job?.jobId === jobId) return r.body.data.job;
        if (!r.body.data?.job) break;
      }
      throw new Error('작업을 claim 하지 못했습니다: ' + jobId);
    },
    /** 이미지 n 장을 올리고 complete 한다. labels 가 있으면 라벨을 붙인다. */
    async finish(jobId: string, n: number, labels: (string | undefined)[] = [], png: Buffer = PNG) {
      const u = await call(`/${jobId}/upload-urls`, { count: n });
      if (u.status !== 201) throw new Error('upload-urls 실패: ' + JSON.stringify(u.body));
      const images = [];
      for (const [i, up] of (u.body.data.uploads as { uploadKey: string; uploadUrl: string }[]).entries()) {
        const put = await fetch(up.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png });
        if (!put.ok) throw new Error('결과 업로드 실패 ' + put.status);
        images.push({ uploadKey: up.uploadKey, label: labels[i] });
      }
      return call(`/${jobId}/complete`, { images });
    },
  };
}

export const idemKey = () => randomUUID();

export async function idemPost(c: Client, url: string, body: object, key = idemKey()) {
  const t = (await c.get('/auth/csrf')).body.data.csrfToken;
  return c.agent.post('/api/v1' + url).set('X-CSRF-Token', t).set('Idempotency-Key', key).send(body);
}

/** 캐릭터 확정 → 세트 → 감정 생성(워커 처리)까지 마친 세트를 만든다. */
export async function readySet(c: Client, w: ReturnType<typeof worker>, labels: string[] = ['happy', 'thanks']) {
  const ch = (await c.post('/characters', { name: '테스트곰', description: '갈색 곰', stylePreset: 'pastel' })).body.data.id;
  const cj = (await idemPost(c, `/characters/${ch}/candidates`, { count: 1 })).body.data.jobId;
  await w.claimJob(cj);
  await w.finish(cj, 1);
  const cand = (await c.get(`/characters/${ch}/candidates`)).body.data.items[0].imageId;
  await c.post(`/characters/${ch}/confirm`, { candidateImageId: cand });
  const setId = (await c.post('/sets', { characterId: ch, title: '테스트 세트' })).body.data.id;
  const gj = (await idemPost(c, `/sets/${setId}/generations`, { emotions: labels.map((key) => ({ key })) })).body.data.jobId;
  await w.claimJob(gj);
  await w.finish(gj, labels.length, labels);
  return { characterId: ch as string, setId: setId as string };
}

export async function becomeCreator(c: Client) {
  const r = await c.post('/creators/me', {
    agreedTermIds: ['term-creator'], payoutAccount: { bankName: '테스트은행', accountHolder: '홍길동', accountNumber: '000-0000-0000' },
  });
  if (r.status !== 201) throw new Error('창작자 등록 실패: ' + JSON.stringify(r.body));
}
