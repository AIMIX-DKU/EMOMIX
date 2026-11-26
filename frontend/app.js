import {
  createIcons,
  Bell,
  FolderHeart,
  Clock3,
  ShoppingBag,
  ImagePlus,
  Wallet,
  Sparkles,
  Users,
  User,
} from 'lucide';
import { createLiveApp } from './live.js';
import { createShell } from './shell.js';
import { enhanceFileInputs } from './uploads.js';
import { api } from './api.js';
import { DISCORD_PATH } from './icons.js';
import { createUI, heading, panel, h } from './service-ui.js';
import { createPayments } from './payments.js';
import { createAccount } from './account-features.js';
import { createWorkshop } from './workshop.js';
import { createSocial } from './social.js';
import { createMarket } from './market-features.js';
import { createAdmin } from './admin-features.js';

const root = document.getElementById('emomix-full'),
  main = root.querySelector('main'),
  toasts = root.querySelector('.toasts');
let route = 'studio',
  params = {};
// 화면 구석에 잠깐 떴다 사라지는 알림. type 을 안 주면 문구로 오류인지 짐작한다.
const ERROR_HINT = /실패|오류|못했|못해|부족|올바르지|초과|권한이 없|불가/;
function notify(message, type) {
  const kind = type || (ERROR_HINT.test(message) ? 'error' : 'ok');
  const toast = document.createElement('div');
  toast.className = 'toast ' + kind;
  toast.textContent = message;
  toast.addEventListener('click', () => toast.remove());
  toasts.append(toast);
  while (toasts.children.length > 3) toasts.firstElementChild.remove();
  setTimeout(() => toast.remove(), kind === 'error' ? 7000 : 3500);
}
function icons() {
  createIcons({
    icons: {
      Bell,
      FolderHeart,
      Clock3,
      ShoppingBag,
      ImagePlus,
      Wallet,
      Sparkles,
      Users,
      User,
    },
    attrs: { width: 15, height: 15 },
  });
}
// 이미지가 다 받아지면 로딩 표시를 걷고, 실패하면 빈 자리 안내로 바꾼다.
root.addEventListener(
  'load',
  (event) => event.target.classList?.remove('is-loading'),
  true,
);
root.addEventListener(
  'error',
  (event) => {
    const img = event.target;
    if (img.tagName !== 'IMG' || !img.classList.contains('live-image')) return;
    img.outerHTML =
      '<div class="img-empty"><span aria-hidden="true">🖼</span><small>이미지를 불러오지 못했어요</small></div>';
  },
  true,
);
const ui = createUI(root, go, notify);
const shell = createShell(root);
enhanceFileInputs(root);
const live = createLiveApp({
  root,
  navigate(page, keep) {
    if (typeof keep === 'string') return go(page, { tab: keep });
    return go(page, keep && page === route ? params : {});
  },
  notify,
});
const payments = createPayments(ui),
  workshop = createWorkshop(ui);
const DISCORD_LOGIN =
  '<div class="divider"><span>또는</span></div>' +
  '<a class="btn-discord" href="/api/v1/auth/discord?mode=LOGIN&redirectPath=/">' +
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path fill="currentColor" d="' +
  DISCORD_PATH +
  '"/></svg>' +
  '<span>Discord로 계속하기</span></a>';
const TITLES = {
  studio: '만들기',
  library: '내 보관함',
  jobs: '생성 내역',
  wallet: '지갑·충전',
  orders: '구매·후원',
  subscription: '구독 관리',
  profile: '내 정보·설정',
  creator: '창작자 센터',
  admin: '관리자',
  community: '커뮤니티',
  market: '마켓',
  notifications: '알림',
  rankings: '랭킹',
  terms: '약관',
  auth: '로그인',
};
const routes = {
  terms: async () => {
    const terms = (await api('/terms')).items.filter((t) => t.type !== 'CREATOR');
    return (
      heading('이용약관·개인정보 처리방침') +
      terms
        .map((t) =>
          panel(
            '<h2>' +
              h(t.title) +
              '</h2>' +
              ui.action('내용 보기', async () => {
                const detail = await api('/terms/' + encodeURIComponent(t.id));
                ui.dialog(detail.title, '<div class="terms">' + h(detail.content) + '</div>');
              }),
          ),
        )
        .join('')
    );
  },
  ...createAccount(ui, payments),
  ...workshop.routes,
  ...createSocial(ui, payments),
  ...createMarket(ui, payments),
  ...createAdmin(ui),
};

