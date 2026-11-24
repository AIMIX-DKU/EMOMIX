// 외부 서비스 연결 점검: node scripts/check-infra.mjs  (.env 값 사용, 값은 출력하지 않음)
import 'dotenv/config';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import nodemailer from 'nodemailer';

const e = process.env;
async function s3(region) {
  const c = new S3Client({ region, endpoint: e.S3_ENDPOINT, forcePathStyle: true,
    credentials: { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY } });
  const Key = `healthcheck/${Date.now()}.txt`, Bucket = e.S3_BUCKET;
  const put = await getSignedUrl(c, new PutObjectCommand({ Bucket, Key, ContentType: 'text/plain' }), { expiresIn: 60 });
  const r1 = await fetch(put, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'hello' });
  const get = await getSignedUrl(c, new GetObjectCommand({ Bucket, Key }), { expiresIn: 60 });
  const r2 = await fetch(get);
  const body = await r2.text();
  await c.send(new DeleteObjectCommand({ Bucket, Key })).catch(() => {});
  return `PUT ${r1.status}, GET ${r2.status}, body=${body}`;
}
for (const region of [e.S3_REGION, 'us-east-2']) {
  try { console.log(`S3 region=${region}:`, await s3(region)); } catch (x) { console.log(`S3 region=${region}: FAIL`, x.name, x.message.slice(0, 120)); }
}
try {
  await nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: e.SMTP_USER, pass: e.SMTP_PASS } }).verify();
  console.log('SMTP: OK');
} catch (x) { console.log('SMTP: FAIL', x.message.slice(0, 120)); }
