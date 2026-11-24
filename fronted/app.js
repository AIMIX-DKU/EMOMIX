import {
  createIcons,
  Bell,
  FolderHeart,
  Clock3,
  ShoppingBag,
  ImagePlus,
} from 'lucide';
const refreshIcons = () =>
  createIcons({
    icons: { Bell, FolderHeart, Clock3, ShoppingBag, ImagePlus },
    attrs: { width: 15, height: 15 },
  });

(() => {
  const root = document.getElementById('emomix-full');
  const main = root.querySelector('main');
  const overlay = root.querySelector('.overlay');
  const modalBody = root.querySelector('.modal-body');
  const notice = root.querySelector('.notice');
  let current = 'studio',
    tab = '',
    selected = 0,
    credits = 120,
    points = 450,
    candidate = false;
  let saved = [{ name: '말랑이의 하루', color: 0 }],
    previousFocus = null;
  let lastDescription = '우주복을 입은 말랑한 물방울 캐릭터';
  const palette = [
    ['#b7ecff', '#3f8be5'],
    ['#ffe1ed', '#ec92b2'],
    ['#e0f7ca', '#7fbd91'],
  ];
  const btn = (text, action, cls = 'secondary') =>
    '<button class="' +
    cls +
    '" data-action="' +
    action +
    '">' +
    text +
    '</button>';
  const link = (text, page, cls = 'secondary') =>
    '<button class="' + cls + '" data-go="' + page + '">' + text + '</button>';
  const field = (name, type = 'text', placeholder = '') =>
    '<label>' +
    name +
    '<input type="' +
    type +
    '" placeholder="' +
    placeholder +
    '" required></label>';
  const area = (name, placeholder = '') =>
    '<label>' +
    name +
    '<textarea rows="3" placeholder="' +
    placeholder +
    '" required></textarea></label>';
  const tabs = (names) =>
    '<div class="tabs">' +
    names
      .map(
        (name, i) =>
          '<button data-tab="' +
          name +
          '" aria-pressed="' +
          (tab ? tab === name : i === 0) +
          '">' +
          name +
          '</button>',
      )
      .join('') +
    '</div>';
  const head = (title, sub = '') =>
    '<div class="space"><h1>' +
    title +
    '</h1>' +
    (sub ? '<p class="lead">' + sub + '</p>' : '') +
    '</div>';
  function say(text) {
    notice.hidden = false;
    notice.textContent = text;
  }
  function close() {
    overlay.hidden = true;
    modalBody.replaceChildren();
    previousFocus?.focus();
  }
  function modal(title, body) {
    previousFocus = document.activeElement;
    root.querySelector('#mix-modal-title').textContent = title;
    modalBody.innerHTML = body;
    overlay.hidden = false;
    drawAll(modalBody);
    root.querySelector('[data-close]').focus();
  }
  function art(color = 0, face = '기쁨') {
    return (
      '<div class="art" data-color="' +
      color +
      '" data-face="' +
      face +
      '"></div>'
    );
  }
  function sticker(color = 0, face = '기쁨') {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', face + ' 표정의 샘플 물방울');
    const x = c.getContext('2d'),
      g = x.createLinearGradient(70, 40, 185, 220),
      colors = palette[color % 3];
    g.addColorStop(0, colors[0]);
    g.addColorStop(1, colors[1]);
    x.fillStyle = g;
    x.beginPath();
    x.moveTo(123, 28);
    x.bezierCurveTo(140, 8, 146, 57, 176, 90);
    x.bezierCurveTo(235, 151, 206, 221, 128, 221);
    x.bezierCurveTo(47, 221, 23, 164, 70, 104);
    x.bezierCurveTo(95, 72, 108, 44, 123, 28);
    x.fill();
    x.fillStyle = '#ffffffa0';
    x.beginPath();
    x.ellipse(92, 102, 8, 20, 0.6, 0, Math.PI * 2);
    x.fill();
    x.strokeStyle = '#193b66';
    x.fillStyle = '#193b66';
    x.lineWidth = 5;
    x.lineCap = 'round';
    for (const eye of [102, 154]) {
      x.beginPath();
      if (face === '슬픔' || face === '졸림') {
        x.moveTo(eye - 8, 138);
        x.quadraticCurveTo(eye, face === '졸림' ? 147 : 130, eye + 8, 138);
        x.stroke();
      } else {
        x.ellipse(eye, 137, 5, 8, 0, 0, Math.PI * 2);
        x.fill();
      }
    }
    x.beginPath();
    if (face === '놀람') {
      x.ellipse(128, 166, 9, 12, 0, 0, Math.PI * 2);
      x.stroke();
    } else {
      x.moveTo(116, 161);
      x.quadraticCurveTo(128, face === '슬픔' ? 149 : 179, 140, 161);
      x.stroke();
    }
    return c;
  }
  function drawAll(scope = main) {
    scope.querySelectorAll('[data-color]').forEach((el) => {
      el.replaceChildren(
        sticker(Number(el.dataset.color), el.dataset.face || '기쁨'),
      );
    });
    refreshIcons();
  }
  function row(title, sub, action = '') {
    return (
      '<div class="list-row"><div><strong>' +
      title +
      '</strong><p class="muted">' +
      sub +
      '</p></div><div class="row">' +
      action +
      '</div></div>'
    );
  }
  function tiles(mode = 'library') {
    const names =
      mode === 'market'
        ? ['말랑이의 하루', '복숭아의 인사', '느긋한 초록 친구']
        : mode === 'community'
          ? ['오늘도 말랑하게', '수줍은 복숭아', '쉬어가는 하루']
          : saved.map((s) => s.name);
    return (
      '<div class="grid">' +
      names
        .map(
          (name, i) =>
            '<article class="tile">' +
            art(i % 3) +
            '<h3 data-safe-name="' +
            i +
            '">' +
            (mode === 'library' ? '내 작품' : name) +
            '</h3><p class="muted">' +
            (mode === 'market'
              ? 'mellow.mix · 12종'
              : mode === 'community'
                ? 'by mellow.mix'
                : '내 캐릭터 · 3개 표정') +
            '</p>' +
            btn(
              mode === 'market' ? '3,000원 · 상세 보기' : '열어보기',
              mode === 'market'
                ? 'product'
                : mode === 'community'
                  ? 'post'
                  : 'set',
            ) +
            '</article>',
        )
        .join('') +
      '</div>'
    );
  }
  function studio() {
    return (
      '<div class="hero"><h1>나만의 이모티콘</h1><p class="lead">머릿속 캐릭터에, 나다운 표정을.</p></div><p class="muted space">현재는 화면 체험 모드입니다. <a href="./generation.html">실제 생성 API 화면 열기</a></p><div class="columns"><form class="panel tinted stack" data-form="generate"><label for="full-description">어떤 캐릭터를 만들까요?</label><textarea id="full-description" maxlength="500" rows="3" placeholder="예시) 우주복을 입은 말랑한 물방울 캐릭터" required></textarea><label>그림체<select><option>말랑한 3D</option><option>깔끔한 일러스트</option><option>손그림</option></select></label><label class="upload"><i data-lucide="image-plus" aria-hidden="true"></i>참고 이미지 추가<input type="file" accept="image/png,image/jpeg,image/webp" hidden></label><p class="muted reference-name"></p><div class="row between"><span class="muted">후보 3장</span><span class="chip">예상 비용 3 크레딧 · 예시</span></div><button class="primary" type="submit">캐릭터 후보 만들기 ↗</button></form><section class="panel stack"><h2>캐릭터 미리보기</h2><div class="preview-result">' +
      (candidate
        ? candidates()
        : '<div class="empty"><span class="logo" aria-hidden="true"></span><p>캐릭터를 설명하고 후보를 만들어 보세요.</p></div>') +
      '</div><details><summary class="muted">화면 상태 확인</summary><div class="row top">' +
      btn('대기 중', 'state-queued') +
      btn('생성 중', 'state-running') +
      btn('실패', 'state-failed') +
      btn('크레딧 부족', 'state-credit') +
      btn('로그인 필요', 'state-auth') +
      '</div></details></section></div>'
    );
  }
  function candidates() {
    return (
      '<p class="muted">기준이 될 캐릭터를 골라 주세요.</p><div class="thumbs top">' +
      [0, 1, 2]
        .map(
          (n) =>
            '<button data-candidate="' +
            n +
            '" aria-pressed="' +
            (selected === n) +
            '">' +
            art(n) +
            '후보 ' +
            (n + 1) +
            '</button>',
        )
        .join('') +
      '</div><div class="row top">' +
      btn('이 캐릭터 확정', 'confirm', 'primary') +
      btn('건너뛰기', 'skip') +
      '</div>'
    );
  }
  function editor() {
    return (
      head('이모티콘 편집', '말랑이의 하루 · 기쁨') +
      '<div class="columns"><div class="panel stack">' +
      art(selected, '기쁨') +
      '<label>라벨<input value="기쁨"></label><div class="row">' +
      btn('라벨 저장', 'saved') +
      btn('삭제', 'delete-item', 'danger') +
      '</div></div><div class="panel">' +
      tabs(['재생성', '부분 수정', '버전 기록', '다운로드']) +
      editBody() +
      '</div></div>'
    );
  }
  function editBody() {
    if (tab === '부분 수정')
      return (
        '<div class="stack"><p class="muted">바꿀 부분을 드래그해서 칠해 주세요.</p><div class="mask-board" data-mask-board>' +
        art(selected) +
        '<canvas class="mask" width="440" height="300" aria-label="드래그해 수정 영역 지정"></canvas></div>' +
        btn('선택 영역 지우기', 'clear-mask') +
        area('수정 내용', '예시) 눈을 하트 모양으로 바꿔줘') +
        btn('선택 영역 다시 만들기', 'edited', 'primary') +
        '</div>'
      );
    if (tab === '버전 기록')
      return (
        '<div class="stack">' +
        [1, 2, 3]
          .map((v) =>
            row(
              '버전 ' + v,
              v === 3 ? '현재 버전' : '이전 생성 결과',
              btn('이 버전 보기', 'version-' + v),
            ),
          )
          .join('') +
        '</div>'
      );
    if (tab === '다운로드')
      return (
        '<div class="stack"><label>파일 형식<select><option>PNG · 투명 배경</option><option>WebP · 투명 배경</option></select></label>' +
        btn('이미지 다운로드', 'download', 'primary') +
        btn('세트 ZIP 다운로드', 'zip') +
        btn('Discord·프로필 등록 안내', 'export-guide') +
        '</div>'
      );
    return (
      '<div class="stack">' +
      area('어떻게 바꿀까요?', '예시) 웃는 표정을 더 크게 표현해 줘') +
      '<p class="muted">생성 전 비용과 남은 크레딧을 확인해 주세요.</p>' +
      btn('재생성 비용 확인', 'regenerate', 'primary') +
      '</div>'
    );
  }
  function library() {
    return (
      head('내 보관함', '내가 만든 캐릭터와 표정을 모아봤어요.') +
      tabs(['이모티콘 세트', '캐릭터', '북마크', '구매한 작품']) +
      (tab === '구매한 작품'
        ? tiles('market')
        : tab === '북마크'
          ? tiles('community')
          : saved.length
            ? tiles()
            : '<div class="empty">아직 저장한 작품이 없어요.<div class="top">' +
              link('첫 캐릭터 만들기', 'studio', 'primary') +
              '</div></div>') +
      '<div class="row top">' +
      link('새로 만들기', 'studio', 'primary') +
      btn('빈 보관함 보기', 'empty-library') +
      '</div>'
    );
  }
  function community() {
    return (
      head(
        '상상을 나누는 곳',
        '작품과 프롬프트에서 새로운 영감을 찾아보세요.',
      ) +
      '<div class="row">' +
      btn('내 세트 공유하기', 'publish', 'primary') +
      btn('신고 내역', 'reports') +
      '</div>' +
      tabs(['최신 작품', '인기 작품', '프롬프트 랭킹', '제작자 랭킹']) +
      '<form class="row space" data-form="search"><label style="flex:1">작품 검색<input name="query" placeholder="작품·태그 검색" required></label><button class="secondary">검색</button></form>' +
      (tab === '제작자 랭킹'
        ? '<div class="panel">' +
          row(
            '1 · mellow.mix',
            '말랑한 일상을 그려요',
            btn('프로필', 'creator-profile'),
          ) +
          row(
            '2 · peachday',
            '작은 표정 수집가',
            btn('프로필', 'creator-profile'),
          ) +
          '</div>'
        : tab === '프롬프트 랭킹'
          ? '<div class="panel">' +
            row(
              '말랑한 물방울 캐릭터',
              '이번 주 인기 프롬프트',
              btn('이 설정으로 만들기', 'use-prompt'),
            ) +
            '</div>'
          : tiles('community'))
    );
  }
  function market() {
    return (
      head('마켓', '마음에 드는 작품을 만나보세요.') +
      '<form class="row" data-form="search"><label style="flex:1">상품 검색<input name="query" placeholder="이모티콘·템플릿 검색" required></label><button class="secondary">검색</button></form>' +
      tabs(['전체', '이모티콘', '템플릿']) +
      tiles('market')
    );
  }
  function wallet() {
    return (
      head('내 지갑', '생성 크레딧과 활동 포인트를 확인하세요.') +
      '<div class="columns"><div class="panel"><h2>생성 크레딧</h2><p class="balance">' +
      credits +
      ' 크레딧</p>' +
      btn('크레딧 충전', 'charge', 'primary') +
      '</div><div class="panel"><h2>활동 포인트</h2><p class="balance">' +
      points +
      ' 포인트</p>' +
      btn('크레딧으로 교환', 'exchange') +
      '</div></div>' +
      tabs(['크레딧 내역', '포인트 내역', '보상 규칙']) +
      '<div class="panel">' +
      (tab === '보상 규칙'
        ? row(
            '작품 공유·활동 보상',
            '실제 보상 조건과 한도는 서버 정책 기준으로 표시합니다.',
          )
        : tab === '포인트 내역'
          ? row('커뮤니티 활동 보상', '11.24 · 적립', '+ 50 포인트')
          : row('캐릭터 후보 생성', '11.24 · 사용', '− 3 크레딧') +
            row('크레딧 충전', '11.23 · 충전', '+ 100 크레딧')) +
      '</div>'
    );
  }
  function orders() {
    return (
      head('구매·후원') +
      tabs(['주문 내역', '구매한 작품', '보낸 후원', '받은 후원']) +
      '<div class="panel">' +
      (tab === '보낸 후원' || tab === '받은 후원'
        ? row(
            'mellow.mix',
            '11.23 · 후원 완료 · 1,000원',
            btn('상세', 'donation-detail'),
          )
        : row(
            '말랑이의 하루',
            '11.23 · 결제 완료 · 3,000원',
            btn('상세 보기', 'order-detail'),
          )) +
      '</div>'
    );
  }
  function jobs() {
    return (
      head('생성 내역', '창을 닫아도 작업 내역에서 결과를 확인할 수 있어요.') +
      '<div class="panel">' +
      row('말랑이 감정 세트', '완료 · 3개 표정', btn('결과 보기', 'set')) +
      row(
        '캐릭터 후보 생성',
        '대기 중 · 앞에 2개 작업',
        btn('취소', 'cancel-job'),
      ) +
      row('부분 수정', '실패 · 크레딧 반환', btn('다시 만들기', 'retry-job')) +
      '</div>'
    );
  }
  function profile() {
    return (
      head('내 정보·설정') +
      '<div class="panel space"><div class="row between"><div><p class="muted">보유 크레딧</p><p class="balance">' +
      credits +
      ' 크레딧</p><p class="muted">활동 포인트 ' +
      points +
      ' 포인트</p></div><div class="row">' +
      btn('충전하기', 'charge', 'primary') +
      link('지갑·이용 내역', 'wallet') +
      '</div></div></div>' +
      tabs(['프로필', '계정·보안', '알림 설정', '약관·탈퇴']) +
      '<div class="panel stack">' +
      (tab === '계정·보안'
        ? '<h2>계정·보안</h2>' +
          btn('비밀번호 변경', 'password') +
          row('Discord 연동', '연결됨', btn('연동 해제', 'unlink')) +
          btn('로그아웃', 'logout')
        : tab === '알림 설정'
          ? '<form class="stack" data-form="save"><label><input type="checkbox" checked>생성 완료 알림</label><label><input type="checkbox" checked>댓글·팔로우 알림</label><label><input type="checkbox">마케팅 알림</label><button class="primary">설정 저장</button></form>'
          : tab === '약관·탈퇴'
            ? btn('이용약관', 'terms') +
              btn('선택 약관 동의 변경', 'agreements') +
              btn('회원 탈퇴', 'withdraw', 'danger')
            : '<form class="stack" data-form="save"><div class="row"><span class="avatar" aria-label="프로필 이미지">나</span><label>프로필 이미지<input type="file" accept="image/*"></label></div><label>닉네임<input value="seoyeon" required></label>' +
              area('소개', '나를 소개해 주세요') +
              '<button class="primary">프로필 저장</button></form>') +
      '</div>'
    );
  }
  function notifications() {
    return (
      head('알림') +
      '<div class="row space">' +
      btn('모두 읽음', 'read-all') +
      '</div><div class="panel notification-list">' +
      row(
        '이모티콘이 완성됐어요',
        '말랑이의 하루 · 방금 전',
        btn('결과 보기', 'set') +
          btn('읽음', 'read') +
          btn('삭제', 'remove-row'),
      ) +
      row(
        '새 댓글이 달렸어요',
        '말랑한 일상 · 10분 전',
        btn('게시물 보기', 'post') + btn('읽음', 'read'),
      ) +
      '</div>'
    );
  }
  function auth() {
    return (
      '<section class="panel auth-panel">' +
      head(
        tab === '회원가입'
          ? 'EmoMix 시작하기'
          : tab === '비밀번호 찾기'
            ? '비밀번호 찾기'
            : '다시 만나 반가워요',
      ) +
      '<p class="muted space">화면 체험용이에요. 실제 계정 정보는 입력하지 마세요.</p>' +
      tabs(['로그인', '회원가입', '비밀번호 찾기']) +
      '<form class="stack" data-form="auth">' +
      field('이메일', 'email', 'name@example.com') +
      (tab === '회원가입'
        ? '<div class="row">' +
          btn('인증번호 받기', 'send-code') +
          '</div>' +
          field('인증번호', 'text', '123456') +
          btn('인증번호 확인', 'verify-code') +
          field('닉네임')
        : '') +
      (tab === '비밀번호 찾기'
        ? ''
        : field('비밀번호', 'password', '8자 이상')) +
      (tab === '회원가입'
        ? '<label><input type="checkbox" required>필수 이용약관에 동의합니다.</label>' +
          btn('약관 보기', 'terms')
        : '') +
      '<button class="primary">' +
      (tab === '회원가입'
        ? '가입 완료'
        : tab === '비밀번호 찾기'
          ? '재설정 안내 받기'
          : '로그인') +
      '</button></form>' +
      (tab ? '' : btn('Discord로 계속하기', 'discord')) +
      '</section>'
    );
  }
  function creator() {
    return (
      head('창작자 센터', '작품을 소개하고 판매와 정산을 관리하세요.') +
      tabs([
        '판매 상품',
        '판매·후원 내역',
        '판매 장부',
        '정산',
        '창작자 정보',
      ]) +
      '<div class="panel">' +
      (tab === '정산'
        ? '<h2>정산 가능 금액</h2><p class="balance">24,000원</p>' +
          btn('정산 요청', 'settlement', 'primary') +
          row('이전 정산', '11.01 · 처리 완료 · 18,000원')
        : tab === '창작자 정보'
          ? '<form class="stack" data-form="save">' +
            field('창작자명', 'text', 'mellow.mix') +
            area('소개') +
            '<button class="primary">정보 저장</button></form>' +
            btn('창작자 등록', 'creator-register')
          : tab === '판매 장부'
            ? row('상품 판매 수익', '예시 · 수수료 적용 후', '+ 2,400원') +
              row('후원 수익', '예시 · 판매 수익과 구분', '+ 1,000원')
            : tab === '판매·후원 내역'
              ? row('말랑이의 하루', '11.23 · 판매 완료', '3,000원') +
                row('창작자 후원', '11.23 · 수령', '1,000원')
              : btn('상품 등록', 'product-create', 'primary') +
                row(
                  '말랑이의 하루',
                  '판매 중 · 3,000원',
                  btn('수정', 'product-edit') +
                    btn('판매 중단', 'stop-sale', 'danger'),
                )) +
      '</div>'
    );
  }
  function admin() {
    return (
      head('관리자', '운영 권한이 있는 계정의 화면입니다.') +
      tabs([
        '신고',
        '사용자',
        '콘텐츠',
        '크레딧',
        '생성 통계',
        '운영 정책',
        '정산',
      ]) +
      '<div class="panel">' +
      (tab === '사용자'
        ? row(
            'mellow.mix',
            '일반 회원 · 정상',
            btn('정지', 'suspend') + btn('정지 해제', 'unsuspend'),
          )
        : tab === '콘텐츠'
          ? row('말랑한 일상', '공개 게시물', btn('숨김 처리', 'hide-content'))
          : tab === '크레딧'
            ? '<form class="stack" data-form="grant">' +
              field('대상 사용자 ID') +
              field('지급 크레딧', 'number') +
              area('지급 사유') +
              '<button class="primary">지급 검토</button></form>'
            : tab === '생성 통계'
              ? row('완료 / 실패 / 대기', '표시용 예시', '24 / 2 / 3')
              : tab === '운영 정책'
                ? '<form class="stack" data-form="save"><p class="muted">실제 운영값은 서버에서 불러옵니다.</p>' +
                  field('정책 키', 'text', 'candidateCreditCost') +
                  field('설정값', 'number', '1') +
                  '<button class="primary">변경 검토</button></form>'
                : tab === '정산'
                  ? row(
                      'mellow.mix',
                      '정산 요청 · 24,000원',
                      btn('처리', 'admin-settlement'),
                    )
                  : row(
                      '부적절한 게시물 신고',
                      '접수 · 검토 대기',
                      btn('상세·처리', 'admin-report'),
                    )) +
      '</div>'
    );
  }
  const screens = {
    studio,
    library,
    community,
    market,
    wallet,
    orders,
    jobs,
    profile,
    notifications,
    auth,
    creator,
    admin,
    editor,
  };
  function show(page, keepTab = false) {
    if (!screens[page]) return;
    if (!keepTab) tab = '';
    current = page;
    notice.hidden = true;
    main.innerHTML = screens[page]();
    if (page === 'library' && tab !== '구매한 작품' && tab !== '북마크')
      main.querySelectorAll('[data-safe-name]').forEach((el, i) => {
        el.textContent = saved[i]?.name || '내 작품';
      });
    root
      .querySelectorAll('[data-go]')
      .forEach((b) =>
        b.setAttribute(
          'aria-current',
          b.dataset.go === page ? 'page' : 'false',
        ),
      );
    drawAll();
    setupMask();
  }
  function setupMask() {
    const canvas = main.querySelector('canvas.mask');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let painting = false;
    function paint(event) {
      if (!painting) return;
      const r = canvas.getBoundingClientRect();
      ctx.fillStyle = '#235dde70';
      ctx.beginPath();
      ctx.arc(
        ((event.clientX - r.left) * canvas.width) / r.width,
        ((event.clientY - r.top) * canvas.height) / r.height,
        17,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    canvas.addEventListener('pointerdown', (e) => {
      painting = true;
      canvas.setPointerCapture(e.pointerId);
      paint(e);
    });
    canvas.addEventListener('pointermove', paint);
    canvas.addEventListener('pointerup', () => {
      painting = false;
    });
    canvas.addEventListener('pointercancel', () => {
      painting = false;
    });
  }
  function setDetail() {
    modal(
      '말랑이의 하루',
      '<div class="grid">' +
        ['기쁨', '슬픔', '놀람'].map((face) => art(selected, face)).join('') +
        '</div><div class="row top">' +
        link('편집하기', 'editor', 'primary') +
        btn('세트 이름 수정', 'rename-set') +
        btn('세트 다운로드', 'zip') +
        btn('공유하기', 'publish') +
        btn('세트 삭제', 'delete-set', 'danger') +
        '</div>',
    );
  }
  const actions = {
    confirm: () =>
      modal(
        '표정 골라 세트 만들기',
        '<form class="stack" data-form="set"><p class="muted">확정한 캐릭터로 선택한 표정을 만들어요.</p><div class="choices">' +
          ['기쁨', '슬픔', '놀람', '졸림', '사랑', '화남']
            .map(
              (face, i) =>
                '<label><input type="checkbox" name="emotion" value="' +
                face +
                '" ' +
                (i < 3 ? 'checked' : '') +
                '>' +
                face +
                '</label>',
            )
            .join('') +
          '</div><p class="muted">비용은 선택한 표정 수에 따라 생성 전 확인합니다.</p><button class="primary">비용 확인 후 생성</button></form>',
      ),
    skip: () => {
      candidate = false;
      show('studio');
    },
    set: setDetail,
    'state-queued': () =>
      state(
        '대기 중',
        '앞에 2개의 생성 작업이 있어요.',
        btn('생성 취소', 'cancel-job'),
      ),
    'state-running': () =>
      state(
        '이모티콘 생성 중',
        '55% · 작업이 끝나면 알림으로 알려드려요.',
        '<div class="bar"><span></span></div>',
      ),
    'state-failed': () =>
      state(
        '생성하지 못했어요',
        '예약된 크레딧을 돌려드렸어요.',
        btn('다시 시도', 'retry-job'),
      ),
    'state-credit': () =>
      state(
        '크레딧이 부족해요',
        '필요한 크레딧과 잔액을 확인해 주세요.',
        link('지갑으로 이동', 'wallet', 'primary'),
      ),
    'state-auth': () =>
      state(
        '로그인이 필요해요',
        '작업을 저장하려면 로그인해 주세요.',
        link('로그인', 'auth', 'primary'),
      ),
    'cancel-job': () => {
      close();
      say('대기 작업을 취소한 상태예요. 크레딧 반환 안내가 함께 표시됩니다.');
    },
    'retry-job': () => {
      candidate = false;
      close();
      show('studio');
      say('설명을 수정하고 다시 생성할 수 있어요.');
    },
    saved: () => say('변경 내용을 저장한 상태예요.'),
    'clear-mask': () => {
      const c = main.querySelector('canvas.mask');
      c?.getContext('2d').clearRect(0, 0, c.width, c.height);
    },
    edited: () =>
      modal(
        '부분 수정 완료',
        art(selected, '놀람') + btn('이 버전 사용', 'apply-version', 'primary'),
      ),
    regenerate: () =>
      modal(
        '재생성 확인',
        '<p>예상 비용 <b>1 크레딧</b> · 보유 <b>' +
          credits +
          ' 크레딧</b></p><p class="muted">화면 확인용 예시 금액입니다.</p><div class="top">' +
          btn('생성하기', 'edited', 'primary') +
          '</div>',
      ),
    'apply-version': () => {
      close();
      say('선택한 버전을 현재 이미지로 지정했어요.');
    },
    download: () => {
      const a = document.createElement('a');
      a.href = sticker(selected).toDataURL('image/png');
      a.download = 'emomix-preview.png';
      a.click();
      say('샘플 PNG 다운로드를 요청했어요.');
    },
    zip: () =>
      modal(
        '세트 다운로드',
        '<div class="stack"><label>출력 형식<select><option>PNG · 투명 배경</option><option>WebP · 투명 배경</option></select></label><p class="muted">실제 연동 시 선택한 규격으로 ZIP을 내려받아요.</p>' +
          btn('다운로드 요청 화면', 'zip-done', 'primary') +
          '</div>',
      ),
    'zip-done': () => {
      close();
      say('세트 ZIP 다운로드 요청 후 화면 예시예요.');
    },
    'export-guide': () =>
      modal(
        '외부 플랫폼에 등록하기',
        '<div class="stack"><h3>Discord</h3><p>서버 설정에서 이모지를 업로드하세요. 등록 권한과 현재 파일 제한을 확인해 주세요.</p><h3>프로필 이미지</h3><p>파일을 저장한 뒤 사용할 서비스에서 프로필 이미지로 선택하세요.</p></div>',
      ),
    'empty-library': () => {
      saved = [];
      show('library');
    },
    'rename-set': () =>
      modal(
        '세트 이름 수정',
        '<form class="stack" data-form="rename">' +
          field('새 이름', 'text', '말랑이의 하루') +
          '<button class="primary">이름 저장</button></form>',
      ),
    'delete-set': () =>
      modal(
        '세트를 삭제할까요?',
        '<p>삭제할 작품을 확인해 주세요.</p><div class="top">' +
          btn('세트 삭제', 'delete-confirm', 'danger') +
          '</div>',
      ),
    'delete-confirm': () => {
      saved = [];
      close();
      show('library');
      say('세트를 삭제한 상태예요.');
    },
    'delete-item': () =>
      modal(
        '이모티콘 삭제',
        '<p>선택한 이모티콘을 삭제할까요?</p>' +
          btn('삭제 확인', 'delete-confirm', 'danger'),
      ),
    publish: () =>
      modal(
        '작품 공유',
        '<form class="stack" data-form="publish">' +
          field('제목', 'text', '말랑이의 하루') +
          area('작품 소개') +
          field('태그', 'text', '물방울, 일상') +
          '<label><input type="checkbox">프롬프트 공개</label><button class="primary">공유하기</button></form>',
      ),
    post: () =>
      modal(
        '오늘도 말랑하게',
        art(0) +
          '<div class="row top">' +
          btn('mellow.mix', 'creator-profile') +
          btn('좋아요', 'like') +
          btn('북마크', 'bookmark') +
          btn('수정', 'publish') +
          btn('삭제', 'delete-post') +
          btn('신고', 'report') +
          '</div><div class="rule"></div><p class="muted">peachday · 표정이 정말 귀여워요!</p><div class="row">' +
          btn('댓글 수정', 'edit-comment') +
          btn('댓글 삭제', 'remove-comment') +
          '</div><form class="stack top" data-form="comment">' +
          field('댓글', 'text', '작품에 대한 이야기를 남겨 주세요') +
          '<button class="primary">댓글 남기기</button></form>',
      ),
    like: () => say('좋아요를 반영한 상태예요.'),
    bookmark: () => say('북마크에 저장한 상태예요.'),
    'delete-post': () =>
      modal(
        '게시물 삭제',
        '<p>공유한 게시물을 삭제할까요?</p>' +
          btn('삭제 확인', 'post-deleted', 'danger'),
      ),
    'post-deleted': () => {
      close();
      say('게시물을 삭제한 상태예요.');
    },
    'edit-comment': () =>
      modal(
        '댓글 수정',
        '<form class="stack" data-form="save">' +
          area('댓글 내용') +
          '<button class="primary">수정 저장</button></form>',
      ),
    'remove-comment': () => say('댓글을 삭제한 상태예요.'),
    report: () =>
      modal(
        '신고하기',
        '<form class="stack" data-form="report"><label>신고 사유<select><option>부적절한 콘텐츠</option><option>저작권 침해</option><option>스팸</option></select></label>' +
          area('상세 내용') +
          '<button class="primary">신고 접수</button></form>',
      ),
    reports: () => modal('내 신고 내역', row('게시물 신고', '접수 · 검토 중')),
    'creator-profile': () =>
      modal(
        'mellow.mix',
        art(0) +
          '<p class="top">말랑한 일상을 그려요.</p><div class="row top">' +
          btn('팔로우', 'follow') +
          btn('후원하기', 'donate') +
          '</div>',
      ),
    follow: () => say('팔로우 상태를 반영했어요.'),
    'use-prompt': () => {
      show('studio');
      main.querySelector('textarea').value = '말랑한 물방울 캐릭터';
    },
    product: () =>
      modal(
        '말랑이의 하루',
        art(0) +
          '<p class="top">12종의 일상 표정 · PNG · 3,000원</p><div class="row top">' +
          btn('구매하기', 'checkout', 'primary') +
          btn('후기 보기', 'reviews') +
          btn('템플릿 보기', 'template') +
          '</div>',
      ),
    template: () =>
      modal(
        '템플릿',
        '<p>구매 후 캐릭터 설정과 제작 프롬프트를 확인할 수 있어요.</p>' +
          btn('상품 보기', 'product'),
      ),
    checkout: () =>
      modal(
        '주문 확인',
        '<div class="stack"><p>말랑이의 하루 · 3,000원</p><label><input type="checkbox" class="pay-consent">구매 조건을 확인했습니다.</label><p class="muted">결제 화면 시안입니다. 실제 결제는 발생하지 않아요.</p>' +
          btn('결제 성공 화면', 'payment-success', 'primary') +
          btn('결제 실패 화면', 'payment-failed') +
          '</div>',
      ),
    'payment-success': () =>
      modal(
        '결제가 완료됐어요',
        '<p>주문번호 EMO-PREVIEW-001</p><div class="row top">' +
          link('구매 내역', 'orders', 'primary') +
          btn('구매 파일 받기', 'download') +
          '</div>',
      ),
    'payment-failed': () =>
      modal(
        '결제를 완료하지 못했어요',
        '<p>결제 수단을 확인하고 다시 시도해 주세요.</p>' +
          btn('다시 결제', 'checkout', 'primary'),
      ),
    reviews: () =>
      modal(
        '구매 후기',
        row('귀여운 표정이 많아요', 'peachday · 구매자') +
          '<form class="stack top" data-form="save"><label>별점<select><option>5점</option><option>4점</option><option>3점</option></select></label>' +
          area('후기') +
          '<button class="primary">후기 등록</button></form>',
      ),
    'order-detail': () =>
      modal(
        '주문 상세',
        row(
          '말랑이의 하루',
          '주문번호 EMO-PREVIEW-001 · 결제 완료',
          '3,000원',
        ) +
          '<div class="row top">' +
          btn('구매 파일 다운로드', 'download') +
          btn('취소·환불 요청', 'refund') +
          '</div>',
      ),
    refund: () =>
      modal(
        '취소·환불 요청',
        '<form class="stack" data-form="refund">' +
          area('요청 사유') +
          '<p class="muted">서버의 환불 가능 여부와 환불 금액을 확인한 뒤 접수합니다.</p><button class="primary">환불 요청</button></form>',
      ),
    charge: () =>
      modal(
        '크레딧 충전',
        '<div class="stack"><p class="muted">패키지와 금액은 화면 예시입니다.</p>' +
          btn('100 크레딧 · 1,000원', 'charge-confirm', 'primary') +
          '</div>',
      ),
    'charge-confirm': () => {
      credits += 100;
      close();
      show('wallet');
      say('샘플 크레딧을 충전한 상태예요. 실제 결제는 발생하지 않았어요.');
    },
    exchange: () =>
      modal(
        '포인트 교환',
        '<p>교환 비율과 한도는 서버 정책에서 표시해요.</p><form class="stack top" data-form="exchange">' +
          field('교환할 포인트', 'number', '100') +
          '<button class="primary">교환 조건 확인</button></form>',
      ),
    donate: () =>
      modal(
        'mellow.mix 후원',
        '<form class="stack" data-form="donation">' +
          field('후원 금액', 'number', '1000') +
          area('응원 메시지') +
          '<button class="primary">후원 주문 확인</button></form>',
      ),
    'donation-detail': () =>
      modal('후원 상세', row('mellow.mix', '후원 완료 · 11.23', '1,000원')),
    read: () => say('읽음으로 표시했어요.'),
    'read-all': () => say('모든 알림을 읽음으로 표시했어요.'),
    password: () =>
      modal(
        '비밀번호 변경',
        '<form class="stack" data-form="save">' +
          field('현재 비밀번호', 'password') +
          field('새 비밀번호', 'password') +
          field('새 비밀번호 확인', 'password') +
          '<button class="primary">비밀번호 변경</button></form>',
      ),
    unlink: () =>
      modal(
        '로그인 수단 연동 해제',
        '<p>다른 로그인 수단이 있는지 확인한 후 해제합니다.</p>' +
          btn('해제 확인', 'unlinked'),
      ),
    unlinked: () => {
      close();
      say('연동 해제 후 화면입니다.');
    },
    logout: () => {
      show('auth');
      say('로그아웃한 상태예요.');
    },
    terms: () =>
      modal(
        '이용약관',
        '<div class="terms"><h3>이용약관 상세 영역</h3><p>실제 약관 API에서 제목, 버전, 시행일과 본문을 불러와 표시합니다.</p><p>필수 동의와 선택 동의를 구분하여 가입 전에 확인할 수 있습니다.</p></div>',
      ),
    agreements: () =>
      modal(
        '약관 동의 변경',
        '<form class="stack" data-form="save"><label><input type="checkbox">마케팅 정보 수신 동의</label><button class="primary">동의 변경 저장</button></form>',
      ),
    withdraw: () =>
      modal(
        '탈퇴하기 전에 확인해 주세요',
        '<p>서버에서 탈퇴 가능 조건과 남은 거래를 확인합니다.</p><form class="stack top" data-form="withdraw"><label><input type="checkbox" required>탈퇴 안내를 확인했습니다.</label><button class="danger">탈퇴 확인</button></form>',
      ),
    'send-code': () =>
      say('인증번호를 발송한 화면입니다. 실제 메일은 발송되지 않아요.'),
    'verify-code': () => say('이메일 인증 완료 화면입니다.'),
    discord: () =>
      modal(
        'Discord 로그인',
        '<p>실제 서비스에서는 Discord 인증 후 앱으로 돌아옵니다.</p>' +
          btn('추가 가입 정보 입력', 'discord-signup', 'primary'),
      ),
    'discord-signup': () => {
      close();
      tab = '회원가입';
      show('auth', true);
    },
    'creator-register': () =>
      modal(
        '창작자 등록',
        '<form class="stack" data-form="save">' +
          field('창작자명') +
          area('소개') +
          '<label><input type="checkbox" required>창작자 약관 동의</label><button class="primary">등록</button></form>',
      ),
    'product-create': () => productForm('상품 등록'),
    'product-edit': () => productForm('상품 수정'),
    'stop-sale': () =>
      modal(
        '판매 중단',
        '<p>이 상품의 신규 판매를 중단할까요?</p>' +
          btn('중단 확인', 'sale-stopped', 'danger'),
      ),
    'sale-stopped': () => {
      close();
      say('판매 중단 상태예요.');
    },
    settlement: () =>
      modal(
        '정산 요청',
        '<p>정산 가능 금액 24,000원 · 예시</p><form class="stack top" data-form="save">' +
          field('은행') +
          field('계좌번호') +
          field('예금주') +
          '<button class="primary">요청 검토</button></form>',
      ),
    'admin-report': () =>
      modal(
        '신고 검토',
        '<form class="stack" data-form="save"><p>사유 · 부적절한 콘텐츠</p>' +
          btn('콘텐츠 확인', 'post') +
          '<label>처리 결과<select><option>콘텐츠 숨김</option><option>기각</option></select></label>' +
          area('처리 사유') +
          '<button class="primary">처리 검토</button></form>',
      ),
    suspend: () =>
      modal(
        '사용자 정지',
        '<form class="stack" data-form="save">' +
          field('정지 기간(일)', 'number') +
          area('사유') +
          '<button class="primary">정지 검토</button></form>',
      ),
    unsuspend: () => say('정지를 해제한 상태예요.'),
    'hide-content': () => say('콘텐츠를 숨긴 상태예요.'),
    'admin-settlement': () =>
      modal(
        '정산 처리',
        '<form class="stack" data-form="save"><label>처리 상태<select><option>승인</option><option>반려</option><option>지급 완료</option></select></label>' +
          area('처리 메모') +
          '<button class="primary">처리 검토</button></form>',
      ),
  };
  function productForm(title) {
    modal(
      title,
      '<form class="stack" data-form="save">' +
        field('상품명') +
        '<label>판매할 작품<select><option>말랑이의 하루</option></select></label>' +
        field('가격', 'number') +
        area('상품 소개') +
        '<button class="primary">저장</button></form>',
    );
  }
  function state(title, message, body) {
    modal(
      title,
      '<div class="state-box ' +
        (title.includes('못') ? 'error' : '') +
        '"><p>' +
        message +
        '</p>' +
        body +
        '</div>',
    );
  }
  root.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-close')) {
      close();
      return;
    }
    if (button.dataset.authTab) {
      close();
      tab = button.dataset.authTab;
      show('auth', true);
      return;
    }
    if (button.dataset.go) {
      close();
      show(button.dataset.go);
      return;
    }
    if (button.dataset.tab) {
      tab = button.dataset.tab;
      show(current, true);
      return;
    }
    if (button.dataset.candidate) {
      selected = Number(button.dataset.candidate);
      main
        .querySelectorAll('[data-candidate]')
        .forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      return;
    }
    const action = button.dataset.action;
    if (!action) return;
    if (action === 'remove-row') {
      button.closest('.list-row')?.remove();
      return;
    }
    if (action.startsWith('version-')) {
      modal(
        '버전 ' + action.slice(-1),
        art(Number(action.slice(-1)) - 1) +
          btn('이 버전 사용', 'apply-version', 'primary'),
      );
      return;
    }
    actions[action]?.();
  });
  root.addEventListener('change', (event) => {
    if (event.target.type === 'file') {
      const name = main.querySelector('.reference-name');
      if (name) name.textContent = event.target.files[0]?.name || '';
    }
  });
  root.addEventListener('submit', (event) => {
    const form = event.target;
    if (!form.dataset.form) return;
    event.preventDefault();
    const kind = form.dataset.form;
    if (kind === 'generate') {
      const t = form.querySelector('textarea');
      if (!t.value.trim()) {
        t.setCustomValidity('설명을 입력해 주세요.');
        t.reportValidity();
        return;
      }
      lastDescription = t.value.trim();
      candidate = true;
      show('studio');
      return;
    }
    if (kind === 'set') {
      const checked = [...form.querySelectorAll('input:checked')];
      if (!checked.length) {
        say('표정을 하나 이상 골라 주세요.');
        return;
      }
      modal(
        '생성 비용 확인',
        '<p>표정 ' +
          checked.length +
          '개 · 예상 ' +
          checked.length +
          ' 크레딧 · 예시</p><div class="row top">' +
          btn('세트 생성', 'create-set', 'primary') +
          '</div>',
      );
      actions['create-set'] = () => {
        saved.unshift({ name: lastDescription, color: selected });
        close();
        show('library');
        say('완성 세트를 보관함에 저장한 화면입니다.');
      };
      return;
    }
    if (kind === 'search') {
      const value = form.querySelector('input').value.trim();
      say('“' + value + '” 검색 결과 예시예요.');
      return;
    }
    if (kind === 'auth') {
      close();
      show('studio');
      say('인증 완료 후 화면 예시예요.');
      return;
    }
    if (kind === 'comment') {
      const input = form.querySelector('input');
      const p = document.createElement('p');
      p.textContent = '나 · ' + input.value;
      p.className = 'muted';
      form.before(p);
      form.reset();
      return;
    }
    if (kind === 'rename') {
      const name = form.querySelector('input').value.trim();
      if (saved[0]) saved[0].name = name;
      close();
      show('library');
      return;
    }
    if (kind === 'exchange') {
      modal(
        '교환 확인',
        '<p>교환 가능한 포인트와 지급 크레딧을 서버 응답으로 확인한 뒤 진행합니다.</p>' +
          btn('확인', 'exchange-done', 'primary'),
      );
      actions['exchange-done'] = () => {
        close();
        say('교환 완료 화면 예시예요.');
      };
      return;
    }
    if (kind === 'donation') {
      actions.checkout();
      return;
    }
    if (kind === 'withdraw') {
      close();
      show('auth');
      say('탈퇴 완료 화면 예시예요.');
      return;
    }
    const message =
      {
        report: '신고 접수 완료 화면입니다.',
        refund: '환불 요청 접수 후 화면입니다.',
        publish: '게시물 공유 완료 화면입니다.',
        grant: '지급 내역 확인 후 화면입니다.',
      }[kind] || '저장 완료 화면입니다.';
    close();
    say(message);
  });
  root.addEventListener('input', (event) =>
    event.target.setCustomValidity?.(''),
  );
  root.addEventListener('keydown', (event) => {
    if (overlay.hidden) return;
    if (event.key === 'Escape') {
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = [
      ...overlay.querySelectorAll('button,input,select,textarea,a[href]'),
    ].filter((el) => !el.disabled && el.getClientRects().length);
    const first = focusables[0],
      last = focusables.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
  show('studio');
})();
