// 서버가 내려주는 영문 코드를 화면용 한글로 바꾼다. 모르는 값은 원문 그대로 보여 준다.
const LABELS = {
  // 생성 작업
  CHARACTER_CANDIDATES: '캐릭터 후보 생성',
  EMOTION_SET: '감정 세트 생성',
  EMOTION_REGENERATE: '이모티콘 재생성',
  INPAINT: '부분 수정',
  QUEUED: '대기 중',
  RUNNING: '생성 중',
  SUCCEEDED: '완료',
  FAILED: '실패',
  CANCELED: '취소됨',
  // 이모티콘·세트
  GENERATING: '생성 중',
  READY: '완료',
  // 주문·결제·구독
  PENDING_PAYMENT: '결제 대기',
  PAID: '결제 완료',
  REFUNDED: '환불됨',
  EXPIRED: '만료됨',
  ACTIVE: '이용 중',
  PAST_DUE: '결제 실패 · 재시도 중',
  // 요금제
  FREE: '무료',
  STANDARD: '스탠다드',
  PRO: '프로',
  // 크레딧·포인트 내역
  GRANT: '지급',
  PURCHASE: '충전',
  RESERVE: '생성 예약',
  CONSUME: '사용',
  RELEASE: '예약 반환',
  REFUND: '환불',
  EXPIRE: '소멸',
  ADMIN_GRANT: '관리자 지급',
  SUBSCRIPTION_GRANT: '구독 크레딧 지급',
  EXCHANGE: '포인트 교환',
  EARN: '적립',
  ADJUST: '조정',
  // 정산·신고·계정
  REQUESTED: '요청됨',
  APPROVED: '승인됨',
  REJECTED: '반려됨',
  SUSPENDED: '정지됨',
  ON_SALE: '판매 중',
  // 캐릭터·세트
  DRAFT: '작성 중',
  CONFIRMED: '확정됨',
  PUBLISHED: '공유·판매 중',
};

// 토스페이먼츠 카드사 코드
const CARD_COMPANIES = {
  11: 'KB국민',
  21: '하나',
  31: 'BC',
  33: '우리BC',
  41: '신한',
  51: '삼성',
  61: '현대',
  71: '롯데',
  91: 'NH농협',
  W1: '우리',
  '3K': '기업BC',
  '3A': '케이뱅크',
  15: '카카오뱅크',
  24: '토스뱅크',
  15: '카카오뱅크',
  '4V': '비자',
  '4M': '마스터',
  '4J': 'JCB',
  '3C': '유니온페이',
  '6D': '다이너스',
  '7A': '아멕스',
};

export const label = (value) => LABELS[value] ?? value ?? '';
export const cardCompany = (code) => CARD_COMPANIES[code] ?? code ?? '';
