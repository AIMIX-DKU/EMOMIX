# EmoMix API 컨벤션

## 기본
- Base URL: `/api/v1`, 모든 본문은 JSON(UTF-8). 파일은 API 서버를 거치지 않고 presigned URL로 스토리지에 직접 PUT 한다(서버리스 요청 본문 한도 때문).
- 필드명 camelCase, 시간은 ISO-8601 UTC, ID는 문자열(UUID), 금액은 원(KRW) 정수.
- 목록은 `page`(0부터)·`size`(기본 20, 최대 50) 쿼리, 응답은 `data.items[] + page,size,totalElements,totalPages`.

## 공통 응답 포맷
항상 `{ success, message, data, errorCode }`.
- 성공: `success: true`, `data`에 값, `errorCode: null`
- 실패: `success: false`, `data: null`, `errorCode`에 아래 문자열 코드, `message`는 사용자에게 보여줄 수 있는 한글 문장
- 검증 실패의 필드별 상세는 아직 정하지 않음(우선 message 한 줄).

## 인증 (쿠키 기반)
| 쿠키 | 속성 | 수명 | 용도 |
| --- | --- | --- | --- |
| `accessToken` | HttpOnly, Secure, SameSite=Lax, Path=/ | 15분 | JWT. 모든 인증 API |
| `refreshToken` | HttpOnly, Secure, SameSite=Lax, Path=/api/v1/auth | 14일 | 재발급 전용. 서버에 해시 저장, 사용 시마다 회전, 재사용 감지 시 전체 폐기 |
| `csrfToken` | Secure, SameSite=Lax (JS 읽기 가능) | 세션 | `GET /auth/csrf`로 발급 |
| `signupTicket` | HttpOnly, Secure, 10분 | 10분 | Discord 최초 로그인 후 가입 완료 전용 |

- 상태를 바꾸는 요청(POST/PUT/PATCH/DELETE)은 `X-CSRF-Token` 헤더에 csrfToken 쿠키 값을 넣는다. 서버는 Origin 검증도 함께 한다.
- 프론트와 API는 같은 사이트(예: app.example.com / api.example.com)에 둔다.
- 토큰은 응답 body에 절대 싣지 않는다.
- 소셜 로그인은 Discord Authorization Code 리다이렉트 방식. 이미 이메일로 가입된 이메일로 Discord를 시도하면 계정을 새로 만들지 않고 `ACCOUNT_LINK_REQUIRED`.

## 멱등성
돈·크레딧·생성이 걸린 POST는 `Idempotency-Key`(UUID) 헤더 필수: 생성 작업, 주문, 결제 승인, 후원, 포인트 교환.

## 두 종류의 포인트와 판매 장부
- **크레딧(credit)**: AI 생성에 쓰는 이용권. 구매·체험·운영자 지급·활동 포인트 교환으로 획득. 요청 시 예약 → 성공 시 확정 → 실패 시 반환.
- **활동 포인트(activity point)**: 커뮤니티 활동·거래로 획득. 현금화 불가. 월간 획득 한도와 월간 크레딧 교환 한도가 있음.
- **판매자 매출**: 두 포인트와 섞지 않고 별도 장부(`/seller/ledger`)로 관리. 시제품 단계의 정산은 모의 처리.
- 후원(donation)은 혜택 없는 응원금이고 구매(order)와 흐름이 다르다. 후원은 환불하지 않는다.

## 에러 코드
공통: 400 `VALIDATION_ERROR`, 401 `UNAUTHORIZED`, 403 `FORBIDDEN`/`CSRF_INVALID`, 404 `NOT_FOUND`, 409 `DUPLICATED`/`IDEMPOTENCY_CONFLICT`, 429 `RATE_LIMITED`, 500 `SERVER_ERROR`. 도메인 세부 코드는 공통 코드로 표현이 안 될 때만 의미가 분명한 이름으로 추가했다(전체는 아래).

