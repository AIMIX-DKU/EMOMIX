import { api } from './api.js';

export const h = (value) =>
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
export const id = (value) => encodeURIComponent(value);
export const money = (value) =>
  Number(value || 0).toLocaleString('ko-KR') + '원';
export const date = (value) =>
  value ? new Date(value).toLocaleString('ko-KR') : '—';
export function picture(url, label = '') {
  if (!url)
    return '<div class="img-empty"><span aria-hidden="true">🖼</span><small>아직 이미지가 없어요</small></div>';
  const parsed = new URL(url, location.origin);
  if (!['http:', 'https:', 'blob:'].includes(parsed.protocol)) return '';
  return (
    '<img class="live-image is-loading" loading="lazy" decoding="async" src="' +
    h(parsed.href) +
    '" alt="' +
    h(label) +
    '">'
  );
}
export const heading = (title, body = '') =>
  '<h1>' +
  h(title) +
  '</h1>' +
  (body ? '<p class="lead space">' + h(body) + '</p>' : '');
export const pageHead = (title, body = '', actions = '') =>
  '<div class="page-head"><div><h1>' +
  h(title) +
  '</h1>' +
  (body ? '<p class="lead">' + h(body) + '</p>' : '') +
  '</div>' +
  (actions ? '<div class="row">' + actions + '</div>' : '') +
  '</div>';
export const panel = (body) =>
  '<section class="panel stack">' + body + '</section>';
export const empty = (text = '아직 내역이 없어요.') =>
  '<p class="empty">' + h(text) + '</p>';
export async function allItems(path) {
  const items = [];
  let page = 0,
    totalPages = 1;
  do {
    const data = await api(
      path + (path.includes('?') ? '&' : '?') + 'size=50&page=' + page,
    );
    items.push(...data.items);
    totalPages = data.totalPages || 1;
    page++;
  } while (page < totalPages);
  return { items };
}
export function field(name, label, type = 'text', value = '', options = {}) {
  const required = options.optional ? '' : ' required';
  const attrs = ['min', 'max', 'step', 'maxlength']
    .map((key) =>
      options[key] === undefined
        ? ''
        : ' ' + key + '="' + h(options[key]) + '"',
    )
    .join('');
  const help = options.help ? '<small>' + h(options.help) + '</small>' : '';
  if (type === 'checkbox')
    return (
      '<label><input name="' +
      h(name) +
      '" type="checkbox" ' +
      (value ? 'checked' : '') +
      required +
      '>' +
      h(label) +
      '</label>'
    );
  if (type === 'textarea')
    return (
      '<label>' +
      h(label) +
      '<textarea name="' +
      h(name) +
      '" rows="3"' +
      required +
      attrs +
      '>' +
      h(value) +
      '</textarea>' +
      help +
      '</label>'
    );
  if (Array.isArray(type))
    return (
      '<label>' +
      h(label) +
      '<select name="' +
      h(name) +
      '"' +
      required +
      '>' +
      type
        .map((item) => {
          const [key, text] = Array.isArray(item) ? item : [item, item];
          return (
            '<option value="' +
            h(key) +
            '" ' +
            (String(key) === String(value) ? 'selected' : '') +
            '>' +
            h(text) +
            '</option>'
          );
        })
        .join('') +
      '</select>' +
      help +
      '</label>'
    );
  return (
    '<label>' +
    h(label) +
    '<input name="' +
    h(name) +
    '" type="' +
    h(type) +
    '" value="' +
    (type === 'file' ? '' : h(value)) +
    '"' +
    required +
    attrs +
    (options.accept ? ' accept="' + h(options.accept) + '"' : '') +
    '>' +
    help +
    '</label>'
  );
}
export function formValues(form) {
  const result = Object.create(null);
  for (const input of form.querySelectorAll('[name]')) {
    if (input.disabled) continue;
    let value =
      input.type === 'checkbox'
        ? input.checked
        : input.type === 'file'
          ? input.files[0]
          : input.type === 'number'
            ? input.value === ''
              ? undefined
              : Number(input.value)
            : input.value.trim();
    if ((value === '' || value === undefined) && !input.required) continue;
    result[input.name] = value;
  }
  return result;
}

