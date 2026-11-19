// 구현된 라우트가 OpenAPI 명세(../emomix_api/openapi.json)와 일치하는지 점검한다.
//   node scripts/check-routes.mjs   (먼저 npm run build)
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import '../dist/config.js';
import { AppModule } from '../dist/app.module.js';
import { setupApp } from '../dist/setup.js';

const specPath = process.argv[2] ?? '../docs/openapi.json';
const spec = JSON.parse(readFileSync(new URL(specPath, import.meta.url), 'utf8'));
const want = new Set();
for (const [path, ops] of Object.entries(spec.paths)) {
  for (const m of Object.keys(ops)) if (['get', 'post', 'put', 'patch', 'delete'].includes(m)) want.add(`${m.toUpperCase()} /api/v1${path.replace(/\{(\w+)\}/g, ':$1')}`);
}

const app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
setupApp(app);
await app.init();
const router = app.getHttpAdapter().getInstance().router;
const have = new Set();
const norm = (p) => p.replace(/:\w+/g, ':x');
for (const layer of router.stack) {
  if (!layer.route) continue;
  for (const m of Object.keys(layer.route.methods)) have.add(`${m.toUpperCase()} ${layer.route.path}`);
}
const haveN = new Set([...have].map((r) => r.replace(/:\w+/g, ':x')));
const wantN = new Map([...want].map((r) => [r.replace(/:\w+/g, ':x'), r]));
const missing = [...wantN].filter(([n]) => !haveN.has(n)).map(([, r]) => r);
const extra = [...haveN].filter((n) => !wantN.has(n));
console.log(`명세 ${want.size}개, 구현 ${have.size}개`);
console.log('명세에 있으나 구현 없음:', missing.length ? missing : '없음');
console.log('구현에 있으나 명세 없음:', extra.length ? extra : '없음');
await app.close();
process.exit(missing.length ? 1 : 0);
