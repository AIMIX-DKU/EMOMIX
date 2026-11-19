# EmoMix

AI 이모티콘 플랫폼 EmoMix. 백엔드와 프론트를 한 저장소에서 작업한다.

| 폴더 | 내용 | 배포 |
| --- | --- | --- |
| [`backend/`](backend/README.md) | NestJS + Prisma + Neon(PostgreSQL) API 서버 | Vercel 프로젝트 `emomix-backend` (Root Directory `backend`) |
| `frontend/` | 프론트엔드 | Vercel 프로젝트(별도, Root Directory `frontend`) |

## 기준 문서
- API 명세와 컨벤션: Notion (팀플 / EmoMix API 명세서, GPU 워커 연동 가이드). `backend/docs/` 는 Postman 가져오기와 자동 점검용 사본.

## 작업 규칙
- `main` 에 직접 push 하지 않고 브랜치(`feat/…`, `fix/…`, `docs/…`)에서 PR 을 올린다.
- 커밋 메시지와 PR 제목에 접두어를 붙인다: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `ci:`.
- 각자 자기 폴더(`backend/` 또는 `frontend/`) 안에서 작업한다. 루트 파일(`README.md`, `.gitignore`, `.github/`)을 바꿀 때는 서로 알린다.
- CI 는 바뀐 폴더에 대해서만 돈다(`.github/workflows/`). 백엔드 e2e 는 공용 테스트 DB 를 쓰므로 한 번에 하나만 실행된다.
