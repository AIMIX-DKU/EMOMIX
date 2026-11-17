// 초기 데이터: node prisma/seed.mjs  (여러 번 실행해도 안전: upsert)
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const effectiveAt = new Date('2026-11-01T00:00:00Z');

const terms = [
  ['term-service', 'SERVICE', '서비스 이용약관', true, '# 서비스 이용약관\n\n(시제품 임시 문구) EmoMix 서비스 이용에 관한 기본 약관입니다.'],
  ['term-privacy', 'PRIVACY', '개인정보 처리방침', true, '# 개인정보 처리방침\n\n(시제품 임시 문구) 수집 항목: 이메일, 닉네임. 목적: 회원 관리와 서비스 제공.'],
  ['term-ai', 'AI_CONTENT', 'AI 생성물 이용 안내', true, '# AI 생성물 이용 안내\n\n(시제품 임시 문구) AI가 생성한 이미지의 권리와 사용 범위, 외부 플랫폼 등록 시 유의사항을 안내합니다.'],
  ['term-creator', 'CREATOR', '창작자 약관', true, '# 창작자 약관\n\n(시제품 임시 문구) 상품 판매, 수수료, 정산에 관한 약관입니다.'],
  ['term-marketing', 'MARKETING', '마케팅 정보 수신 동의', false, '# 마케팅 정보 수신 동의\n\n(시제품 임시 문구) 이벤트·소식 알림 수신에 동의합니다.'],
];

const styles = [
  ['pastel', '파스텔', 'soft pastel colors, rounded shapes, cute sticker style', 1],
  ['cartoon', '카툰', 'bold outline cartoon style, flat colors, expressive', 2],
  ['pixel', '픽셀', '16-bit pixel art style, limited palette', 3],
  ['watercolor', '수채화', 'watercolor illustration, soft edges, light wash', 4],
  ['minimal', '미니멀 라인', 'minimal line art, simple strokes, monochrome accent', 5],
];

const emotions = [
  ['happy', '기쁨', 'happy smiling joyful'], ['sad', '슬픔', 'sad crying tears'], ['angry', '화남', 'angry furious'],
  ['thanks', '감사', 'grateful bowing thank you'], ['surprised', '놀람', 'surprised shocked wide eyes'],
  ['love', '사랑', 'in love with hearts'], ['tired', '피곤', 'tired sleepy exhausted'], ['cheer', '응원', 'cheering fighting pose'],
  ['embarrassed', '당황', 'embarrassed sweating flustered'], ['congrats', '축하', 'celebrating confetti party'],
  ['hello', '인사', 'waving hello greeting'], ['goodnight', '잘자', 'sleeping goodnight moon'],
  ['ok', '확인', 'thumbs up okay'], ['sorry', '미안', 'apologizing sorry'], ['hungry', '배고픔', 'hungry drooling food'],
  ['laugh', '빵터짐', 'laughing out loud rolling'],
];

const situations = new Set(['thanks', 'cheer', 'congrats', 'hello', 'goodnight', 'ok', 'sorry']);

const rewards = [
  ['POST_PUBLISHED', '이모티콘 세트를 공유함', 10, 3], ['POST_LIKED', '내 게시물이 좋아요를 받음', 2, 20],
  ['REVIEW_WRITTEN', '상품 후기를 작성함', 5, 3], ['SALE', '내 상품이 판매됨', 20, null], ['PURCHASE', '상품을 구매함', 5, 5],
];

const packages = [
  ['10 크레딧', 10, 0, 1000], ['50 크레딧', 50, 5, 4500], ['100 크레딧', 100, 15, 8000],
];

for (const [id, type, title, required, content] of terms) {
  await prisma.term.upsert({
    where: { id },
    create: { id, type, version: '1.0', title, required, content, effectiveAt },
    update: { title, required, content },
  });
}
for (const [key, name, promptHint, sortOrder] of styles) {
  await prisma.stylePreset.upsert({ where: { key }, create: { key, name, promptHint, sortOrder }, update: { name, promptHint, sortOrder } });
}
for (const [i, [key, name, promptHint]] of emotions.entries()) {
  const category = situations.has(key) ? 'SITUATION' : 'EMOTION';
  await prisma.emotionPreset.upsert({
    where: { key }, create: { key, name, promptHint, sortOrder: i, category }, update: { name, promptHint, sortOrder: i, category },
  });
}
for (const [key, description, points, dailyLimit] of rewards) {
  await prisma.rewardRule.upsert({ where: { key }, create: { key, description, points, dailyLimit }, update: { description, points, dailyLimit } });
}
for (const [name, credits, bonusCredits, price] of packages) {
  const found = await prisma.creditPackage.findFirst({ where: { name } });
  if (!found) await prisma.creditPackage.create({ data: { name, credits, bonusCredits, price } });
  else await prisma.creditPackage.update({ where: { id: found.id }, data: { credits, bonusCredits, price } });
}
await prisma.rewardRule.deleteMany({ where: { key: { notIn: rewards.map((r) => r[0]) } } });

const adminEmail = (process.env.ADMIN_EMAIL ?? '').toLowerCase();
if (adminEmail && process.env.ADMIN_PASSWORD) {
  const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    create: {
      email: adminEmail, passwordHash, nickname: 'admin', role: 'ADMIN',
      identities: { create: { provider: 'EMAIL', providerUserId: adminEmail } },
    },
    update: { role: 'ADMIN', passwordHash },
  });
  await prisma.wallet.upsert({ where: { userId: admin.id }, create: { userId: admin.id }, update: {} });
}
console.log('seed done');
await prisma.$disconnect();
