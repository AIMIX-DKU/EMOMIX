// 헤더(크레딧·프로필·알림 배지)와 사이드바 메뉴를 로그인 상태에 맞춘다.
import { api } from './api.js';

const TTL = 15000;
export function createShell(root) {
  const $ = (selector) => root.querySelector(selector);
  const shell = $('.shell');
  let user = null,
    credit = null,
    unread = 0,
    loadedAt = 0,
    pending;

  function paint() {
    const logged = !!user;
    root.querySelectorAll('[data-need="user"]').forEach((el) => {
      el.hidden = !logged;
    });
    root.querySelectorAll('[data-need="admin"]').forEach((el) => {
      el.hidden = user?.role !== 'ADMIN';
    });
    root.querySelectorAll('[data-auth-tab]').forEach((el) => {
      el.hidden = logged;
    });
    const out = $('[data-live="header-logout"]');
    if (out) out.hidden = !logged;
    $('aside').hidden = !logged;
    shell.classList.toggle('no-side', !logged);
    const chip = $('[data-account="credit"]');
    chip.hidden = !logged;
    if (logged && credit !== null)
      chip.textContent = credit.toLocaleString('ko-KR') + ' 크레딧';
    const who = $('[data-account="who"]');
    who.hidden = !logged;
    if (logged) {
      const name = user.nickname || '내 계정';
      who.querySelector('.who-name').textContent = name;
      const avatar = who.querySelector('.avatar');
      avatar.textContent = '';
      if (user.profileImageUrl) {
        const img = new Image();
        img.alt = '';
        img.src = user.profileImageUrl;
        avatar.append(img);
      } else avatar.textContent = [...name][0] || '·';
    }
    const dot = $('[data-account="unread"]');
    dot.hidden = !unread;
    dot.textContent = unread > 99 ? '99+' : String(unread);
  }

  async function fetchState() {
    try {
      user = await api('/users/me');
    } catch {
      user = null;
      credit = null;
      unread = 0;
      return;
    }
    const [wallet, count] = await Promise.all([
      api('/wallet').catch(() => null),
      api('/notifications/unread-count').catch(() => null),
    ]);
    credit = wallet ? wallet.credit.balance : credit;
    unread = count?.count ?? 0;
  }

  // 화면을 옮길 때마다 부르되 15초 안에는 다시 묻지 않는다. force 는 로그인·결제 직후에 쓴다.
  async function refresh(force = false) {
    if (!force && Date.now() - loadedAt < TTL) return paint();
    pending ??= fetchState().finally(() => {
      pending = null;
      loadedAt = Date.now();
    });
    await pending;
    paint();
  }
  return {
    refresh,
    get user() {
      return user;
    },
  };
}
