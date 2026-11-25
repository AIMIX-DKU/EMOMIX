import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkshop } from './workshop.js';
import { createAdmin } from './admin-features.js';

const ui = {
  link: (label) => label,
  action: (label) => label,
};
test('long queued jobs explain waiting and allow cancellation without pretending to run', async (t) => {
  const job = {
    jobId: 'test-job',
    status: 'QUEUED',
    createdAt: new Date(Date.now() - 90000).toISOString(),
    creditCost: 1,
    progress: 0,
    queuePosition: 1,
    targetType: 'CHARACTER',
    targetId: 'test-character',
  };
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ success: true, data: job }),
  );
  const html = await createWorkshop(ui).routes.job({ id: job.jobId });
  assert.match(html, /아직 생성이 시작되지 않았어요/);
  assert.match(html, /예약 크레딧은 반환/);
  assert.match(html, /대기 취소/);
  assert.match(html, /data-watch-job/);
  job.status = 'RUNNING';
  const running = await createWorkshop(ui).routes.job({ id: job.jobId });
  assert.doesNotMatch(running, /아직 생성이 시작되지 않았어요/);
  assert.doesNotMatch(running, /대기 취소/);
});
test('non-admin accounts receive a permission error before admin data is requested', async (t) => {
  const paths = [];
  t.mock.method(globalThis, 'fetch', async (path) => {
    paths.push(path);
    return Response.json({ success: true, data: { role: 'USER' } });
  });
  await assert.rejects(
    createAdmin(ui).admin({}),
    (error) => error.status === 403 && error.code === 'FORBIDDEN',
  );
  assert.deepEqual(paths, ['/api/v1/users/me']);
});