function profileLinks() {
  return (
    '<div class="row space">' +
    ui.link('지갑·충전', 'wallet') +
    ui.link('생성 내역', 'jobs') +
    ui.link('구매·후원', 'orders') +
    ui.link('구독 관리', 'subscription') +
    ui.link('창작자 센터', 'creator') +
    (shell.user?.role === 'ADMIN' ? ui.link('관리자', 'admin') : '') +
    ui.link('계정·보안', 'security') +
    ui.link('알림 설정', 'settings') +
    ui.link('약관·탈퇴', 'agreements') +
    ui.link('내 신고 내역', 'reports') +
    '</div>'
  );
}
async function go(page = 'studio', values = {}, record = true) {
  const epoch = ui.next();
  live.invalidate();
  const leaving = route;
  route = page;
  document.title = (TITLES[page] ? TITLES[page] + ' · ' : '') + 'EmoMix';
  // 로그인·결제처럼 계정 상태가 바뀌는 화면을 지나면 바로 다시 읽는다.
  const volatile = ['auth', 'payment', 'discord-signup'];
  shell.refresh(volatile.includes(leaving) || volatile.includes(page));
  params = values;
  if (record) {
    const hash = new URLSearchParams({
      page,
      ...Object.fromEntries(
        Object.entries(values).map(([k, v]) => [k, String(v)]),
      ),
    });
    history.replaceState(
      null,
      '',
      location.pathname + location.search + '#' + hash,
    );
  }
  root
    .querySelectorAll('[data-go]')
    .forEach((button) =>
      button.setAttribute(
        'aria-current',
        button.dataset.go === page ? 'page' : 'false',
      ),
    );
  main.innerHTML = panel('<p role="status">불러오는 중이에요.</p>');
  try {
    if (routes[page]) {
      const body = await routes[page](values);
      if (!ui.valid(epoch)) return;
      main.innerHTML = body;
      workshop.mount();
      icons();
    } else {
      const body = live.render(page, values.tab || '');
      if (body === null) throw Error('존재하지 않는 화면입니다.');
      main.innerHTML = body;
      if (page === 'profile')
        main.insertAdjacentHTML('afterbegin', profileLinks());
      if (page === 'auth' && values.tab !== '비밀번호 찾기') {
        main.querySelector('.auth-panel').insertAdjacentHTML('beforeend', DISCORD_LOGIN);
      }
      icons();
      await live.load();
      if (!ui.valid(epoch)) return;
      // The live profile renderer replaces its loading panel after fetching data.
      if (page === 'profile')
        main.insertAdjacentHTML('afterbegin', profileLinks());
      if (page === 'studio' && values.characterId)
        await live.openCharacter(values.characterId);
    }
  } catch (error) {
    if (!ui.valid(epoch)) return;
    const denied = error.status === 403;
    main.innerHTML =
      heading(
        error.status === 401
          ? '로그인이 필요해요'
          : denied
            ? '접근 권한이 없어요'
            : '화면을 불러오지 못했어요',
      ) +
      panel(
        '<p role="alert">' +
          h(denied ? '이 화면을 볼 수 있는 권한이 없는 계정이에요.' : error.message) +
          '</p><div class="row">' +
          (denied
            ? ui.link('처음으로', 'studio')
            : ui.link('로그인', 'auth') +
              ui.action('다시 시도', () => go(page, values))) +
          '</div>',
      );
  }
}
root.addEventListener('click', (event) => {
  const button = event.target.closest('[data-go],[data-auth-tab]');
  if (!button) return;
  if (button.dataset.authTab) go('auth', { tab: button.dataset.authTab });
  else go(button.dataset.go);
});
window.addEventListener('hashchange', () => {
  const data = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
  const { page, ...rest } = data;
  go(page || 'studio', rest, false);
});
const initial = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
const query = new URLSearchParams(location.search);
if (query.has('payment')) go('payment');
else if (location.pathname.endsWith('/signup/discord')) go('discord-signup');
else if (location.pathname.endsWith('/login')) {
  go('auth');
  if (query.get('error')) notify('Discord 로그인 오류: ' + query.get('error'));
} else
  go(
    initial.page || 'studio',
    Object.fromEntries(
      Object.entries(initial).filter(([key]) => key !== 'page'),
    ),
  );
