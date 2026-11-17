import type { INestApplication } from '@nestjs/common';
import { StorageService } from '../src/common/storage.service.js';
import { cleanup, createApp, idemKey, PNG, signedUp, worker, type Client } from './helpers.js';

describe('캐릭터·생성·워커·지갑·다운로드', () => {
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

  const post = (c: Client, url: string, body: object, key?: string) =>
    key ? c.agent.post('/api/v1' + url).set('Idempotency-Key', key) : c.post(url, body);
  // Idempotency-Key 헤더가 필요한 호출: CSRF 토큰을 먼저 받고 요청을 만든다
  async function idem(c: Client, url: string, body: object, key = idemKey()) {
    const t = (await c.get('/auth/csrf')).body.data.csrfToken;
    return c.agent.post('/api/v1' + url).set('X-CSRF-Token', t).set('Idempotency-Key', key).send(body);
  }
  const balance = async (c: Client) => (await c.get('/wallet')).body.data.credit as { balance: number; reserved: number };

  it('프리셋 조회, 캐릭터 CRUD, 후보 생성 → 워커 처리 → 확정', async () => {
    const { c } = await signedUp(app, ctx.mail);
    const styles = await c.get('/style-presets');
    expect(styles.body.data.items.map((s: { key: string }) => s.key)).toContain('pastel');
    expect((await c.get('/emotion-presets?category=SITUATION')).body.data.items.every((e: { category: string }) => e.category === 'SITUATION')).toBe(true);

    expect((await c.post('/characters', { name: '곰', description: '노란 후드티를 입은 곰', stylePreset: 'nope' })).body.errorCode).toBe('VALIDATION_ERROR');
    const ch = await c.post('/characters', { name: '곰돌이', description: '노란 후드티를 입은 갈색 곰', stylePreset: 'pastel' });
    expect(ch.status).toBe(201);
    const id = ch.body.data.id;
    expect(ch.body.data).toMatchObject({ status: 'DRAFT', baseImageUrl: null });
    expect((await c.patch(`/characters/${id}`, { appearanceDescription: '확정 전엔 수정 불가' })).body.errorCode).toBe('VALIDATION_ERROR');

    // 세트는 확정된 캐릭터만
    expect((await c.post('/sets', { characterId: id, title: '세트' })).body.errorCode).toBe('CHARACTER_NOT_CONFIRMED');

    // 후보 생성: Idempotency-Key 필수, 같은 키 재전송은 같은 작업, 다른 내용은 충돌
    expect((await c.post(`/characters/${id}/candidates`, { count: 4 })).body.errorCode).toBe('VALIDATION_ERROR');
    const key = idemKey();
    const j1 = await idem(c, `/characters/${id}/candidates`, { count: 4 }, key);
    expect(j1.status).toBe(202);
    expect(j1.body.data).toMatchObject({ type: 'CHARACTER_CANDIDATES', status: 'QUEUED', creditCost: 4, targetType: 'CHARACTER', targetId: id });
    const jobId = j1.body.data.jobId;
    expect((await idem(c, `/characters/${id}/candidates`, { count: 4 }, key)).body.data.jobId).toBe(jobId);
    expect((await idem(c, `/characters/${id}/candidates`, { count: 2 }, key)).body.errorCode).toBe('IDEMPOTENCY_CONFLICT');
    expect(await balance(c)).toEqual({ balance: 16, reserved: 4 }); // 20 - 4 예약(중복 요청은 한 번만)

    // 워커 인증
    expect((await w.call('/claim', { workerId: 'x' }, 'wrong-key')).status).toBe(401);
    expect((await c.post('/worker/jobs/claim', { workerId: 'x' })).status).toBe(401); // 사용자 쿠키로는 불가

    const job = await w.claimJob(jobId);
    expect(job).toMatchObject({ type: 'CHARACTER_CANDIDATES', maskImageUrl: null });
    expect(job.prompt).toContain('갈색 곰');
    expect(await c.get(`/generations/${jobId}`).then((r) => r.body.data.status)).toBe('RUNNING');
    expect((await c.post(`/generations/${jobId}/cancel`)).body.errorCode).toBe('JOB_NOT_CANCELABLE'); // RUNNING 은 취소 불가

    expect((await w.call(`/${jobId}/heartbeat`, { progress: 50 })).body.data.cancelRequested).toBe(false);
    expect((await w.finish(jobId, 4)).status).toBe(200);
    expect((await w.call(`/${jobId}/upload-urls`, { count: 1 })).body.errorCode).toBe('LEASE_EXPIRED'); // 이미 끝난 작업

    const done = await c.get(`/generations/${jobId}`);
    expect(done.body.data).toMatchObject({ status: 'SUCCEEDED', progress: 100 });
    expect(done.body.data.result.images).toHaveLength(4);
    expect(await balance(c)).toEqual({ balance: 16, reserved: 0 }); // 예약 → 확정

    const cands = await c.get(`/characters/${id}/candidates`);
    expect(cands.body.data.items).toHaveLength(4);
    const imageId = cands.body.data.items[0].imageId;
    expect((await c.post(`/characters/${id}/confirm`, { candidateImageId: 'nope' })).body.errorCode).toBe('VALIDATION_ERROR');
    const confirmed = await c.post(`/characters/${id}/confirm`, { candidateImageId: imageId, appearanceDescription: '갈색 털, 노란 후드티' });
    expect(confirmed.body.data).toMatchObject({ status: 'CONFIRMED', appearanceDescription: '갈색 털, 노란 후드티' });
    expect(confirmed.body.data.baseImageUrl).toMatch(/^https:/);

    expect((await c.get('/characters?status=CONFIRMED')).body.data.totalElements).toBe(1);
    expect((await c.get(`/characters/${id}`)).body.data.setCount).toBe(0);
  });

  it('세트 감정 생성 → 이모티콘 READY, 재생성(버전), 인페인트, 버전 선택, 다운로드', async () => {
    const { c } = await signedUp(app, ctx.mail);
    // 확정된 캐릭터 준비
    const ch = (await c.post('/characters', { name: '토끼', description: '하얀 토끼', stylePreset: 'cartoon' })).body.data.id;
    const cj = (await idem(c, `/characters/${ch}/candidates`, { count: 1 })).body.data.jobId;
    await w.claimJob(cj);
    await w.finish(cj, 1);
    const cand = (await c.get(`/characters/${ch}/candidates`)).body.data.items[0].imageId;
    await c.post(`/characters/${ch}/confirm`, { candidateImageId: cand });

    const set = (await c.post('/sets', { characterId: ch, title: '토끼 기본' })).body.data;
    expect(set).toMatchObject({ status: 'DRAFT', emoticonCount: 0 });

    // 감정 2개 생성
    expect((await idem(c, `/sets/${set.id}/generations`, { emotions: [] })).body.errorCode).toBe('VALIDATION_ERROR');
    const gj = await idem(c, `/sets/${set.id}/generations`, { emotions: [{ key: 'happy' }, { key: 'thanks', customPrompt: '꽃다발을 들고' }] });
    expect(gj.status).toBe(202);
    expect(gj.body.data.creditCost).toBe(2);
    let detail = (await c.get(`/sets/${set.id}`)).body.data;
    expect(detail.emoticons.map((e: { status: string }) => e.status)).toEqual(['GENERATING', 'GENERATING']);
    expect(detail.status).toBe('DRAFT');

    const job = await w.claimJob(gj.body.data.jobId);
    expect(job.params.items.map((i: { label: string }) => i.label)).toEqual(['happy', 'thanks']);
    expect(job.params.items[1].prompt).toContain('꽃다발');
    expect(job.inputImageUrls).toHaveLength(1); // 기준 캐릭터 이미지
    await w.finish(gj.body.data.jobId, 2, ['happy', 'thanks']);

    detail = (await c.get(`/sets/${set.id}`)).body.data;
    expect(detail.status).toBe('READY');
    expect(detail.emoticons.every((e: { status: string; version: number }) => e.status === 'READY' && e.version === 1)).toBe(true);
    expect(detail.coverUrl).toMatch(/^https:/);
    const emo = detail.emoticons[0].id;

    // 라벨 수정
    expect((await c.patch(`/emoticons/${emo}`, { label: '기쁨!' })).body.data.label).toBe('기쁨!');

    // 재생성 → 새 버전(현재 버전은 그대로)
    const rj = await idem(c, `/emoticons/${emo}/regenerations`, { prompt: '더 크게 웃는 얼굴' });
    expect(rj.status).toBe(202);
    await w.claimJob(rj.body.data.jobId);
    await w.finish(rj.body.data.jobId, 1);
    let versions = (await c.get(`/emoticons/${emo}/versions`)).body.data.items;
    expect(versions.map((v: { version: number; source: string; isCurrent: boolean }) => [v.version, v.source, v.isCurrent])).toEqual([
      [2, 'REGENERATED', false], [1, 'GENERATED', true],
    ]);
    expect((await c.get(`/emoticons/${emo}`)).body.data.version).toBe(1);
    expect((await c.put(`/emoticons/${emo}/versions/${versions[0].versionId}/current`)).body.data.version).toBe(2);

    // 인페인트: 마스크 업로드(원본과 같은 크기) → 작업 → 합성 결과가 새 버전으로
    const mp = (await c.post('/uploads/images/presign', { contentType: 'image/png', sizeBytes: PNG.length, purpose: 'MASK' })).body.data;
    await fetch(mp.uploadUrl, { method: 'PUT', headers: mp.uploadHeaders, body: PNG });
    await c.post(`/uploads/images/${mp.uploadId}/complete`);
    expect((await idem(c, `/emoticons/${emo}/inpaints`, { maskUploadId: 'nope', prompt: '웃는 입' })).body.errorCode).toBe('VALIDATION_ERROR');
    const ij = await idem(c, `/emoticons/${emo}/inpaints`, { maskUploadId: mp.uploadId, prompt: '웃는 입으로 변경' });
    expect(ij.status).toBe(202);
    const ijob = await w.claimJob(ij.body.data.jobId);
    expect(ijob.maskImageUrl).toMatch(/^https:/);
    expect((await w.finish(ij.body.data.jobId, 1)).status).toBe(200);
    versions = (await c.get(`/emoticons/${emo}/versions`)).body.data.items;
    expect(versions[0]).toMatchObject({ version: 3, source: 'INPAINTED' });

    // 다운로드: 원본 / Discord 규격(128x128 PNG) / 투명 PNG / ZIP
    const orig = await c.get(`/emoticons/${emo}/download?format=ORIGINAL`);
    expect(orig.body.data.fileName).toBe('기쁨!.png');
    expect((await fetch(orig.body.data.url)).status).toBe(200);
    const dc = await c.get(`/emoticons/${emo}/download?format=DISCORD`);
    const dcBytes = Buffer.from(await (await fetch(dc.body.data.url)).arrayBuffer());
    expect(dcBytes.readUInt32BE(16)).toBe(128); // PNG 가로
    expect(dcBytes.readUInt32BE(20)).toBe(128);
    expect(dc.body.data.sizeBytes).toBeLessThanOrEqual(256 * 1024);
    expect((await c.get(`/emoticons/${emo}/download?format=TRANSPARENT_PNG`)).status).toBe(200);
    expect((await c.get(`/emoticons/${emo}/download?format=BAD`)).body.errorCode).toBe('VALIDATION_ERROR');
    const zip = await c.get(`/sets/${set.id}/download?format=DISCORD`);
    expect(zip.status).toBe(200);
    const zbytes = Buffer.from(await (await fetch(zip.body.data.url)).arrayBuffer());
    expect(zbytes.subarray(0, 2).toString()).toBe('PK');
    expect(zip.body.data.fileName).toBe('토끼_기본.zip');

    // 남의 이모티콘은 접근 불가
    const other = await signedUp(app, ctx.mail);
    expect((await other.c.get(`/emoticons/${emo}`)).body.errorCode).toBe('NOT_FOUND');
    expect((await other.c.get(`/emoticons/${emo}/download?format=ORIGINAL`)).body.errorCode).toBe('NOT_FOUND');

    // 이모티콘·세트 삭제
    expect((await c.del(`/emoticons/${emo}`)).status).toBe(200);
    expect((await c.get(`/emoticons/${emo}`)).body.errorCode).toBe('NOT_FOUND');
    expect((await c.del(`/sets/${set.id}`)).status).toBe(200);
    expect((await c.get('/sets')).body.data.totalElements).toBe(0);
  });

  it('실패 보고는 크레딧을 반환하고 이모티콘을 FAILED 로, 대기 중 작업은 취소하면 즉시 반환', async () => {
    const { c } = await signedUp(app, ctx.mail);
    const ch = (await c.post('/characters', { name: '펭귄', description: '검정 펭귄', stylePreset: 'pixel' })).body.data.id;
    const cj = (await idem(c, `/characters/${ch}/candidates`, { count: 1 })).body.data.jobId;
    await w.claimJob(cj);
    await w.finish(cj, 1);
    const cand = (await c.get(`/characters/${ch}/candidates`)).body.data.items[0].imageId;
    await c.post(`/characters/${ch}/confirm`, { candidateImageId: cand });
    const set = (await c.post('/sets', { characterId: ch, title: '펭귄' })).body.data.id;
    expect(await balance(c)).toEqual({ balance: 19, reserved: 0 });

    const gj = (await idem(c, `/sets/${set}/generations`, { emotions: [{ key: 'sad' }, { key: 'angry' }] })).body.data.jobId;
    expect(await balance(c)).toEqual({ balance: 17, reserved: 2 });
    await w.claimJob(gj);
    expect((await w.call(`/${gj}/fail`, { reason: 'GPU_ERROR', message: 'oom' })).body.data.status).toBe('FAILED');
    expect(await balance(c)).toEqual({ balance: 19, reserved: 0 });
    const failed = await c.get(`/generations/${gj}`);
    expect(failed.body.data).toMatchObject({ status: 'FAILED', errorCode: 'PROVIDER_ERROR' });
    expect((await c.get(`/sets/${set}`)).body.data.emoticons.map((e: { status: string }) => e.status)).toEqual(['FAILED', 'FAILED']);

    // 대기 중 작업 취소
    const q = (await idem(c, `/characters/${ch}/candidates`, { count: 3 })).body.data;
    expect(q.queuePosition).toBeGreaterThanOrEqual(1);
    expect(await balance(c)).toEqual({ balance: 16, reserved: 3 });
    expect((await c.post(`/generations/${q.jobId}/cancel`)).status).toBe(200);
    expect(await balance(c)).toEqual({ balance: 19, reserved: 0 });
    expect((await c.get(`/generations/${q.jobId}`)).body.data.status).toBe('CANCELED');
    expect((await c.post(`/generations/${q.jobId}/cancel`)).body.errorCode).toBe('JOB_NOT_CANCELABLE');

    // 내역: RESERVE/RELEASE/CONSUME 이 남는다
    const types = (await c.get('/wallet/credit-transactions?size=50')).body.data.items.map((t: { type: string }) => t.type);
    expect(types).toEqual(expect.arrayContaining(['RESERVE', 'CONSUME', 'RELEASE', 'GRANT']));
    expect((await c.get('/generations?status=FAILED')).body.data.totalElements).toBe(1);
  });

  it('크레딧 부족·금칙어·비용 계산', async () => {
    const { c } = await signedUp(app, ctx.mail);
    const ch = (await c.post('/characters', { name: '고양이', description: '검은 고양이', stylePreset: 'pastel' })).body.data.id;
    const est = await c.post('/generations/estimates', { type: 'EMOTION_SET', count: 8 });
    expect(est.body.data).toMatchObject({ creditCost: 8, creditBalance: 20, sufficient: true });
    expect((await c.post('/generations/estimates', { type: 'EMOTION_SET', count: 25 })).body.data.sufficient).toBe(false);
    expect((await idem(c, `/characters/${ch}/candidates`, { count: 1, extraPrompt: 'nude' })).body.errorCode).toBe('CONTENT_BLOCKED');
    // 4장씩 5번 = 20 사용 → 다음 요청은 크레딧 부족
    for (let i = 0; i < 5; i++) expect((await idem(c, `/characters/${ch}/candidates`, { count: 4, extraPrompt: `v${i}` })).status).toBe(202);
    expect((await idem(c, `/characters/${ch}/candidates`, { count: 1, extraPrompt: 'last' })).body.errorCode).toBe('INSUFFICIENT_CREDIT');
    expect(await balance(c)).toEqual({ balance: 0, reserved: 20 });
  });

  it('활동 포인트 교환: 단위·부족 검사와 보상 규칙 조회', async () => {
    const { c } = await signedUp(app, ctx.mail);
    expect((await idem(c, '/wallet/point-exchanges', { points: 50 })).body.errorCode).toBe('BELOW_MINIMUM');
    expect((await idem(c, '/wallet/point-exchanges', { points: 150 })).body.errorCode).toBe('VALIDATION_ERROR');
    expect((await idem(c, '/wallet/point-exchanges', { points: 100 })).body.errorCode).toBe('INSUFFICIENT_POINT');
    const rules = (await c.get('/rewards/rules')).body.data;
    expect(rules.exchange).toMatchObject({ rate: 0.1, unit: 100 });
    expect(rules.rules.map((r: { action: string }) => r.action)).toContain('POST_LIKED');
    expect((await c.get('/credit-packages')).body.data.items.length).toBeGreaterThanOrEqual(3);
    // 포인트를 직접 넣고 교환
    await ctx.prisma.wallet.update({ where: { userId: (await c.get('/users/me')).body.data.id }, data: { pointBalance: 300 } });
    const key = idemKey();
    const ex = await idem(c, '/wallet/point-exchanges', { points: 200 }, key);
    expect(ex.status).toBe(201);
    expect(ex.body.data).toMatchObject({ exchangedPoints: 200, grantedCredits: 20, creditBalance: 40, pointBalance: 100 });
    expect((await idem(c, '/wallet/point-exchanges', { points: 200 }, key)).body.data.creditBalance).toBe(40); // 같은 키: 한 번만
    expect((await idem(c, '/wallet/point-exchanges', { points: 100 })).status).toBe(201);
    const wl = (await c.get('/wallet')).body.data.activityPoint;
    expect(wl).toMatchObject({ balance: 0, monthlyExchanged: 300, monthlyExchangeCap: 500 });
    void post;
  });
});
