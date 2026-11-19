# EmoMix Backend

AI 이모티콘 플랫폼 EmoMix의 백엔드. NestJS 12 + Prisma 6 + PostgreSQL(Neon) + Neon Object Storage(S3 호환), Vercel 서버리스 배포.

- **기준 문서는 Notion(팀플 / EmoMix API 명세서, GPU 워커 연동 가이드)입니다.** 아래 `docs/` 파일은 Postman 가져오기와 자동 점검용 사본이라 Notion과 다를 수 있습니다.
- API 명세: [`docs/openapi.yaml`](docs/openapi.yaml) (Postman으로 Import 가능), [`docs/conventions.md`](docs/conventions.md)(응답 포맷·에러 코드·인증), [`docs/endpoints.md`](docs/endpoints.md)(전체 135개 목록)
- GPU 워커 연동: [`docs/worker-integration.md`](docs/worker-integration.md)

## 구조

```
src/
  common/      응답 포맷(envelope)·에러 코드·접근 가드(쿠키 인증, CSRF)·토큰·스토리지·정책·보상·멱등성
  auth/        이메일 인증·가입·로그인·Discord·토큰 회전·비밀번호
  users/       내 정보·프로필·팔로우·설정·약관·창작자      upload/  이미지 업로드(presigned)
  character/   프리셋·캐릭터·후보·확정                      generation/  생성 작업 큐·크레딧 예약/확정/반환
  emoticon/    세트·이모티콘·버전·재생성·인페인트·다운로드   worker/  GPU 워커 API(pull)
  community/   게시물·좋아요·북마크·댓글·태그·랭킹          market/  상품·후기·구매자 전용
  payment/     주문·결제(토스 테스트)·웹훅·후원·판매자 장부·정산     wallet/  지갑·내역·포인트 교환
  notification/ report/ admin/
prisma/        schema.prisma, migrations, seed.mjs
api/index.js   Vercel 서버리스 진입점
```

## 로컬 실행

```bash
npm install
cp .env.example .env        # 값 채우기(주석에 발급 방법)
npx prisma migrate deploy   # DB 스키마 적용
npm run seed                # 약관·프리셋·보상 규칙·크레딧 패키지·관리자 계정
npm run start:dev           # http://localhost:3000/api/v1/health
```

## 점검

```bash
node scripts/check-infra.mjs     # Neon 스토리지·SMTP 연결 점검
npm run build && node scripts/check-routes.mjs   # 명세 135개 엔드포인트와 구현 일치 여부
npm run test:e2e                 # e2e 테스트. .env.test(테스트 전용 Neon 브랜치)가 있으면 그 DB를 쓰고, 없으면 .env 의 DB를 쓴다.
                                 # 실제 DB·스토리지를 쓰고 e2e- 접두 계정을 만든 뒤 정리한다. 느리니 바꾼 영역의 spec 파일만 지정해 돌릴 것:
                                 #   npm run test:e2e -- test/subscription.e2e-spec.ts
```
테스트는 `MAIL_DRY=1`(메일 미발송), `TOSS_MOCK=1`(결제 승인 가짜 처리, 운영에서는 무시됨)로 동작합니다.

## 설계 메모

- **인증**: HttpOnly 쿠키(accessToken 15분 / refreshToken 14일 회전·재사용 감지 / csrfToken). 상태 변경 요청은 `X-CSRF-Token` + Origin 검사. 프론트와 API는 같은 사이트여야 합니다(`*.vercel.app` 서브도메인끼리는 다른 사이트라 쿠키가 전달되지 않으므로 프론트에서 `/api/*` 를 이 프로젝트로 rewrite 하세요).
- **생성 작업**: POST → 크레딧 예약(RESERVE) + 작업 등록(QUEUED) → GPU 워커가 pull(claim) → 성공 시 확정(CONSUME), 실패/취소 시 반환(RELEASE). 임대(lease) 만료 작업은 `claim` 때 되돌려지므로 크론이 필요 없습니다.
- **돈**: 크레딧(생성 이용권) / 활동 포인트(현금화 불가) / 판매자 장부(별도 원장)를 섞지 않습니다. 결제는 토스 **테스트 키**만 사용합니다.
- **크론 없음**: 주문 만료, 정지 기간 만료, 작업 임대 회수, 미사용 업로드 정리는 모두 접근 시점에 처리합니다(Vercel Hobby 크론 제약 회피).
- **운영 정책**(수수료율·한도 등)은 `Policy` 테이블 값이 코드 기본값보다 우선하며 `/admin/policies` 로 수정합니다.

## 배포 (Vercel)

환경변수는 `.env.example` 의 키를 Vercel 프로젝트에 그대로 등록합니다(`DATABASE_URL`은 풀러 주소). 마이그레이션은 로컬에서 `npx prisma migrate deploy` 로 적용합니다.
