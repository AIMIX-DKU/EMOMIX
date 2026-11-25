import { api, uploadImage } from './api.js';
import {
  h,
  id,
  picture,
  heading,
  panel,
  field,
  empty,
  date,
  allItems,
} from './service-ui.js';

export function createWorkshop(ui) {
  const choices = [
    ['ORIGINAL', '원본'],
    ['TRANSPARENT_PNG', '투명 PNG'],
    ['DISCORD', 'Discord 규격'],
  ];
  const back = (setId) => ui.go('set', { id: setId });
  async function cost(type, count, work) {
    const estimate = await api('/generations/estimates', {
      method: 'POST',
      body: { type, count },
    });
    if (!estimate.sufficient)
      throw Error(
        '크레딧이 부족합니다. 필요 ' +
          estimate.creditCost +
          ' / 보유 ' +
          estimate.creditBalance,
      );
    ui.confirm(
      '생성 비용 확인',
      count + '장 · ' + estimate.creditCost + ' 크레딧을 사용합니다.',
      work,
    );
  }
  async function library(params) {
    const tab = params.tab || 'sets';
    const menu =
      '<div class="row space">' +
      ui.link('이모티콘 세트', 'library', { tab: 'sets' }) +
      ui.link('캐릭터', 'library', { tab: 'characters' }) +
      ui.link('북마크', 'library', { tab: 'bookmarks' }) +
      ui.link('구매한 작품', 'library', { tab: 'purchases' }) +
      '</div>';
    const routes = {
      sets: '/sets',
      characters: '/characters',
      bookmarks: '/users/me/bookmarks',
      purchases: '/users/me/purchases',
    };
    const list = await ui.paginate(
      routes[tab],
      (items) =>
        '<div class="grid">' +
        items
          .map((raw) => {
            const item = raw.product || raw,
              target =
                tab === 'sets'
                  ? 'set'
                  : tab === 'characters'
                    ? 'character'
                    : tab === 'bookmarks'
                      ? 'post'
                      : 'product';
            return (
              '<article class="tile"><div class="art">' +
              picture(
                item.coverUrl ||
                  item.baseImageUrl ||
                  item.thumbnailUrl ||
                  item.thumbnailUrls?.[0],
                item.title || item.name,
              ) +
              '</div><h3>' +
              h(item.title || item.name) +
              '</h3><p class="muted">' +
              h(item.status || '') +
              '</p>' +
              ui.link('열기', target, { id: raw.productId || item.id }) +
              '</article>'
            );
          })
          .join('') +
        '</div>',
      { ...params, route: 'library' },
    );
    return (
      heading('내 보관함') +
      menu +
      '<div class="row space">' +
      ui.link('새 캐릭터 만들기', 'studio') +
      ui.link('새 세트 만들기', 'set-new') +
      '</div>' +
      list
    );
  }
  async function character(params) {
    const c = await api('/characters/' + id(params.id));
    return (
      heading(c.name) +
      panel(
        picture(c.baseImageUrl, c.name) +
          '<p>' +
          h(c.description) +
          '</p><p class="muted">' +
          h(c.status) +
          '</p><div class="row">' +
          ui.action('정보 수정', () =>
            ui.edit(
              '캐릭터 수정',
              field('name', '이름', 'text', c.name, { maxlength: 30 }) +
                field('description', '설명', 'textarea', c.description, {
                  optional: true,
                  maxlength: 500,
                }) +
                (c.status === 'CONFIRMED'
                  ? field(
                      'appearanceDescription',
                      '확정 외형 설명',
                      'textarea',
                      c.appearanceDescription,
                      { optional: true, maxlength: 500 },
                    )
                  : ''),
              async (data) => {
                await api('/characters/' + id(c.id), {
                  method: 'PATCH',
                  body: data,
                });
                ui.go('character', params);
              },
            ),
          ) +
          ui.action('삭제', () =>
            ui.confirm(
              '캐릭터 삭제',
              '사용 중인 캐릭터는 삭제할 수 없습니다.',
              async () => {
                await api('/characters/' + id(c.id), { method: 'DELETE' });
                ui.go('library', { tab: 'characters' });
              },
            ),
          ) +
          (c.status === 'CONFIRMED'
            ? ui.link('이 캐릭터로 세트 만들기', 'set-new', {
                characterId: c.id,
              })
            : ui.link('후보 선택·확정', 'studio', { characterId: c.id })) +
          '</div>',
      )
    );
  }
  async function newSet(params) {
    const chars = await allItems('/characters?status=CONFIRMED');
    if (!chars.items.length)
      return (
        heading('세트 만들기') +
        empty('먼저 캐릭터 후보를 생성하고 기준 캐릭터를 확정해 주세요.') +
        ui.link('캐릭터 만들기', 'studio')
      );
    return (
      heading('이모티콘 세트 만들기') +
      panel(
        ui.form(
          field(
            'characterId',
            '기준 캐릭터',
            chars.items.map((c) => [c.id, c.name]),
            params.characterId,
          ) +
            field('title', '세트 이름', 'text', '', { maxlength: 50 }) +
            field('description', '소개', 'textarea', '', {
              optional: true,
              maxlength: 500,
            }),
          async (data) => {
            const result = await api('/sets', { method: 'POST', body: data });
            back(result.id);
          },
          '세트 만들기',
        ),
      )
    );
  }
  async function set(params) {
    const s = await api('/sets/' + id(params.id)),
      emotions = (await api('/emotion-presets')).items;
    return (
      heading(s.title, s.description || '') +
      panel(
        '<div class="row">' +
          ui.action('세트 정보 수정', () =>
            ui.edit(
              '세트 정보',
              field('title', '제목', 'text', s.title, { maxlength: 50 }) +
                field('description', '소개', 'textarea', s.description, {
                  optional: true,
                  maxlength: 500,
                }),
              async (data) => {
                await api('/sets/' + id(s.id), { method: 'PATCH', body: data });
                back(s.id);
              },
            ),
          ) +
          ui.action('세트 삭제', () =>
            ui.confirm(
              '세트 삭제',
              '게시·판매 중인 세트는 삭제할 수 없습니다.',
              async () => {
                await api('/sets/' + id(s.id), { method: 'DELETE' });
                ui.go('library');
              },
            ),
          ) +
          ui.link('공유하기', 'post-edit', { setId: s.id }) +
          ui.link('판매하기', 'product-edit', { setId: s.id }) +
          ui.action('ZIP 다운로드', () =>
            downloadDialog('/sets/' + id(s.id) + '/download'),
          ) +
          '</div>' +
          '<h2>감정별 이모티콘 생성</h2>' +
          ui.form(
            emotions
              .map((e) =>
                field('emotion-' + e.key, e.label, 'checkbox', false, {
                  optional: true,
                }),
              )
              .join('') +
              field('extra', '추가 표현', 'textarea', '', {
                optional: true,
                maxlength: 300,
              }),
            async (data, form) => {
              const selected = emotions.filter((e) => data['emotion-' + e.key]);
              if (!selected.length || selected.length > 16)
                throw Error('1~16개 표정을 선택해 주세요.');
              const key = ui.key(form);
              await cost('EMOTION_SET', selected.length, async () => {
                const job = await api('/sets/' + id(s.id) + '/generations', {
                  method: 'POST',
                  idempotencyKey: key,
                  body: {
                    emotions: selected.map((e) => ({
                      key: e.key,
                      customPrompt: data.extra || '',
                    })),
                  },
                });
                ui.go('job', { id: job.jobId });
              });
            },
            '생성 비용 확인',
          ),
      ) +
      '<div class="grid top">' +
      s.emoticons
        .map(
          (e) =>
            '<article class="tile"><div class="art">' +
            picture(e.imageUrl, e.label) +
            '</div><h3>' +
            h(e.label) +
            '</h3><p class="muted">' +
            h(e.status) +
            '</p>' +
            ui.link('편집·버전·다운로드', 'editor', { id: e.id }) +
            '</article>',
        )
        .join('') +
      '</div>'
    );
  }
  function downloadDialog(path) {
    ui.dialog(
      '다운로드',
      ui.form(
        field('format', '출력 형식', choices, 'TRANSPARENT_PNG'),
        (data) => ui.download(path + '?format=' + data.format),
        '다운로드',
      ) +
        ui.action('외부 서비스 등록 안내', async () => {
          const g = await api('/guides/export');
          ui.dialog(
            '등록 안내',
            '<ol>' +
              g.discord.steps.map((s) => '<li>' + h(s) + '</li>').join('') +
              '</ol><p>' +
              h(g.notices.join(' ')) +
              '</p><p>' +
              h(g.kakao.message) +
              '</p>',
          );
        }),
    );
  }
  async function editor(params) {
    const e = await api('/emoticons/' + id(params.id)),
      versions = await api('/emoticons/' + id(params.id) + '/versions');
    const regenerate = async (data, form) => {
      const key = ui.key(form);
      await cost('EMOTION_REGENERATE', 1, async () => {
        const job = await api('/emoticons/' + id(e.id) + '/regenerations', {
          method: 'POST',
          body: data,
          idempotencyKey: key,
        });
        ui.go('job', { id: job.jobId });
      });
    };
    return (
      heading('이모티콘 편집', e.label) +
      '<div class="columns">' +
      panel(
        picture(e.imageUrl, e.label) +
          ui.form(
            field('label', '라벨', 'text', e.label, { maxlength: 30 }),
            async (data) => {
              await api('/emoticons/' + id(e.id), {
                method: 'PATCH',
                body: data,
              });
              ui.go('editor', params);
            },
            '라벨 저장',
          ) +
          ui.action('이모티콘 삭제', () =>
            ui.confirm('삭제', '선택한 이모티콘을 삭제합니다.', async () => {
              await api('/emoticons/' + id(e.id), { method: 'DELETE' });
              back(e.setId);
            }),
          ) +
          ui.action('이미지 다운로드', () =>
            downloadDialog('/emoticons/' + id(e.id) + '/download'),
          ) +
          ui.link('세트로 돌아가기', 'set', { id: e.setId }),
      ) +
      panel(
        '<h2>다시 만들기</h2>' +
          ui.form(
            field('prompt', '수정 요청', 'textarea', '', {
              optional: true,
              maxlength: 300,
            }),
            regenerate,
            '재생성 비용 확인',
          ) +
          '<h2>부분 수정</h2><p class="muted">수정할 부분을 칠해 주세요. 흰 영역이 수정 대상입니다.</p><div class="inpaint-area" data-original="' +
          h(e.imageUrl || '') +
          '">' +
          picture(e.imageUrl, e.label) +
          '<canvas aria-label="수정할 영역을 드래그해 선택"></canvas></div>' +
          '<div class="row">' +
          ui.action('마스크 지우기', () => {
            const canvas = document.querySelector('.inpaint-area canvas');
            canvas
              .getContext('2d')
              .clearRect(0, 0, canvas.width, canvas.height);
            canvas.dataset.painted = '';
            const revision = document.querySelector('[name=maskRevision]');
            revision.value = String(Number(revision.value) + 1);
          }) +
          '</div>' +
          ui.form(
            '<input type="hidden" name="maskRevision" value="0">' +
              field('prompt', '부분 수정 요청', 'textarea', '', {
                maxlength: 300,
              }),
            async (data, form) => {
              const c = document.querySelector('.inpaint-area canvas');
              if (c.dataset.ready !== 'true' || !c.dataset.painted)
                throw Error('이미지를 불러온 뒤 수정 영역을 칠해 주세요.');
              const mask = document.createElement('canvas');
              mask.width = c.width;
              mask.height = c.height;
              const ctx = mask.getContext('2d');
              ctx.fillStyle = '#000';
              ctx.fillRect(0, 0, mask.width, mask.height);
              ctx.drawImage(c, 0, 0);
              const blob = await new Promise((resolve) =>
                mask.toBlob(resolve, 'image/png'),
              );
              if (!blob) throw Error('마스크 생성에 실패했습니다.');
              const key = ui.key(form);
              await cost('INPAINT', 1, async () => {
                if (form.dataset.maskKey !== key) {
                  const upload = await uploadImage(
                    new File([blob], 'mask.png', { type: 'image/png' }),
                    'MASK',
                  );
                  form.dataset.maskUploadId = upload.uploadId;
                  form.dataset.maskKey = key;
                }
                const job = await api('/emoticons/' + id(e.id) + '/inpaints', {
                  method: 'POST',
                  idempotencyKey: key,
                  body: {
                    maskUploadId: form.dataset.maskUploadId,
                    prompt: data.prompt,
                  },
                });
                ui.go('job', { id: job.jobId });
              });
            },
            '부분 수정 비용 확인',
          ) +
          '<h2>버전 기록</h2>' +
          versions.items
            .map(
              (v) =>
                '<article>' +
                picture(v.imageUrl, '버전 ' + v.version) +
                '<p>버전 ' +
                h(v.version) +
                ' · ' +
                h(v.source) +
                ' · ' +
                date(v.createdAt) +
                '</p>' +
                (v.isCurrent
                  ? '<span class="chip">현재 버전</span>'
                  : ui.action('현재 버전으로 선택', async () => {
                      await api(
                        '/emoticons/' +
                          id(e.id) +
                          '/versions/' +
                          id(v.versionId) +
                          '/current',
                        { method: 'PUT' },
                      );
                      ui.go('editor', params);
                    })) +
                '</article>',
            )
            .join(''),
      ) +
      '</div>'
    );
  }
  function mount() {
    const watch = document.querySelector('[data-watch-job]');
    if (watch)
      ui.schedule(() => ui.go('job', { id: watch.dataset.watchJob }), 3000);
    const area = document.querySelector('.inpaint-area');
    if (!area) return;
    const canvas = area.querySelector('canvas'),
      img = area.querySelector('img');
    if (!img) return;
    const ready = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.dataset.ready = 'true';
    };
    if (img.complete && img.naturalWidth) ready();
    else img.addEventListener('load', ready, { once: true });
    let drawing = false;
    const paint = (event) => {
      if (!drawing || canvas.dataset.ready !== 'true') return;
      const r = canvas.getBoundingClientRect(),
        ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(
        ((event.clientX - r.left) * canvas.width) / r.width,
        ((event.clientY - r.top) * canvas.height) / r.height,
        Math.max(8, canvas.width * 0.035),
        0,
        Math.PI * 2,
      );
      ctx.fill();
      canvas.dataset.painted = 'true';
      const revision = document.querySelector('[name=maskRevision]');
      revision.value = String(Number(revision.value) + 1);
    };
    canvas.addEventListener('pointerdown', (e) => {
      drawing = true;
      canvas.setPointerCapture(e.pointerId);
      paint(e);
    });
    canvas.addEventListener('pointermove', paint);
    canvas.addEventListener('pointerup', () => {
      drawing = false;
    });
    canvas.addEventListener('pointercancel', () => {
      drawing = false;
    });
  }
  async function job(params) {
    const j = await api('/generations/' + id(params.id));
    const active = ['QUEUED', 'RUNNING'].includes(j.status);
    const result =
      j.result?.images?.map((i) => picture(i.imageUrl, '생성 결과')).join('') ||
      '';
    return (
      heading('생성 작업') +
      panel(
        '<p>' +
          h(j.status) +
          ' · ' +
          h(j.progress || 0) +
          '%</p><p>대기 순번 ' +
          h(j.queuePosition) +
          ' · 비용 ' +
          h(j.creditCost) +
          ' 크레딧</p><p role="status">' +
          h(j.errorCode || '') +
          '</p>' +
          '<div class="grid">' +
          result +
          '</div><div class="row">' +
          ui.link('새로고침', 'job', params) +
          (j.status === 'QUEUED'
            ? ui.action('대기 취소', async () => {
                await api('/generations/' + id(j.jobId) + '/cancel', {
                  method: 'POST',
                });
                ui.go('job', params);
              })
            : '') +
          (j.targetType === 'SET'
            ? ui.link('세트 보기', 'set', { id: j.targetId })
            : j.targetType === 'EMOTICON'
              ? ui.link('편집기로 이동', 'editor', { id: j.targetId })
              : ui.link('캐릭터 확인', 'character', { id: j.targetId })) +
          '</div>' +
          (active
            ? '<p class="muted" data-watch-job="' +
              h(j.jobId) +
              '">작업 상태를 자동으로 확인하고 있어요.</p>'
            : ''),
      )
    );
  }
  async function jobs(params) {
    return (
      heading('생성 내역') +
      (await ui.paginate(
        '/generations',
        (items) =>
          panel(
            items
              .map(
                (j) =>
                  '<div class="list-row"><div>' +
                  h(j.type) +
                  '<p class="muted">' +
                  h(j.status) +
                  ' · ' +
                  h(j.creditCost) +
                  ' 크레딧</p></div>' +
                  ui.link('상태·결과', 'job', { id: j.jobId }) +
                  '</div>',
              )
              .join(''),
          ),
        { ...params, route: 'jobs' },
      ))
    );
  }
  return {
    routes: { library, character, 'set-new': newSet, set, editor, job, jobs },
    mount,
  };
}
