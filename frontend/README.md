# EmoMix frontend

프론트엔드 소스와 배포 설정은 이 폴더에서 관리한다.

## 실행

Node.js 20.19+ 또는 22.12+와 pnpm을 사용한다.

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm dev
```

개발 주소는 `http://localhost:5173`이다. `/api`는 `https://emomix-backend.vercel.app`으로 프록시된다. 백엔드에서 이 개발 주소를 허용해야 한다. Vercel 프론트 프로젝트의 Root Directory는 `frontend`로 지정한다.

```sh
pnpm build
```

## 연동 범위

- 로그인·이메일 인증·회원가입·비밀번호 재설정
- 내 정보·지갑 조회, 프로필 수정, 로그아웃
- 그림체 목록·참고 이미지 업로드·후보 생성 비용 확인
- 후보 생성·작업 조회·대기 취소·기준 캐릭터 확정·다운로드
- 내 캐릭터와 생성 내역 조회

쿠키 인증, CSRF, 토큰 재발급과 생성 요청의 멱등키는 `api.js`에서 처리한다. 계정 비밀번호와 인증 쿠키는 소스에 저장하지 않는다.

커뮤니티·마켓·결제·세트 편집·관리자는 화면 체험 단계이며 실제 처리와 구분하여 표시한다. 실제 GPU 생성과 이미지 업로드·다운로드는 팀 환경에서 추가 검증이 필요하다.

`generation.html`은 이전 단일 생성 화면의 진입점이다.
