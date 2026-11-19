# EmoMix API 엔드포인트 목록

| # | 카테고리 | 기능 | Method | URI | 인증 |
| --- | --- | --- | --- | --- | --- |
| 1 | Auth | 이메일 인증번호 발송 | POST | `/api/v1/auth/email/verification-codes` | none |
| 2 | Auth | 이메일 인증번호 확인 | POST | `/api/v1/auth/email/verification-codes/verify` | none |
| 3 | Auth | 이메일 회원가입 | POST | `/api/v1/auth/signup` | none |
| 4 | Auth | 이메일 로그인 | POST | `/api/v1/auth/login` | none |
| 5 | Auth | Discord 로그인 시작 | GET | `/api/v1/auth/discord` | none |
| 6 | Auth | Discord 로그인 콜백 | GET | `/api/v1/auth/discord/callback` | none |
| 7 | Auth | Discord 가입 완료 | POST | `/api/v1/auth/discord/signup` | ticket |
| 8 | Auth | 토큰 재발급 | POST | `/api/v1/auth/refresh` | refresh |
| 9 | Auth | 로그아웃 | POST | `/api/v1/auth/logout` | refresh |
| 10 | Auth | CSRF 토큰 발급 | GET | `/api/v1/auth/csrf` | none |
| 11 | Auth | 비밀번호 재설정 | POST | `/api/v1/auth/password/reset` | none |
| 12 | Auth | 비밀번호 변경 | PUT | `/api/v1/users/me/password` | user |
| 13 | Auth | 연동된 로그인 수단 조회 | GET | `/api/v1/users/me/identities` | user |
| 14 | Auth | 로그인 수단 연동 해제 | DELETE | `/api/v1/users/me/identities/{provider}` | user |
| 15 | User | 내 정보 조회 | GET | `/api/v1/users/me` | user |
| 16 | User | 내 정보 수정 | PATCH | `/api/v1/users/me` | user |
| 17 | User | 회원 탈퇴 | DELETE | `/api/v1/users/me` | user |
| 18 | User | 사용자 프로필 조회 | GET | `/api/v1/users/{userId}` | optional |
| 19 | User | 팔로우 | POST | `/api/v1/users/{userId}/follow` | user |
| 20 | User | 언팔로우 | DELETE | `/api/v1/users/{userId}/follow` | user |
| 21 | User | 설정 조회 | GET | `/api/v1/users/me/settings` | user |
| 22 | User | 설정 수정 | PATCH | `/api/v1/users/me/settings` | user |
| 23 | User | 창작자 등록 | POST | `/api/v1/creators/me` | user |
| 24 | User | 내 창작자 정보 조회 | GET | `/api/v1/creators/me` | creator |
| 25 | User | 창작자 정보 수정 | PATCH | `/api/v1/creators/me` | creator |
| 26 | Terms | 약관 목록 조회 | GET | `/api/v1/terms` | none |
| 27 | Terms | 약관 상세 조회 | GET | `/api/v1/terms/{termId}` | none |
| 28 | Terms | 약관 동의 변경 | PUT | `/api/v1/users/me/agreements` | user |
| 29 | Upload | 이미지 업로드 URL 발급 | POST | `/api/v1/uploads/images/presign` | user |
| 30 | Upload | 이미지 업로드 완료 | POST | `/api/v1/uploads/images/{uploadId}/complete` | user |
| 31 | Character | 그림체 프리셋 조회 | GET | `/api/v1/style-presets` | none |
| 32 | Character | 감정 프리셋 조회 | GET | `/api/v1/emotion-presets` | none |
| 33 | Character | 캐릭터 생성 | POST | `/api/v1/characters` | user |
| 34 | Character | 내 캐릭터 목록 조회 | GET | `/api/v1/characters` | user |
| 35 | Character | 캐릭터 상세 조회 | GET | `/api/v1/characters/{characterId}` | user |
| 36 | Character | 캐릭터 수정 | PATCH | `/api/v1/characters/{characterId}` | user |
| 37 | Character | 캐릭터 삭제 | DELETE | `/api/v1/characters/{characterId}` | user |
| 38 | Character | 캐릭터 후보 생성 | POST | `/api/v1/characters/{characterId}/candidates` | user |
| 39 | Character | 캐릭터 후보 목록 조회 | GET | `/api/v1/characters/{characterId}/candidates` | user |
| 40 | Character | 기준 캐릭터 확정 | POST | `/api/v1/characters/{characterId}/confirm` | user |
| 41 | Generation | 생성 비용 사전 계산 | POST | `/api/v1/generations/estimates` | user |
| 42 | Generation | 내 생성 작업 목록 조회 | GET | `/api/v1/generations` | user |
| 43 | Generation | 생성 작업 조회 | GET | `/api/v1/generations/{jobId}` | user |
| 44 | Generation | 생성 작업 취소 | POST | `/api/v1/generations/{jobId}/cancel` | user |
| 45 | Emoticon | 세트 생성 | POST | `/api/v1/sets` | user |
| 46 | Emoticon | 내 세트 목록 조회 | GET | `/api/v1/sets` | user |
| 47 | Emoticon | 세트 상세 조회 | GET | `/api/v1/sets/{setId}` | user |
| 48 | Emoticon | 세트 수정 | PATCH | `/api/v1/sets/{setId}` | user |
| 49 | Emoticon | 세트 삭제 | DELETE | `/api/v1/sets/{setId}` | user |
| 50 | Emoticon | 세트 감정 생성 | POST | `/api/v1/sets/{setId}/generations` | user |
| 51 | Emoticon | 이모티콘 상세 조회 | GET | `/api/v1/emoticons/{emoticonId}` | user |
| 52 | Emoticon | 이모티콘 라벨 수정 | PATCH | `/api/v1/emoticons/{emoticonId}` | user |
| 53 | Emoticon | 이모티콘 삭제 | DELETE | `/api/v1/emoticons/{emoticonId}` | user |
| 54 | Emoticon | 이모티콘 재생성 | POST | `/api/v1/emoticons/{emoticonId}/regenerations` | user |
| 55 | Emoticon | 이모티콘 부분 수정(Inpaint) | POST | `/api/v1/emoticons/{emoticonId}/inpaints` | user |
| 56 | Emoticon | 이모티콘 버전 목록 조회 | GET | `/api/v1/emoticons/{emoticonId}/versions` | user |
| 57 | Emoticon | 이모티콘 버전 선택 | PUT | `/api/v1/emoticons/{emoticonId}/versions/{versionId}/current` | user |
| 58 | Download | 이모티콘 다운로드 | GET | `/api/v1/emoticons/{emoticonId}/download` | user |
| 59 | Download | 세트 ZIP 다운로드 | GET | `/api/v1/sets/{setId}/download` | user |
| 60 | Download | 외부 플랫폼 등록 안내 조회 | GET | `/api/v1/guides/export` | none |
| 61 | Community | 이모티콘 세트 공유(게시) | POST | `/api/v1/posts` | user |
| 62 | Community | 게시물 목록·검색 | GET | `/api/v1/posts` | optional |
| 63 | Community | 게시물 상세 조회 | GET | `/api/v1/posts/{postId}` | optional |
| 64 | Community | 게시물 수정 | PATCH | `/api/v1/posts/{postId}` | user |
| 65 | Community | 게시물 삭제 | DELETE | `/api/v1/posts/{postId}` | user |
| 66 | Community | 좋아요 | POST | `/api/v1/posts/{postId}/likes` | user |
| 67 | Community | 좋아요 취소 | DELETE | `/api/v1/posts/{postId}/likes` | user |
| 68 | Community | 북마크 추가 | POST | `/api/v1/posts/{postId}/bookmarks` | user |
| 69 | Community | 북마크 삭제 | DELETE | `/api/v1/posts/{postId}/bookmarks` | user |
| 70 | Community | 내 북마크 목록 조회 | GET | `/api/v1/users/me/bookmarks` | user |
| 71 | Community | 댓글 목록 조회 | GET | `/api/v1/posts/{postId}/comments` | optional |
| 72 | Community | 댓글 작성 | POST | `/api/v1/posts/{postId}/comments` | user |
| 73 | Community | 댓글 수정 | PATCH | `/api/v1/comments/{commentId}` | user |
| 74 | Community | 댓글 삭제 | DELETE | `/api/v1/comments/{commentId}` | user |
| 75 | Community | 인기 태그 조회 | GET | `/api/v1/tags/popular` | none |
| 76 | Ranking | 인기 이모티콘 랭킹 | GET | `/api/v1/rankings/posts` | optional |
| 77 | Ranking | 인기 프롬프트 랭킹 | GET | `/api/v1/rankings/prompts` | optional |
| 78 | Ranking | 제작자 랭킹 | GET | `/api/v1/rankings/creators` | optional |
| 79 | Market | 상품 등록 | POST | `/api/v1/products` | creator |
| 80 | Market | 상품 목록·검색 | GET | `/api/v1/products` | optional |
| 81 | Market | 상품 상세 조회 | GET | `/api/v1/products/{productId}` | optional |
| 82 | Market | 상품 수정 | PATCH | `/api/v1/products/{productId}` | creator |
| 83 | Market | 상품 판매 중단 | DELETE | `/api/v1/products/{productId}` | creator |
| 84 | Market | 상품 후기 목록 조회 | GET | `/api/v1/products/{productId}/reviews` | none |
| 85 | Market | 상품 후기 작성 | POST | `/api/v1/products/{productId}/reviews` | user |
| 86 | Market | 구매한 상품 다운로드 | GET | `/api/v1/products/{productId}/download` | user |
| 87 | Market | 구매한 템플릿 조회 | GET | `/api/v1/products/{productId}/template` | user |
| 88 | Market | 내 구매 목록(라이브러리) 조회 | GET | `/api/v1/users/me/purchases` | user |
| 89 | Order | 주문 생성 | POST | `/api/v1/orders` | user |
| 90 | Order | 내 주문 목록 조회 | GET | `/api/v1/orders` | user |
| 91 | Order | 주문 상세 조회 | GET | `/api/v1/orders/{orderNo}` | user |
| 92 | Order | 주문 취소·환불 | POST | `/api/v1/orders/{orderNo}/cancel` | user |
| 93 | Payment | 결제 승인 | POST | `/api/v1/payments/confirm` | user |
| 94 | Payment | 결제 웹훅 수신 | POST | `/api/v1/payments/webhook` | webhook |
| 95 | Credit | 내 지갑 조회 | GET | `/api/v1/wallet` | user |
| 96 | Credit | 크레딧 내역 조회 | GET | `/api/v1/wallet/credit-transactions` | user |
| 97 | Credit | 활동 포인트 내역 조회 | GET | `/api/v1/wallet/point-transactions` | user |
| 98 | Credit | 활동 포인트 → 크레딧 교환 | POST | `/api/v1/wallet/point-exchanges` | user |
| 99 | Credit | 크레딧 패키지 목록 조회 | GET | `/api/v1/credit-packages` | none |
| 100 | Credit | 활동 보상 규칙 조회 | GET | `/api/v1/rewards/rules` | none |
| 101 | Donation | 창작자 후원 주문 생성 | POST | `/api/v1/donations` | user |
| 102 | Donation | 내가 한 후원 목록 조회 | GET | `/api/v1/donations/sent` | user |
| 103 | Donation | 받은 후원 목록 조회 | GET | `/api/v1/donations/received` | creator |
| 104 | Seller | 내 판매 상품 목록 조회 | GET | `/api/v1/seller/products` | creator |
| 105 | Seller | 판매 내역 조회 | GET | `/api/v1/seller/sales` | creator |
| 106 | Seller | 판매 장부 조회 | GET | `/api/v1/seller/ledger` | creator |
| 107 | Seller | 정산 가능 금액 조회 | GET | `/api/v1/seller/balance` | creator |
| 108 | Seller | 정산 요청 | POST | `/api/v1/seller/settlements` | creator |
| 109 | Seller | 정산 내역 조회 | GET | `/api/v1/seller/settlements` | creator |
| 110 | Notification | 알림 목록 조회 | GET | `/api/v1/notifications` | user |
| 111 | Notification | 안 읽은 알림 수 조회 | GET | `/api/v1/notifications/unread-count` | user |
| 112 | Notification | 알림 읽음 처리 | PATCH | `/api/v1/notifications/{notificationId}/read` | user |
| 113 | Notification | 알림 전체 읽음 처리 | POST | `/api/v1/notifications/read-all` | user |
| 114 | Notification | 알림 삭제 | DELETE | `/api/v1/notifications/{notificationId}` | user |
| 115 | Report | 신고하기 | POST | `/api/v1/reports` | user |
| 116 | Report | 내 신고 내역 조회 | GET | `/api/v1/reports/me` | user |
| 117 | Admin | 신고 목록 조회 | GET | `/api/v1/admin/reports` | admin |
| 118 | Admin | 신고 상세 조회 | GET | `/api/v1/admin/reports/{reportId}` | admin |
| 119 | Admin | 신고 처리 | PATCH | `/api/v1/admin/reports/{reportId}` | admin |
| 120 | Admin | 사용자 목록 조회 | GET | `/api/v1/admin/users` | admin |
| 121 | Admin | 사용자 정지 | POST | `/api/v1/admin/users/{userId}/suspension` | admin |
| 122 | Admin | 사용자 정지 해제 | DELETE | `/api/v1/admin/users/{userId}/suspension` | admin |
| 123 | Admin | 콘텐츠 숨김 처리 | PATCH | `/api/v1/admin/contents/{targetType}/{targetId}/visibility` | admin |
| 124 | Admin | 크레딧 수동 지급 | POST | `/api/v1/admin/credits/grants` | admin |
| 125 | Admin | 생성 작업 통계 조회 | GET | `/api/v1/admin/generations/stats` | admin |
| 126 | Admin | 운영 정책 조회 | GET | `/api/v1/admin/policies` | admin |
| 127 | Admin | 운영 정책 수정 | PUT | `/api/v1/admin/policies` | admin |
| 128 | Admin | 정산 요청 목록 조회 | GET | `/api/v1/admin/settlements` | admin |
| 129 | Admin | 정산 처리 | PATCH | `/api/v1/admin/settlements/{settlementId}` | admin |
| 130 | System | 서버 상태 확인 | GET | `/api/v1/health` | none |
| 131 | Worker | 생성 작업 가져오기 | POST | `/api/v1/worker/jobs/claim` | worker |
| 132 | Worker | 작업 진행 보고 | POST | `/api/v1/worker/jobs/{jobId}/heartbeat` | worker |
| 133 | Worker | 결과 업로드 URL 발급 | POST | `/api/v1/worker/jobs/{jobId}/upload-urls` | worker |
| 134 | Worker | 작업 완료 보고 | POST | `/api/v1/worker/jobs/{jobId}/complete` | worker |
| 135 | Worker | 작업 실패 보고 | POST | `/api/v1/worker/jobs/{jobId}/fail` | worker |
| 136 | Subscription | 구독 요금제 조회 | GET | `/api/v1/subscription-plans` | none |
| 137 | Subscription | 내 구독 조회 | GET | `/api/v1/subscriptions/me` | user |
| 138 | Subscription | 구독 시작 | POST | `/api/v1/subscriptions` | user |
| 139 | Subscription | 구독 요금제 변경 예약 | PATCH | `/api/v1/subscriptions/me` | user |
| 140 | Subscription | 구독 해지 | DELETE | `/api/v1/subscriptions/me` | user |
| 141 | Subscription | 구독 해지 취소 | POST | `/api/v1/subscriptions/me/resume` | user |
| 142 | Subscription | 결제 카드 변경 | PUT | `/api/v1/subscriptions/me/payment-method` | user |
| 143 | Subscription | 구독 결제 내역 조회 | GET | `/api/v1/subscriptions/me/invoices` | user |
| 144 | Subscription | 정기결제 실행(크론) | GET | `/api/v1/internal/billing/run` | cron |