| Code | HTTP | 메시지 |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | 요청 값이 올바르지 않습니다. |
| `UNAUTHORIZED` | 401 | 로그인이 필요합니다. |
| `CSRF_INVALID` | 403 | CSRF 검증에 실패했습니다. |
| `FORBIDDEN` | 403 | 접근 권한이 없습니다. |
| `NOT_FOUND` | 404 | 존재하지 않는 리소스입니다. |
| `DUPLICATED` | 409 | 이미 존재합니다. |
| `RATE_LIMITED` | 429 | 요청이 너무 많습니다. 잠시 후 다시 시도해주세요. |
| `IDEMPOTENCY_CONFLICT` | 409 | 같은 Idempotency-Key로 다른 요청이 처리 중이거나 완료되었습니다. |
| `SERVER_ERROR` | 500 | 서버 내부 오류가 발생했습니다. |
| `DUPLICATED_EMAIL` | 409 | 이미 가입된 이메일입니다. |
| `DUPLICATED_NICKNAME` | 409 | 이미 사용 중인 닉네임입니다. |
| `INVALID_VERIFICATION_CODE` | 400 | 인증번호가 올바르지 않거나 만료되었습니다. |
| `TERMS_REQUIRED` | 400 | 필수 약관에 동의해야 합니다. |
| `INVALID_CREDENTIALS` | 401 | 이메일 또는 비밀번호가 올바르지 않습니다. |
| `INVALID_PASSWORD` | 400 | 현재 비밀번호가 올바르지 않습니다. |
| `ACCOUNT_LINK_REQUIRED` | 409 | 다른 로그인 수단으로 가입된 계정입니다. 계정 연동이 필요합니다. |
| `ACCOUNT_SUSPENDED` | 403 | 정지된 계정입니다. |
| `LAST_IDENTITY` | 409 | 마지막 로그인 수단은 해제할 수 없습니다. |
| `HAS_PENDING_SETTLEMENT` | 409 | 정산되지 않은 잔액이 있어 탈퇴할 수 없습니다. |
| `SELF_ACTION` | 400 | 본인에게는 할 수 없는 요청입니다. |
| `NOT_CREATOR` | 403 | 창작자 등록이 필요합니다. |
| `FILE_TOO_LARGE` | 413 | 파일 용량이 너무 큽니다. |
| `UNSUPPORTED_FILE_TYPE` | 415 | 지원하지 않는 파일 형식입니다. |
| `CONTENT_BLOCKED` | 422 | 허용되지 않는 콘텐츠입니다. |
| `INSUFFICIENT_CREDIT` | 402 | 크레딧이 부족합니다. |
| `GENERATION_QUEUE_FULL` | 429 | 생성 대기열이 가득 찼습니다. 잠시 후 다시 시도해주세요. |
| `GENERATION_LIMIT_EXCEEDED` | 429 | 일일 생성 한도를 초과했습니다. |
| `CHARACTER_NOT_CONFIRMED` | 409 | 기준 캐릭터가 확정되지 않았습니다. |
| `CHARACTER_IN_USE` | 409 | 사용 중인 캐릭터는 삭제할 수 없습니다. |
| `JOB_NOT_CANCELABLE` | 409 | 취소할 수 없는 작업 상태입니다. |
| `SET_PUBLISHED` | 409 | 공개 또는 판매 중인 세트는 삭제할 수 없습니다. |
| `ALREADY_PUBLISHED` | 409 | 이미 공유된 세트입니다. |
| `ALREADY_PURCHASED` | 409 | 이미 구매한 상품입니다. |
| `NOT_PURCHASED` | 403 | 구매한 상품이 아닙니다. |
| `PRODUCT_UNAVAILABLE` | 409 | 판매 중이 아닌 상품입니다. |
| `PRICE_OUT_OF_RANGE` | 400 | 허용된 가격 범위를 벗어났습니다. |
| `AMOUNT_MISMATCH` | 400 | 결제 금액이 주문 금액과 일치하지 않습니다. |
| `ORDER_NOT_PENDING` | 409 | 결제 대기 상태의 주문이 아닙니다. |
| `PAYMENT_FAILED` | 402 | 결제에 실패하였습니다. |
| `INVALID_SIGNATURE` | 401 | 웹훅 서명이 올바르지 않습니다. |
| `NOT_REFUNDABLE` | 409 | 환불할 수 없는 주문입니다. |
| `INSUFFICIENT_POINT` | 402 | 활동 포인트가 부족합니다. |
| `MONTHLY_CAP_EXCEEDED` | 409 | 월간 한도를 초과했습니다. |
| `BELOW_MINIMUM` | 400 | 최소 요청 단위보다 작습니다. |
| `INSUFFICIENT_BALANCE` | 409 | 잔액이 부족합니다. |
| `DUPLICATED_REPORT` | 409 | 이미 신고한 대상입니다. |
| `ALREADY_SUBSCRIBED` | 409 | 이미 구독 중입니다. |
| `NOT_SUBSCRIBED` | 404 | 구독 중이 아닙니다. |
| `LEASE_EXPIRED` | 409 | 작업 임대가 만료되었거나 다른 워커에 배정되었습니다. |