# EmoMix frontend

프론트엔드 소스와 배포 설정은 이 폴더에서 관리한다.

## 실행

Node.js 20.19+ 또는 22.12+와 pnpm을 사용한다.

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm dev
```

개발 주소는 `http://localhost:5173`이다. `/api`는 배포 백엔드로 프록시된다. Vercel 프로젝트의 Root Directory는 `frontend`로 지정한다. 배포 시 `vercel.json`이 API 요청과 Discord 콜백을 rewrite한다.

```sh
pnpm test
pnpm build
```

## 결제 설정

`.env.example`을 `.env.local`로 복사하고 공개 클라이언트 키만 설정한다. Vercel에서도 동일한 환경변수를 설정한 후 다시 빌드한다.

- `VITE_TOSS_CLIENT_KEY`: 일반 결제용 위젯 키(`test_gck`/`live_gck`) 또는 개별 연동 키(`test_ck`/`live_ck`).
- `VITE_TOSS_BILLING_CLIENT_KEY`: 구독 카드 등록용 개별 연동 키(`test_ck`/`live_ck`). 위젯 키로는 카드 등록을 할 수 없다.
- `VITE_TOSS_PAYMENT_VARIANT`, `VITE_TOSS_AGREEMENT_VARIANT`: 위젯 관리 화면의 UI 키. 기본값은 `DEFAULT`, `AGREEMENT`.

서버의 토스 시크릿 키는 해당 클라이언트 키와 같은 상점/환경에 속해야 한다. 시크릿 키와 GPU 워커 키는 프론트에 넣지 않는다. `.env.local`은 Git에서 제외된다.

## 연동

계정·약관·알림, 캐릭터·세트·감정별 생성/수정, 보관함, 커뮤니티, 마켓, 주문·결제·환불, 크레딧·포인트·구독, 창작자 정산, 관리자 화면에서 실제 백엔드 API를 호출한다. 서버의 권한과 상태에 따라 허용되는 작업만 수행하며 오류를 화면에 표시한다.

`api.js`는 쿠키 인증, CSRF 초기화/갱신, 공유 토큰 재발급과 업로드 완료 처리를 담당한다. 생성·결제 요청은 멱등키를 사용한다. 결제 성공 콜백에서는 주문과 금액을 서버에서 다시 조회하고 최종 승인 응답을 받은 뒤 완료 처리한다.

검증 범위와 외부 환경의 남은 확인 사항은 [INTEGRATION.md](./INTEGRATION.md)에 기록했다. `generation.html`은 이전 단일 생성 화면이다.

실제 서버 조회 점검은 `pnpm test:live`로 실행한다. 프로세스 환경변수 `EMOMIX_TEST_EMAIL`, `EMOMIX_TEST_PASSWORD`를 먼저 설정한다. 이 명령은 생성·구매·공개 게시·계정 변경을 하지 않으며, 권한이 없는 관리자/창작자 요청의 403도 검사한다.

## 캐릭터 결과 선택과 반복 수정

만들기 화면에서 1·2·3장을 선택해 생성한다. 결과를 선택하면 해당 이미지를 크게 보여주며, 전체 수정 또는 부분 수정으로 1장씩 계속 수정할 수 있다. 부분 수정은 마우스/터치로 수정할 영역을 칠하고 지우개·붓 크기·초기화를 사용한다. 영역을 선택하지 않으면 요청하지 않는다. 이전 결과는 수정 기록에서 다시 선택할 수 있고, 기준 캐릭터는 최종 확정 버튼을 누를 때 변경된다.

새 프론트와 함께 캐릭터 수정 API 두 개(`/characters/:id/regenerations`, `/characters/:id/inpaints`) 및 워커 완료 처리 변경을 배포해야 한다. 기존 이모티콘 인페인트 API를 캐릭터에 대신 호출하지 않는다. GPU 워커의 claim 응답 구조와 인증 방식은 유지하며, `INPAINT`를 처리하는 워커가 필요하다.

브라우저 회귀 테스트: `pnpm build` 후 `pnpm exec playwright install chromium`, `pnpm test:editor`를 실행한다. `TEST_COUNT=1`, `2`, `3`으로 각 생성 장수를 검사할 수 있고, 이미 설치된 Chrome은 `CHROME_PATH`로 지정할 수 있다. 테스트는 로컬 모의 API만 사용해 생성 장수·결과 선택·마스크 PNG·연속 수정·재시도 멱등키·수정 기록·모바일 표시를 확인한다. 실제 GPU 생성 품질을 검증하는 테스트는 아니다.
