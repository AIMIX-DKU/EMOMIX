import { test } from 'node:test';
import assert from 'node:assert/strict';

const result = (data, status = 200, errorCode) =>
  new Response(
    JSON.stringify({
      success: status < 400,
      data,
      errorCode,
      message: status < 400 ? 'ok' : '로그인 필요',
    }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
async function client() {
  return import('./api.js?test=' + crypto.randomUUID());
}

test('API authentication and uploads', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
  });
  globalThis.document = { cookie: '' };

  await t.test(
    'sends cookies, uses the latest CSRF cookie and preserves an idempotency key',
    async () => {
      const requests = [];
      globalThis.fetch = async (url, options) => {
        requests.push({ url, options });
        return result(
          url.endsWith('/csrf') ? { csrfToken: 'initial' } : { id: 'job' },
        );
      };
      const { api, initializeCsrf } = await client();
      await Promise.all([initializeCsrf(), initializeCsrf()]);
      document.cookie = 'csrfToken=rotated';
      await api('/characters/c/candidates', {
        method: 'POST',
        body: { count: 3 },
        idempotencyKey: 'unique-key',
      });
      assert.equal(requests.filter((r) => r.url.endsWith('/csrf')).length, 1);
      assert.equal(requests.at(-1).options.headers['X-CSRF-Token'], 'rotated');
      assert.equal(
        requests.at(-1).options.headers['Idempotency-Key'],
        'unique-key',
      );
      assert.ok(requests.every((r) => r.options.credentials === 'include'));
    },
  );

  await t.test(
    'shares a rotating refresh across concurrent expired access requests',
    async () => {
      let refreshed = false,
        refreshes = 0;
      const clientModule = await client();
      globalThis.fetch = async (url) => {
        if (url.endsWith('/refresh')) {
          refreshes++;
          await new Promise((resolve) => setTimeout(resolve, 20));
          refreshed = true;
          return result(null);
        }
        if (!refreshed) return result(null, 401, 'UNAUTHORIZED');
        return result({ id: 'user' });
      };
      const values = await Promise.all([
        clientModule.api('/users/me'),
        clientModule.api('/wallet'),
      ]);
      assert.equal(refreshes, 1);
      assert.equal(values.length, 2);
    },
  );

  await t.test(
    'does not repeat a mutation after an ambiguous connection failure',
    async () => {
      let requests = 0;
      globalThis.fetch = async () => {
        requests++;
        throw new Error('connection lost');
      };
      const { api } = await client();
      await assert.rejects(
        api('/orders', {
          method: 'POST',
          body: { type: 'PRODUCT' },
          idempotencyKey: 'order-key',
        }),
        { code: 'NETWORK_ERROR' },
      );
      assert.equal(requests, 1);
    },
  );

  await t.test(
    'uploads to storage and confirms completion before returning the upload ID',
    async () => {
      const requests = [];
      globalThis.fetch = async (url, options) => {
        requests.push({ url, options });
        if (url.endsWith('/presign'))
          return result({
            uploadId: 'upload',
            uploadUrl: 'https://storage.example/upload',
            uploadHeaders: { 'Content-Type': 'image/png' },
          });
        if (url === 'https://storage.example/upload')
          return new Response(null, { status: 200 });
        return result({ uploadId: 'upload' });
      };
      const { uploadImage } = await client();
      const uploaded = await uploadImage(
        new File(['png'], 'reference.png', { type: 'image/png' }),
        'REFERENCE',
      );
      assert.equal(uploaded.uploadId, 'upload');
      assert.deepEqual(
        requests.map((r) => r.options.method),
        ['POST', 'PUT', 'POST'],
      );
      assert.ok(
        requests.at(-1).url.endsWith('/uploads/images/upload/complete'),
      );
      assert.equal(requests[1].options.headers['X-CSRF-Token'], undefined);
    },
  );
});
