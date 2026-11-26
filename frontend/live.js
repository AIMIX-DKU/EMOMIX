import { api, initializeCsrf, uploadImage } from './api.js';

const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char],
  );
const button = (label, action, primary = false) =>
  '<button type="button" class="' +
  (primary ? 'primary' : 'secondary') +
  '" data-live="' +
  action +
  '">' +
  label +
  '</button>';
const input = (label, name, type = 'text', value = '') =>
  '<label>' +
  label +
  '<input name="' +
  name +
  '" type="' +
  type +
  '" value="' +
  escape(value) +
  '" required></label>';
const image = (url, alt) =>
  url
    ? '<img class="live-image" src="' +
      escape(url) +
      '" alt="' +
      escape(alt) +
      '">'
    : '<p class="muted">이미지 준비 중</p>';

export function createLiveApp({ root, navigate, notify }) {
  let page = '',
    tab = '',
    revision = 0,
    user = null,
    wallet = null;
  let styles = [],
    terms = [],
    verification = null;
  let description = '',
    styleKey = '',
    character = null,
    candidates = [],
    chosen = 0;
  let busy = false,
    job = null,
    jobMessage = '',
    request = null,
    timer;
  const main = root.querySelector('main');
  const panel = (title, content) =>
    '<div class="space"><h1>' +
    title +
    '</h1></div><section class="panel stack">' +
    content +
    '</section>';
  const loginHint = () =>
    panel(
      '로그인이 필요해요',
      '<p>로그인하면 내 정보와 작품을 불러올 수 있어요.</p>' +
        button('로그인', 'login', true),
    );
  const errorBox = (error) =>
    '<p role="alert" class="live-error">' +
    escape(error.message) +
    '</p>' +
    button('다시 불러오기', 'reload');
  const authTabs = () =>
    '<div class="tabs">' +
    ['로그인', '회원가입', '비밀번호 찾기']
      .map(
        (name) =>
          '<button data-live-tab="' +
          name +
          '" aria-pressed="' +
          ((tab || '로그인') === name) +
          '">' +
          name +
          '</button>',
      )
      .join('') +
    '</div>';

  function authView() {
    const signup = tab === '회원가입',
      reset = tab === '비밀번호 찾기';
    return (
      '<section class="panel auth-panel"><h1>' +
      (signup
        ? 'EmoMix 시작하기'
        : reset
          ? '비밀번호 찾기'
          : '다시 만나 반가워요') +
      '</h1>' +
      authTabs() +
      '<form class="stack" data-live-form="auth">' +
      input('이메일', 'email', 'email') +
      (signup || reset
        ? button('인증번호 받기', 'send-code') +
          input('인증번호', 'code') +
          button('인증번호 확인', 'verify-code')
        : '') +
      input(reset ? '새 비밀번호' : '비밀번호', 'password', 'password') +
      (signup
        ? input('닉네임', 'nickname') +
          '<div class="live-terms stack">' +
          (terms.length
            ? terms
                .map(
                  (term) =>
                    '<label><input type="checkbox" name="term" value="' +
                    escape(term.id) +
                    '" ' +
                    (term.required ? 'required' : '') +
                    '>' +
                    escape(term.title) +
                    (term.required ? ' (필수)' : ' (선택)') +
                    '</label>' +
                    button('약관 상세', 'term-' + term.id),
                )
                .join('')
            : '<p class="muted">약관을 불러오는 중이에요.</p>') +
          '</div>'
        : '') +
      '<button class="primary" type="submit">' +
      (signup ? '가입 완료' : reset ? '비밀번호 재설정' : '로그인') +
      '</button></form></section>'
    );
  }

  function studioView() {
    const options = styles
      .map(
        (style) =>
          '<option value="' +
          escape(style.key) +
          '" ' +
          (styleKey === style.key ? 'selected' : '') +
          '>' +
          escape(style.label) +
          '</option>',
      )
      .join('');
    return (
      '<div class="hero"><h1>나만의 이모티콘</h1><p class="lead">머릿속 캐릭터에, 나다운 표정을.</p></div>' +
      '<div class="columns"><form class="panel tinted stack" data-live-form="generate"><label>어떤 캐릭터를 만들까요?<textarea name="description" rows="3" maxlength="500" required placeholder="예시) 우주복을 입은 말랑한 물방울 캐릭터">' +
      escape(description) +
      '</textarea></label>' +
      '<label>그림체<select name="style" required>' +
      options +
      '</select></label><label class="upload">참고 이미지 추가<input name="reference" type="file" accept="image/png,image/jpeg,image/webp"></label>' +
      '<p class="muted">후보 3장 · 생성 전 서버에서 비용을 확인해요.</p><button class="primary" type="submit" ' +
      (busy || !styles.length ? 'disabled' : '') +
      '>후보 생성 비용 확인</button></form>' +
      '<section class="panel stack"><h2>캐릭터 미리보기</h2><p class="live-job" role="status">' +
      escape(jobMessage) +
      '</p>' +
      (candidates.length
        ? '<div class="thumbs">' +
          candidates
            .map(
              (item, index) =>
                '<button data-live="choose-' +
                index +
                '" aria-pressed="' +
                (chosen === index) +
                '">' +
                image(item.imageUrl, '캐릭터 후보 ' + (index + 1)) +
                '</button>',
            )
            .join('') +
          '</div><div class="row">' +
          button('이 캐릭터 확정', 'confirm', true) +
          button('PNG 다운로드', 'download') +
          button('건너뛰기', 'skip') +
          '</div>'
        : '<div class="empty">설명을 입력하고 후보를 만들어 보세요.</div>') +
      (job && ['QUEUED', 'RUNNING'].includes(job.status)
        ? '<div class="row">' +
          button('상태 다시 확인', 'resume') +
          (job.status === 'QUEUED' ? button('대기 작업 취소', 'cancel') : '') +
          '</div>'
        : '') +
      (request && !busy && !job ? button('기존 요청 다시 확인', 'retry') : '') +
      '</section></div>'
    );
  }

  function profileView() {
    return panel(
      '내 정보·설정',
      '<div class="row between"><div><p class="muted">보유 크레딧</p><p class="balance">' +
        (wallet ? escape(wallet.credit.balance) + ' 크레딧' : '조회 전') +
        '</p><p class="muted">활동 포인트 ' +
        (wallet ? escape(wallet.activityPoint.balance) : '—') +
        ' 포인트</p></div>' +
        button('지갑·이용 내역', 'wallet') +
        '</div>' +
        '<form class="stack" data-live-form="profile">' +
        input('닉네임', 'nickname', 'text', user.nickname) +
        '<label>소개<textarea name="bio" maxlength="200">' +
        escape(user.bio) +
        '</textarea></label><label>프로필 이미지<input name="profile" type="file" accept="image/png,image/jpeg,image/webp"></label><button class="primary">프로필 저장</button></form>' +
        button('로그아웃', 'logout'),
    );
  }

  function walletView() {
    return panel(
      '내 지갑',
      '<h2>생성 크레딧</h2><p class="balance">' +
        escape(wallet.credit.balance) +
        ' 크레딧</p><p class="muted">예약 중 ' +
        escape(wallet.credit.reserved) +
        ' 크레딧 · 활동 포인트 ' +
        escape(wallet.activityPoint.balance) +
        ' 포인트</p><p class="muted">충전·결제는 다음 연동 단계에서 제공됩니다.</p><div class="live-transactions">이용 내역을 불러오는 중이에요.</div>',
    );
  }

  function updateHeader() {
    root.querySelectorAll('[data-auth-tab]').forEach((el) => {
      el.hidden = !!user;
    });
    let logout = root.querySelector('[data-live="header-logout"]');
    if (!logout) {
      logout = document.createElement('button');
      logout.dataset.live = 'header-logout';
      logout.textContent = '로그아웃';
      root.querySelector('.account').append(logout);
    }
    logout.hidden = !user;
  }

  async function session() {
    user = await api('/users/me');
    wallet = null;
    updateHeader();
    wallet = await api('/wallet');
  }

  function render(pageName, tabName) {
    if (
      !['studio', 'auth', 'profile', 'wallet', 'library', 'jobs'].includes(
        pageName,
      )
    )
      return null;
    page = pageName;
    tab = tabName;
    if (page === 'studio') return studioView();
    if (page === 'auth') return authView();
    return panel(
      '불러오는 중이에요',
      '<p class="muted">서버에서 정보를 가져오고 있어요.</p>',
    );
  }

  function redraw() {
    navigate(page, true);
  }

  async function load() {
    const token = ++revision;
    const target = page,
      targetTab = tab;
    try {
      if (target === 'studio') {
        if (!styles.length) {
          styles = (await api('/style-presets')).items;
          if (token !== revision) return;
          main.innerHTML = studioView();
        }
        return;
      }
      if (target === 'auth') {
        if (targetTab === '회원가입') {
          terms = (await api('/terms')).items.filter(
            (term) => term.type !== 'CREATOR',
          );
          if (token !== revision) return;
          main.querySelector('.live-terms').innerHTML = terms
            .map(
              (term) =>
                '<label><input type="checkbox" name="term" value="' +
                escape(term.id) +
                '" ' +
                (term.required ? 'required' : '') +
                '>' +
                escape(term.title) +
                (term.required ? ' (필수)' : ' (선택)') +
                '</label>' +
                button('약관 상세', 'term-' + term.id),
            )
            .join('');
        }
        return;
      }
      await session();
      if (token !== revision) return;
      if (target === 'profile') main.innerHTML = profileView();
      if (target === 'wallet') {
        main.innerHTML = walletView();
        const [credit, point] = await Promise.all([
          api('/wallet/credit-transactions'),
          api('/wallet/point-transactions'),
        ]);
        if (token !== revision) return;
        main.querySelector('.live-transactions').innerHTML =
          '<h3>크레딧 내역</h3>' +
          transactions(credit.items) +
          '<h3>포인트 내역</h3>' +
          transactions(point.items);
      }
      if (target === 'library') {
        const characters = await api('/characters');
        if (token !== revision) return;
        main.innerHTML = panel(
          '내 캐릭터',
          characters.items.length
            ? '<div class="grid">' +
                characters.items
                  .map(
                    (item) =>
                      '<article class="tile"><div class="art">' +
                      image(item.baseImageUrl, item.name) +
                      '</div><h3>' +
                      escape(item.name) +
                      '</h3><p class="muted">' +
                      (item.status === 'CONFIRMED'
                        ? '기준 캐릭터 확정 완료'
                        : '후보 선택 전') +
                      '</p>' +
                      button('후보·캐릭터 열기', 'character-' + item.id) +
                      '</article>',
                  )
                  .join('') +
                '</div>'
            : '<p>아직 만든 캐릭터가 없어요.</p>',
        );
      }
      if (target === 'jobs') {
        const data = await api('/generations');
        if (token !== revision) return;
        main.innerHTML = panel(
          '생성 내역',
          data.items.length
            ? data.items
                .map(
                  (item) =>
                    '<div class="list-row"><div><strong>' +
                    escape(item.type) +
                    '</strong><p class="muted">' +
                    escape(item.status) +
                    ' · ' +
                    escape(item.creditCost) +
                    ' 크레딧</p></div>' +
                    button('상태·결과 보기', 'job-' + item.jobId) +
                    '</div>',
                )
                .join('')
            : '<p>생성 내역이 없어요.</p>',
        );
      }
    } catch (error) {
      if (token !== revision) return;
      if (error.status === 401) {
        user = null;
        wallet = null;
        updateHeader();
        main.innerHTML = loginHint();
      } else if (target === 'studio') {
        jobMessage = error.message;
        main.innerHTML = studioView();
      } else
        main.innerHTML = panel('정보를 불러오지 못했어요', errorBox(error));
    }
  }

  function transactions(items) {
    return items.length
      ? items
          .map(
            (item) =>
              '<div class="list-row"><span>' +
              escape(item.type) +
              '</span><strong>' +
              escape(item.amount) +
              '</strong></div>',
          )
          .join('')
      : '<p class="muted">내역이 없어요.</p>';
  }

  function repaintJob() {
    if (page === 'studio') main.innerHTML = studioView();
  }

  async function checkJob() {
    clearTimeout(timer);
    if (!job) return;
    try {
      job = await api('/generations/' + encodeURIComponent(job.jobId));
      jobMessage =
        job.status === 'QUEUED'
          ? '대기 중 · 순번 ' + job.queuePosition
          : job.status === 'RUNNING'
            ? '생성 중 · ' + job.progress + '%'
            : job.status === 'SUCCEEDED'
              ? '생성이 완료됐어요.'
              : '작업 종료 · ' + (job.errorCode || job.status);
      if (job.status === 'SUCCEEDED' && job.type === 'CHARACTER_CANDIDATES') {
        const id = job.targetId || character?.id;
        character = await api('/characters/' + encodeURIComponent(id));
        candidates = (
          await api('/characters/' + encodeURIComponent(id) + '/candidates')
        ).items;
        chosen = 0;
      }
      repaintJob();
      if (['QUEUED', 'RUNNING'].includes(job.status))
        timer = setTimeout(checkJob, 3000);
    } catch (error) {
      jobMessage =
        error.message + ' 생성 내역에서 작업을 다시 확인할 수 있어요.';
      repaintJob();
    }
  }

  async function submitGeneration() {
    if (!request) return;
    busy = true;
    repaintJob();
    try {
      job = await api(
        '/characters/' +
          encodeURIComponent(request.characterId) +
          '/candidates',
        {
          method: 'POST',
          body: { count: 3 },
          idempotencyKey: request.key,
        },
      );
      request = null;
      await checkJob();
    } finally {
      busy = false;
      repaintJob();
    }
  }

  async function authSubmit(form) {
    const data = new FormData(form),
      email = String(data.get('email')).trim();
    const password = data.get('password');
    if (tab === '회원가입' || tab === '비밀번호 찾기') {
      const purpose = tab === '회원가입' ? 'SIGNUP' : 'PASSWORD_RESET';
      if (
        !verification ||
        verification.email !== email ||
        verification.purpose !== purpose
      )
        throw new Error('현재 이메일의 인증번호를 먼저 확인해 주세요.');
      if (tab === '회원가입') {
        await api('/auth/signup', {
          method: 'POST',
          body: {
            email,
            password,
            nickname: data.get('nickname'),
            verificationToken: verification.token,
            agreedTermIds: data.getAll('term'),
          },
        });
      } else {
        await api('/auth/password/reset', {
          method: 'POST',
          body: {
            email,
            newPassword: password,
            verificationToken: verification.token,
          },
        });
        verification = null;
        navigate('auth');
        notify('비밀번호를 재설정했어요. 다시 로그인해 주세요.');
        return;
      }
    } else {
      await api('/auth/login', { method: 'POST', body: { email, password } });
    }
    verification = null;
    form.reset();
    await session();
    navigate('profile');
    notify('로그인됐어요.');
  }

  async function handleForm(form) {
    const kind = form.dataset.liveForm;
    if (kind === 'auth') return authSubmit(form);
    if (kind === 'profile') {
      const data = new FormData(form),
        file = data.get('profile');
      const body = { nickname: data.get('nickname'), bio: data.get('bio') };
      if (file?.size)
        body.profileImageUploadId = (
          await uploadImage(file, 'PROFILE')
        ).uploadId;
      user = await api('/users/me', { method: 'PATCH', body });
      redraw();
      notify('프로필을 저장했어요.');
      return;
    }
    if (kind === 'generate') {
      if (request || (job && ['QUEUED', 'RUNNING'].includes(job.status)))
        throw new Error('진행 중인 작업이나 기존 요청을 먼저 확인해 주세요.');
      await session();
      const data = new FormData(form);
      description = String(data.get('description')).trim();
      styleKey = data.get('style');
      if (!description) throw new Error('캐릭터 설명을 입력해 주세요.');
      const estimate = await api('/generations/estimates', {
        method: 'POST',
        body: { type: 'CHARACTER_CANDIDATES', count: 3 },
      });
      if (!estimate.sufficient)
        throw new Error(
          '크레딧이 부족해요. 필요 ' +
            estimate.creditCost +
            ' / 보유 ' +
            estimate.creditBalance +
            ' 크레딧',
        );
      // Ask before reserving credits, after the server has calculated the current price.
      if (
        !window.confirm(
          '후보 3장 생성에 ' +
            estimate.creditCost +
            ' 크레딧이 필요해요. 보유 ' +
            estimate.creditBalance +
            ' 크레딧에서 사용해 생성할까요?',
        )
      )
        return;
      const reference = data.get('reference'),
        referenceUploadIds = [];
      if (reference?.size)
        referenceUploadIds.push(
          (await uploadImage(reference, 'REFERENCE')).uploadId,
        );
      character = await api('/characters', {
        method: 'POST',
        body: {
          name: description.slice(0, 30),
          description,
          stylePreset: styleKey,
          referenceUploadIds,
        },
      });
      candidates = [];
      job = null;
      chosen = 0;
      request = { characterId: character.id, key: crypto.randomUUID() };
      await submitGeneration();
    }
  }

  async function action(name) {
    if (name === 'login') return navigate('auth');
    if (name === 'wallet') return navigate('wallet');
    if (name === 'reload') return redraw();
    if (name === 'logout' || name === 'header-logout') {
      await api('/auth/logout', { method: 'POST', retry: false });
      user = null;
      wallet = null;
      candidates = [];
      character = null;
      job = null;
      request = null;
      clearTimeout(timer);
      updateHeader();
      navigate('auth');
      notify('로그아웃했어요.');
      return;
    }
    if (name === 'send-code' || name === 'verify-code') {
      const form = main.querySelector('[data-live-form="auth"]'),
        data = new FormData(form);
      const email = String(data.get('email')).trim(),
        purpose = tab === '회원가입' ? 'SIGNUP' : 'PASSWORD_RESET';
      if (!form.querySelector('[name="email"]').reportValidity()) return;
      if (name === 'send-code') {
        await api('/auth/email/verification-codes', {
          method: 'POST',
          body: { email, purpose },
        });
        verification = null;
        notify('인증번호를 이메일로 보냈어요.');
      } else {
        const result = await api('/auth/email/verification-codes/verify', {
          method: 'POST',
          body: { email, purpose, code: data.get('code') },
        });
        verification = { email, purpose, token: result.verificationToken };
        notify('이메일 인증을 완료했어요.');
      }
      return;
    }
    if (name.startsWith('term-')) {
      const data = await api('/terms/' + encodeURIComponent(name.slice(5)));
      const text = document.createElement('section');
      text.className = 'terms';
      text.textContent = data.content || data.body || data.title;
      main.querySelector('.live-terms').append(text);
      return;
    }
    if (name.startsWith('choose-')) {
      chosen = Number(name.slice(7));
      repaintJob();
      return;
    }
    if (name === 'skip') {
      candidates = [];
      repaintJob();
      return;
    }
    if (name === 'retry') return submitGeneration();
    if (name === 'resume') return checkJob();
    if (name === 'cancel') {
      await api('/generations/' + encodeURIComponent(job.jobId) + '/cancel', {
        method: 'POST',
      });
      await checkJob();
      notify('대기 작업을 취소했어요.');
      return;
    }
    if (name === 'confirm') {
      const item = candidates[chosen];
      if (!item || !character) throw new Error('후보를 선택해 주세요.');
      character = await api(
        '/characters/' + encodeURIComponent(character.id) + '/confirm',
        { method: 'POST', body: { candidateImageId: item.imageId } },
      );
      navigate('library');
      notify('기준 캐릭터를 확정했어요.');
      return;
    }
    if (name.startsWith('character-')) {
      character = await api(
        '/characters/' + encodeURIComponent(name.slice(10)),
      );
      candidates = (
        await api(
          '/characters/' + encodeURIComponent(character.id) + '/candidates',
        )
      ).items;
      description = character.description;
      styleKey = character.stylePreset;
      chosen = 0;
      navigate('studio');
      return;
    }
    if (name.startsWith('job-')) {
      job = await api('/generations/' + encodeURIComponent(name.slice(4)));
      navigate('studio');
      return checkJob();
    }
    if (name === 'download') {
      const item = candidates[chosen];
      if (!item) return;
      const response = await fetch(item.imageUrl, {
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error('다운로드하지 못했어요.');
      const bitmap = await createImageBitmap(await response.blob());
      try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, 'image/png'),
        );
        if (!blob) throw new Error('PNG 변환에 실패했어요.');
        const url = URL.createObjectURL(blob),
          a = document.createElement('a');
        a.href = url;
        a.download = 'emomix-character.png';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } finally {
        bitmap.close();
      }
    }
  }

  root.addEventListener(
    'click',
    async (event) => {
      const target = event.target.closest('[data-live], [data-live-tab]');
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (target.dataset.liveTab) {
        tab = target.dataset.liveTab;
        navigate('auth', tab);
        return;
      }
      if (target.disabled) return;
      target.disabled = true;
      try {
        await action(target.dataset.live);
      } catch (error) {
        notify(error.message);
      } finally {
        target.disabled = false;
      }
    },
    true,
  );
  root.addEventListener(
    'submit',
    async (event) => {
      const form = event.target;
      if (!form.dataset.liveForm) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (form.dataset.busy) return;
      form.dataset.busy = 'true';
      const submit = form.querySelector(
        'button[type="submit"], button:not([type])',
      );
      if (submit) submit.disabled = true;
      try {
        await handleForm(form);
      } catch (error) {
        notify(error.message);
      } finally {
        delete form.dataset.busy;
        if (submit) submit.disabled = false;
      }
    },
    true,
  );
  initializeCsrf()
    .then(session)
    .catch((error) => {
      if (error.status !== 401) notify(error.message);
      user = null;
      wallet = null;
      updateHeader();
    });
  return {
    render,
    openCharacter(characterId) {
      return action('character-' + characterId);
    },
    load,
    invalidate() {
      ++revision;
      page = '';
    },
    isLive(name) {
      return [
        'studio',
        'auth',
        'profile',
        'wallet',
        'library',
        'jobs',
      ].includes(name);
    },
  };
}