export function createUI(root, go, notify) {
  let sequence = 0,
    epoch = 0,
    modalVersion = 0,
    opener;
  const handlers = new Map(),
    overlay = root.querySelector('.overlay');
  const key = (handler) => {
    const k = String(++sequence);
    handlers.set(k, handler);
    return k;
  };
  const action = (label, handler, primary = false) =>
    '<button type="button" data-do="' +
    key(handler) +
    '" class="' +
    (primary ? 'primary' : 'secondary') +
    '">' +
    h(label) +
    '</button>';
  const link = (label, page, params = {}) =>
    action(label, () => go(page, params));
  // 카드 전체가 눌리는 목록 카드. art 는 이미 만들어진 HTML, 나머지는 텍스트.
  const tileDo = (handler, { art, title, meta = '', badge = '' }) =>
    '<button type="button" class="tile" data-do="' +
    key(handler) +
    '"><span class="art">' +
    art +
    '</span>' +
    (badge ? '<span class="badge">' + h(badge) + '</span>' : '') +
    '<strong class="tile-title">' +
    h(title) +
    '</strong>' +
    (meta ? '<span class="muted">' + meta + '</span>' : '') +
    '</button>';
  const tile = (page, params, spec) => tileDo(() => go(page, params), spec);
  // 한 줄 검색창 (선택 입력 select 포함)
  const searchForm = (handler, { name = 'keyword', placeholder, value = '', extra = '' }) =>
    '<form class="toolbar" role="search" data-send="' +
    key(handler) +
    '"><input name="' +
    h(name) +
    '" type="search" placeholder="' +
    h(placeholder) +
    '" aria-label="' +
    h(placeholder) +
    '" value="' +
    h(value) +
    '">' +
    extra +
    '<button type="submit" class="primary">검색</button></form>';
  // 탭처럼 보이는 선택 버튼 묶음. items: [값, 라벨]
  const segments = (items, current, pick) =>
    '<div class="tabs" role="group">' +
    items
      .map(
        ([value, text]) =>
          '<button type="button" data-do="' +
          key(() => pick(value)) +
          '" aria-pressed="' +
          (String(value) === String(current ?? '')) +
          '">' +
          h(text) +
          '</button>',
      )
      .join('') +
    '</div>';
  const form = (fields, handler, label = '저장', help = '') =>
    '<form class="stack" data-send="' +
    key(handler) +
    '">' +
    help +
    fields +
    '<button type="submit" class="primary">' +
    h(label) +
    '</button></form>';
  function close() {
    overlay.hidden = true;
    overlay.querySelector('.modal-body').replaceChildren();
    opener?.focus();
  }
  function dialog(title, body) {
    modalVersion++;
    opener = document.activeElement;
    root.querySelector('#mix-modal-title').textContent = title;
    overlay.querySelector('.modal-body').innerHTML = body;
    overlay.hidden = false;
    overlay.querySelector('[data-close]').focus();
    return overlay.querySelector('.modal-body');
  }
  function edit(title, fields, handler, label = '저장', help = '') {
    let version;
    dialog(
      title,
      form(
        fields,
        async (data, formElement) => {
          await handler(data, formElement);
          if (version === modalVersion) close();
        },
        label,
        help,
      ),
    );
    version = modalVersion;
  }
  function confirm(title, text, handler) {
    dialog(
      title,
      '<p>' +
        h(text) +
        '</p><div class="row top">' +
        action(
          '확인',
          async () => {
            await handler();
            close();
          },
          true,
        ) +
        action('취소', close) +
        '</div>',
    );
  }
  async function paginate(path, render, params = {}, { empty: emptyHtml } = {}) {
    const page = Number(params.page || 0);
    const join = path.includes('?') ? '&' : '?';
    const data = await api(path + join + 'page=' + page + '&size=12');
    return (
      (data.items.length ? render(data.items) : (emptyHtml ?? empty())) +
      ((data.totalPages || 1) > 1
        ? '<div class="row top pager">' +
      (page > 0
        ? action('이전', () => go(params.route, { ...params, page: page - 1 }))
        : '') +
      '<span class="muted">' +
      (page + 1) +
      ' / ' +
      Math.max(1, data.totalPages || 1) +
      '</span>' +
      (page + 1 < data.totalPages
        ? action('다음', () => go(params.route, { ...params, page: page + 1 }))
        : '') +
          '</div>'
        : '')
    );
  }
  root.addEventListener('click', async (event) => {
    if (event.target.closest('[data-close]')) {
      event.preventDefault();
      close();
      return;
    }
    const button = event.target.closest('[data-do]');
    if (!button) return;
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    try {
      await handlers.get(button.dataset.do)?.();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
  root.addEventListener('submit', async (event) => {
    const target = event.target.closest('[data-send]');
    if (!target) return;
    event.preventDefault();
    if (target.dataset.busy) return;
    target.dataset.busy = 'true';
    const submit = target.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      await handlers.get(target.dataset.send)?.(formValues(target), target);
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      delete target.dataset.busy;
      submit.disabled = false;
    }
  });
  root.addEventListener('keydown', (event) => {
    if (overlay.hidden) return;
    if (event.key === 'Escape') return close();
    if (event.key !== 'Tab') return;
    const controls = [
      ...overlay.querySelectorAll('button,input,textarea,select,a[href]'),
    ].filter((el) => !el.disabled && el.getClientRects().length);
    const first = controls[0],
      last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
  return {
    action,
    link,
    tile,
    tileDo,
    searchForm,
    segments,
    form,
    edit,
    dialog,
    close,
    confirm,
    paginate,
    go,
    notify,
    next() {
      close();
      handlers.clear();
      epoch++;
      return epoch;
    },
    valid(token) {
      return token === epoch;
    },
    schedule(handler, milliseconds) {
      const token = epoch;
      setTimeout(() => {
        if (token === epoch) handler();
      }, milliseconds);
    },
    async download(path) {
      const result = await api(path);
      const url = result.downloadUrl || result.url;
      if (!url) throw new Error('다운로드 주소가 없습니다.');
      const safe = new URL(url, location.origin);
      if (!['http:', 'https:'].includes(safe.protocol))
        throw new Error('다운로드 주소가 올바르지 않습니다.');
      const a = document.createElement('a');
      a.href = safe.href;
      a.download = result.filename || result.fileName || '';
      a.target = '_blank';
      a.rel = 'noopener';
      a.click();
    },
    // Keep an idempotency key for a form while an ambiguous request can be retried.
    key(formElement) {
      const signature = JSON.stringify(
        [...new FormData(formElement)].map(([key, value]) => [
          key,
          value instanceof File
            ? [value.name, value.size, value.lastModified]
            : value,
        ]),
      );
      if (formElement.dataset.requestSignature !== signature) {
        formElement.dataset.requestKey = crypto.randomUUID();
        formElement.dataset.requestSignature = signature;
      }
      return formElement.dataset.requestKey;
    },
  };
}
