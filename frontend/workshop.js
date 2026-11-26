import { api, uploadImage } from './api.js';
import { label } from './labels.js';
import { createInpaint } from './inpaint.js';
import {
  h,
  id,
  picture,
  heading,
  pageHead,
  panel,
  field,
  empty,
  date,
  allItems,
} from './service-ui.js';

export function createWorkshop(ui) {
  const inpaint = createInpaint(ui);
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
    // 확인창 없이 바로 생성한다. 크레딧이 모자라면 위에서 오류로 알려 준다.
    await work();
  }
  const LIBRARY = {
    sets: { path: '/sets', title: '이모티콘 세트' },
    characters: { path: '/characters', title: '캐릭터' },
    bookmarks: { path: '/users/me/bookmarks', title: '북마크' },
    purchases: { path: '/users/me/purchases', title: '구매한 작품' },
  };
  const libraryTile = (raw, tab) => {
    const item = raw.product || raw,
      target =
        tab === 'sets'
          ? 'set'
          : tab === 'characters'
            ? 'character'
            : tab === 'bookmarks'
              ? 'post'
              : 'product';
    return ui.tile(
      target,
      { id: raw.productId || item.id },
      {
        art: picture(
          item.coverUrl ||
            item.baseImageUrl ||
            item.thumbnailUrl ||
            item.thumbnailUrls?.[0],
          item.title || item.name,
        ),
        title: item.title || item.name,
        meta: h(label(item.status) || ''),
      },
    );
  };
  const libraryEmpty = (tab) =>
    '<div class="empty"><p>' +
    h(
      {
        sets: '아직 만든 이모티콘 세트가 없어요.',
        characters: '아직 만든 캐릭터가 없어요.',
        bookmarks: '북마크한 작품이 없어요.',
        purchases: '구매한 작품이 없어요.',
      }[tab] || '아직 내역이 없어요.',
    ) +
    '</p>' +
    (tab === 'characters'
      ? ui.link('첫 캐릭터 만들기', 'studio')
      : tab === 'sets'
        ? ui.link('새 세트 만들기', 'set-new')
        : tab === 'bookmarks'
          ? ui.link('커뮤니티 둘러보기', 'community')
          : ui.link('마켓 둘러보기', 'market')) +
    '</div>';

  // 보관함: 탭 없이 네 종류를 한 화면에 보여 준다. 더 있으면 "전체 보기"로 한 종류만 펼친다.
  async function library(params) {
    const actions =
      ui.link('새 캐릭터 만들기', 'studio') + ui.link('새 세트 만들기', 'set-new');
    if (params.tab && LIBRARY[params.tab]) {
      const tab = params.tab;
      return (
        pageHead(LIBRARY[tab].title, '', ui.link('← 보관함 전체', 'library') + actions) +
        (await ui.paginate(
          LIBRARY[tab].path,
          (items) =>
            '<div class="grid">' + items.map((raw) => libraryTile(raw, tab)).join('') + '</div>',
          { ...params, route: 'library' },
          { empty: libraryEmpty(tab) },
        ))
      );
    }
    const tabs = Object.keys(LIBRARY);
    const results = await Promise.all(
      tabs.map((tab) =>
        api(LIBRARY[tab].path + '?page=0&size=8').catch(() => ({ items: [], totalElements: 0 })),
      ),
    );
    return (
      pageHead('내 보관함', '내가 만든 것과 저장한 작품을 한곳에서 확인하세요.', actions) +
      tabs
        .map((tab, index) => {
          const data = results[index],
            total = data.totalElements ?? data.items.length;
          return (
            '<section class="lib-section"><div class="row between"><h2>' +
            h(LIBRARY[tab].title) +
            ' <span class="muted">' +
            h(total) +
            '</span></h2>' +
            (total > data.items.length
              ? ui.link('전체 보기', 'library', { tab })
              : '') +
            '</div>' +
            (data.items.length
              ? '<div class="grid">' + data.items.map((raw) => libraryTile(raw, tab)).join('') + '</div>'
              : libraryEmpty(tab)) +
            '</section>'
          );
        })
        .join('')
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
          h(label(c.status)) +
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
            '선택한 표정 생성',
          ),
      ) +
      (s.emoticons.some((e) => e.status === 'GENERATING')
        ? '<p class="muted" data-watch-set="' + h(s.id) + '" role="status">생성 중인 이모티콘이 있어요. 완성되는 대로 나타나요.</p>'
        : '') +
      (s.emoticons.length
        ? '<p class="muted top">이모티콘을 누르면 브러시로 부분 수정할 수 있어요.</p>'
        : '') +
      '<div class="grid">' +
      s.emoticons
        .map((e) =>
          e.status === 'READY'
            ? '<div class="tile-wrap">' +
              ui.tileDo(() => inpaint.open(e), {
                art: picture(e.thumbnailUrl || e.imageUrl, e.label),
                title: e.label,
              }) +
              ui.link('상세·버전·다운로드', 'editor', { id: e.id }) +
              '</div>'
            : '<div class="tile-wrap"><div class="tile tile-pending"><span class="art"><span class="thumb-skeleton"></span></span><strong class="tile-title">' +
              h(e.label) +
              '</strong><span class="muted">' +
              h(label(e.status)) +
              '</span></div></div>',
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
            '다시 만들기',
          ) +
          '<h2>부분 수정</h2><p class="muted">바꾸고 싶은 부분만 브러시로 칠하면 그 부분만 다시 그려요.</p>' +
          ui.action('브러시로 부분 수정', () => inpaint.open(e), true) +
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
      ui.schedule(() => ui.go('job', { id: watch.dataset.watchJob }), 2000);
    const watchSet = document.querySelector('[data-watch-set]');
    if (watchSet)
      ui.schedule(() => ui.go('set', { id: watchSet.dataset.watchSet }), 2500);
  }
  async function job(params) {
    const j = await api('/generations/' + id(params.id));
    const active = ['QUEUED', 'RUNNING'].includes(j.status);
    const delayed =
      j.status === 'QUEUED' && Date.now() - Date.parse(j.createdAt) >= 60000;
    // 이모티콘 결과는 눌러서 바로 브러시 수정, 그 밖에는 이미지만 보여 준다
    const editable = ['EMOTION_SET', 'EMOTION_REGENERATE', 'INPAINT'].includes(j.type);
    const result =
      j.result?.images
        ?.map((i, index) => {
          const art = picture(i.thumbnailUrl || i.imageUrl, '생성 결과 ' + (index + 1));
          return editable
            ? ui.tileDo(
                () =>
                  inpaint.open({
                    id: j.type === 'EMOTION_SET' ? i.id : j.targetId,
                    label: '생성 결과 ' + (index + 1),
                    imageUrl: i.imageUrl,
                  }),
                { art, title: '결과 ' + (index + 1), meta: '눌러서 부분 수정' },
              )
            : art;
        })
        .join('') || '';
    return (
      heading('생성 작업') +
      panel(
        '<p>' +
          h(label(j.status)) +
          ' · ' +
          h(j.progress || 0) +
          '%' +
          (j.result?.images?.length ? ' · ' + h(j.result.images.length) + '장 완료' : '') +
          '</p><p>대기 순번 ' +
          h(j.queuePosition) +
          ' · 비용 ' +
          h(j.creditCost) +
          ' 크레딧</p><p role="status">' +
          h(j.errorCode || '') +
          '</p>' +
          '<div class="grid">' +
          (delayed
            ? '<p role="status">아직 생성이 시작되지 않았어요. 대기가 계속되면 운영자에게 작업 수신 상태를 문의하거나 대기 취소를 선택해 주세요. 대기 취소 시 예약 크레딧은 반환됩니다.</p>'
            : '') +
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
                  h(label(j.type)) +
                  '<p class="muted">' +
                  h(label(j.status)) +
                  ' · ' +
                  h(j.creditCost) +
                  ' 크레딧</p></div>' +
                  ui.link('상태·결과', 'job', { id: j.jobId }) +
                  '</div>',
              )
              .join(''),
          ),
        { ...params, route: 'jobs' },
        {
          empty:
            '<div class="empty"><p>아직 생성한 작업이 없어요.</p>' +
            ui.link('이모티콘 만들러 가기', 'studio') +
            '</div>',
        },
      ))
    );
  }
  return {
    routes: { library, character, 'set-new': newSet, set, editor, job, jobs },
    mount,
  };
}
