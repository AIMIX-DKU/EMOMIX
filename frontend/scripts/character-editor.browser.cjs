const fs = require('node:fs'),
  http = require('node:http'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const dir = path.resolve(__dirname, '../dist');
const artifacts =
  process.env.EMOMIX_TEST_ARTIFACT_DIR || require('node:os').tmpdir();
let port,
  character = {
    id: 'char',
    description: '파란 물방울',
    stylePreset: 'pastel',
    status: 'DRAFT',
  },
  candidates = [],
  job,
  version = 0,
  mask,
  failEditOnce = false;
const calls = [],
  errors = [];
const count = Number(process.env.TEST_COUNT || 3);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  if (url.pathname === '/storage' && req.method === 'PUT') {
    mask = PNG.sync.read(body);
    res.end();
    return;
  }
  if (url.pathname === '/image.svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#f0f6ff"/><path d="M128 20Q235 150 205 195Q128 265 51 195Q20 150 128 20" fill="#3978f4"/><circle cx="98" cy="155" r="8" fill="#123364"/><circle cx="158" cy="155" r="8" fill="#123364"/><path d="M110 180Q128 197 146 180" stroke="#123364" fill="none" stroke-width="6"/></svg>',
    );
    return;
  }
  if (url.pathname.startsWith('/api/v1')) {
    const p = url.pathname.slice(7),
      b = body.length ? JSON.parse(body) : undefined;
    calls.push({
      p,
      method: req.method,
      b,
      key: req.headers['idempotency-key'],
    });
    let data;
    if (p === '/auth/csrf') {
      res.setHeader('Set-Cookie', 'csrfToken=csrf; Path=/');
      data = { csrfToken: 'csrf' };
    } else if (p === '/users/me')
      data = { id: 'user', nickname: '테스터', role: 'USER' };
    else if (p === '/wallet')
      data = { credit: { balance: 100 }, activityPoint: { balance: 0 } };
    else if (p === '/style-presets')
      data = { items: [{ key: 'pastel', label: '파스텔' }] };
    else if (p === '/generations/estimates')
      data = { sufficient: true, creditCost: 1, creditBalance: 100 };
    else if (p === '/characters' && req.method === 'POST') data = character;
    else if (p === '/characters/char') data = character;
    else if (p === '/characters/char/candidates' && req.method === 'GET')
      data = { items: candidates };
    else if (
      [
        '/characters/char/candidates',
        '/characters/char/regenerations',
        '/characters/char/inpaints',
      ].includes(p) &&
      req.method === 'POST'
    ) {
      if (p.endsWith('/regenerations') && failEditOnce) {
        failEditOnce = false;
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            success: false,
            message: '잠시 후 다시 확인해주세요.',
          }),
        );
        return;
      }
      const batch = [];
      for (let i = 0; i < (b.count || 1); i++) {
        version++;
        const item = {
          imageId: 'v' + version,
          imageUrl: '/image.svg?v=' + version,
        };
        candidates.unshift(item);
        batch.push(item);
      }
      job = {
        jobId: 'job' + version,
        status: 'SUCCEEDED',
        type: p.endsWith('/inpaints') ? 'INPAINT' : 'CHARACTER_CANDIDATES',
        targetType: 'CHARACTER',
        targetId: 'char',
        result: { images: batch.map((item) => ({ id: item.imageId })) },
      };
      data = job;
    } else if (p.startsWith('/generations/job')) data = job;
    else if (p === '/uploads/images/presign')
      data = {
        uploadId: 'mask',
        uploadUrl: 'http://localhost:' + port + '/storage',
        uploadHeaders: { 'Content-Type': 'image/png' },
      };
    else if (p === '/uploads/images/mask/complete') data = { uploadId: 'mask' };
    else if (p === '/characters/char/confirm')
      data = { ...character, status: 'CONFIRMED' };
    else if (p === '/sets') data = { items: [], totalPages: 0 };
    else {
      errors.push('Unexpected ' + req.method + ' ' + p);
      res.statusCode = 404;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: res.statusCode === 200, data }));
    return;
  }
  const file = path.resolve(
    dir,
    '.' + (url.pathname === '/' ? '/index.html' : url.pathname),
  );
  if (path.relative(dir, file).startsWith('..') || !fs.existsSync(file)) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader(
    'Content-Type',
    { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[
      path.extname(file)
    ] || 'application/octet-stream',
  );
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  port = server.address().port;
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1360, height: 1000 },
    });
    page.on('dialog', (d) => d.accept());
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://localhost:' + port);
    assert.equal(await page.locator('[name=count]').inputValue(), '1');
    await page.locator('[name=count]').selectOption(String(count));
    await page.locator('[name=description]').fill('파란 물방울');
    await page
      .getByRole('button', { name: '이모티콘 만들기', exact: true })
      .click();
    await page.locator('[data-live-form=edit]').waitFor();
    await page.locator('[data-character-mask] img').waitFor();
    if (count > 1)
      await page
        .getByRole('button', { name: '결과 ' + count + ' 선택', exact: true })
        .click();
    assert.equal(
      calls.find((c) => c.p.endsWith('/candidates') && c.method === 'POST').b
        .count,
      count,
    );
    assert.equal(
      calls.find((c) => c.p === '/generations/estimates').b.count,
      count,
    );
    assert.equal(await page.locator('[data-character-mask] img').count(), 1);
    await page.locator('[name=editPrompt]').fill('눈을 웃는 눈으로 바꿔줘');
    await page.getByRole('button', { name: '수정 비용 확인' }).click();
    await page.waitForFunction(() =>
      document.querySelector('.notice').textContent.includes('먼저 칠해'),
    );
    assert.equal(calls.filter((c) => c.p.endsWith('/inpaints')).length, 0);
    const canvas = page.locator('[data-character-mask] canvas');
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, {
      steps: 8,
    });
    await page.mouse.up();
    await page.screenshot({
      path: path.join(artifacts, 'emomix-character-selected.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: '수정 비용 확인' }).click();
    await page.waitForFunction(
      (n) =>
        document
          .querySelector('[data-character-mask] img')
          .src.includes('v=' + n),
      count + 1,
    );
    const partial = calls.find((c) => c.p.endsWith('/inpaints'));
    assert.equal(partial.b.sourceCandidateImageId, 'v' + count);
    assert.equal(partial.b.maskUploadId, 'mask');
    assert.ok(partial.key);
    assert.equal(mask.width, 256);
    assert.equal(mask.height, 256);
    assert.deepEqual([...mask.data.subarray(0, 4)], [0, 0, 0, 255]);
    let white = 0;
    for (let i = 0; i < mask.data.length; i += 4)
      if (mask.data[i] === 255) white++;
    assert.ok(white > 0 && white < (256 * 256) / 2);
    await page.getByRole('button', { name: '전체 수정', exact: true }).click();
    await page.locator('[name=editPrompt]').fill('더 둥글게 바꿔줘');
    failEditOnce = true;
    await page.getByRole('button', { name: '수정 비용 확인' }).click();
    await page
      .getByRole('button', { name: '같은 수정 요청 다시 확인' })
      .waitFor();
    await page
      .getByRole('button', { name: '같은 수정 요청 다시 확인' })
      .click();
    await page.waitForFunction(
      (n) =>
        document
          .querySelector('[data-character-mask] img')
          .src.includes('v=' + n),
      count + 2,
    );
    const edits = calls.filter((c) => c.p.endsWith('/regenerations'));
    assert.equal(edits.length, 2);
    assert.equal(edits[0].key, edits[1].key);
    assert.deepEqual(edits[0].b, edits[1].b);
    assert.equal(edits[1].b.sourceCandidateImageId, 'v' + (count + 1));
    assert.equal(await page.locator('[data-character-mask] img').count(), 1);
    await page.locator('.character-history summary').click();
    assert.equal(
      await page.locator('.character-history img').count(),
      count + 2,
    );
    await page.getByRole('button', { name: '部分修正', exact: true }).count();
    await page.setViewportSize({ width: 390, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > 390),
      false,
    );
    await page.screenshot({
      path: path.join(artifacts, 'emomix-character-mobile.png'),
      fullPage: true,
    });
    await page
      .getByRole('button', { name: '이 캐릭터 확정', exact: true })
      .click();
    await page.waitForFunction(() => location.hash.includes('library'));
    assert.equal(
      calls.find((c) => c.p.endsWith('/confirm')).b.candidateImageId,
      'v' + (count + 2),
    );
    assert.deepEqual(errors, []);
    console.log(
      'PASS 1-3 count selection, repeated partial/full edits, mask PNG dimensions/region, stable retry key, history, confirmation and mobile layout',
    );
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  server.close();
});
