import {
  createIcons,
  Bell,
  FolderHeart,
  Clock3,
  ShoppingBag,
  ImagePlus,
} from 'lucide';
import { createLiveApp } from './live.js';
import { createUI, heading, panel, h } from './service-ui.js';
import { createPayments } from './payments.js';
import { createAccount } from './account-features.js';
import { createWorkshop } from './workshop.js';
import { createSocial } from './social.js';
import { createMarket } from './market-features.js';
import { createAdmin } from './admin-features.js';

const root = document.getElementById('emomix-full'),
  main = root.querySelector('main'),
  notice = root.querySelector('.notice');
let route = 'studio',
  params = {};
function notify(message) {
  notice.textContent = message;
  notice.hidden = false;
}
function icons() {
  createIcons({
    icons: { Bell, FolderHeart, Clock3, ShoppingBag, ImagePlus },
    attrs: { width: 15, height: 15 },
  });
}
const ui = createUI(root, go, notify);
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
const routes = {
  ...createAccount(ui, payments),
  ...workshop.routes,
  ...createSocial(ui, payments),
  ...createMarket(ui, payments),
  ...createAdmin(ui),
};

function profileLinks() {
  return (
    '<div class="row space">' +
    ui.link('계정·보안', 'security') +
    ui.link('알림 설정', 'settings') +
    ui.link('약관·탈퇴', 'agreements') +
    ui.link('구독 관리', 'subscription') +
    '</div>'
  );
}
async function go(page = 'studio', values = {}, record = true) {
  const epoch = ui.next();
  live.invalidate();
  route = page;
  params = values;
  notice.hidden = true;
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
      if (page === 'auth') {
        main
          .querySelector('.auth-panel')
          .insertAdjacentHTML(
            'beforeend',
            '<div class="row top"><a class="secondary download" href="/api/v1/auth/discord?mode=LOGIN&redirectPath=/">Discord로 로그인</a></div>',
          );
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
    main.innerHTML =
      heading(
        error.status === 401
          ? '로그인이 필요해요'
          : error.status === 403
            ? '이용 권한을 확인해 주세요'
            : '화면을 불러오지 못했어요',
      ) +
      panel(
        '<p role="alert">' +
          h(error.message) +
          '</p><div class="row">' +
          ui.link('로그인', 'auth') +
          ui.action('다시 시도', () => go(page, values)) +
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
