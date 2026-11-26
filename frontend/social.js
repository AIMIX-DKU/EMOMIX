import { api } from './api.js';
import { label } from './labels.js';
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

export function createSocial(ui, payments) {
  const me = () =>
    api('/users/me').catch((error) => {
      if (error.status === 401) return null;
      throw error;
    });
  const tagList = (value) => [
    ...new Set(
      String(value || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
  function report(type, targetId) {
    ui.edit(
      '신고하기',
      field('reason', '사유', [
        ['COPYRIGHT', '저작권 침해'],
        ['INAPPROPRIATE', '부적절한 콘텐츠'],
        ['SPAM', '스팸'],
        ['FRAUD', '사기'],
        ['HARASSMENT', '괴롭힘'],
        ['OTHER', '기타'],
      ]) +
        field('detail', '상세 내용', 'textarea', '', {
          optional: true,
          maxlength: 500,
        }),
      async (data) => {
        await api('/reports', {
          method: 'POST',
          body: { ...data, targetType: type, targetId },
        });
        ui.notify('신고를 접수했습니다.');
      },
      '신고 접수',
    );
  }
  function cards(items) {
    return (
      '<div class="grid">' +
      items
        .map((p) =>
          ui.tile(
            'post',
            { id: p.id },
            {
              art: picture(p.thumbnailUrls?.[0] || p.thumbnailUrl, p.title),
              title: p.title,
              meta:
                h(p.author?.nickname) +
                ' · ♥ ' +
                h(p.likeCount || 0) +
                (p.commentCount !== undefined
                  ? ' · 댓글 ' + h(p.commentCount)
                  : ''),
            },
          ),
        )
        .join('') +
      '</div>'
    );
  }
  async function community(params) {
    const tags = (await api('/tags/popular')).items;
    const query = new URLSearchParams({
      keyword: params.keyword || '',
      sort: params.sort || 'LATEST',
    });
    if (params.tag) query.set('tag', params.tag);
    if (params.authorId) query.set('authorId', params.authorId);
    const sort = params.sort || 'LATEST';
    const pick = (next) =>
      next === 'RANKING'
        ? ui.go('rankings')
        : ui.go('community', { ...params, sort: next, page: 0 });
    return (
      pageHead(
        '커뮤니티',
        '작품과 프롬프트를 나눠보세요.',
        ui.link('작품 올리기', 'post-edit').replace('secondary', 'primary'),
      ) +
      '<div class="row between wrap">' +
      ui.segments(
        [
          ['LATEST', '최신'],
          ['POPULAR', '인기'],
          ['RANKING', '랭킹'],
        ],
        sort,
        pick,
      ) +
      ui.searchForm((data) => ui.go('community', { ...params, ...data, page: 0 }), {
        placeholder: '작품·제작자 검색',
        value: params.keyword || '',
      }) +
      '</div>' +
      (tags.length
        ? '<div class="row space">' +
          tags
            .map((t) => ui.link('#' + t.name, 'community', { tag: t.name }))
            .join('') +
          '</div>'
        : '') +
      (await ui.paginate('/posts?' + query, cards, { ...params, route: 'community' }, {
        empty: empty('아직 공유된 작품이 없어요. 첫 작품을 올려 보세요.'),
      }))
    );
  }
  async function post(params) {
    const [p, user] = await Promise.all([api('/posts/' + id(params.id)), me()]);
    const mine = user?.id === p.author.id;
    const comments = await ui.paginate(
      '/posts/' + id(p.id) + '/comments',
      (items) =>
        panel(
          '<h2>댓글</h2>' +
            items
              .map((c) => {
                const own = c.isMine;
                return (
                  '<article class="list-row"><div><strong>' +
                  h(c.author.nickname) +
                  '</strong><p>' +
                  h(c.content) +
                  '</p><small>' +
                  date(c.createdAt) +
                  '</small></div><div class="row">' +
                  (user && !c.parentId
                    ? ui.action('답글', () => commentForm(p.id, c.id))
                    : '') +
                  (own
                    ? ui.action('수정', () =>
                        ui.edit(
                          '댓글 수정',
                          field('content', '댓글', 'textarea', c.content, {
                            maxlength: 500,
                          }),
                          async (data) => {
                            await api('/comments/' + id(c.id), {
                              method: 'PATCH',
                              body: data,
                            });
                            ui.go('post', params);
                          },
                        ),
                      ) +
                      ui.action('삭제', () =>
                        ui.confirm(
                          '댓글 삭제',
                          '댓글을 삭제합니다.',
                          async () => {
                            await api('/comments/' + id(c.id), {
                              method: 'DELETE',
                            });
                            ui.go('post', params);
                          },
                        ),
                      )
                    : ui.action('신고', () => report('COMMENT', c.id))) +
                  '</div></article>'
                );
              })
              .join(''),
        ),
      { ...params, route: 'post' },
    );
    return (
      heading(p.title) +
      panel(
        '<div class="row">' +
          ui.link(p.author.nickname, 'user', { id: p.author.id }) +
          '<span>' +
          date(p.createdAt) +
          '</span></div><p>' +
          h(p.description) +
          '</p>' +
          '<div class="grid">' +
          p.emoticons.map((e) => picture(e.imageUrl, e.label)).join('') +
          '</div>' +
          (p.promptInfo
            ? '<details><summary>공개 프롬프트와 설정</summary><p>' +
              h(p.promptInfo.prompt) +
              '</p><p>' +
              h(p.promptInfo.model) +
              ' ' +
              h(p.promptInfo.modelVersion) +
              '</p></details>'
            : '') +
          '<div class="row">' +
          ui.action(
            p.isLiked ? '좋아요 취소' : '좋아요 ' + p.likeCount,
            async () => {
              await api('/posts/' + id(p.id) + '/likes', {
                method: p.isLiked ? 'DELETE' : 'POST',
              });
              ui.go('post', params);
            },
          ) +
          ui.action(p.isBookmarked ? '북마크 해제' : '북마크', async () => {
            await api('/posts/' + id(p.id) + '/bookmarks', {
              method: p.isBookmarked ? 'DELETE' : 'POST',
            });
            ui.go('post', params);
          }) +
          (mine
            ? ui.link('수정', 'post-edit', { id: p.id }) +
              ui.action('삭제', () =>
                ui.confirm(
                  '게시물 삭제',
                  '공유 게시물을 삭제합니다.',
                  async () => {
                    await api('/posts/' + id(p.id), { method: 'DELETE' });
                    ui.go('community');
                  },
                ),
              )
            : ui.action('신고', () => report('POST', p.id))) +
          (p.productId
            ? ui.link('관련 상품', 'product', { id: p.productId })
            : '') +
          '</div>',
      ) +
      comments +
      panel(
        ui.form(
          field('content', '댓글 작성', 'textarea', '', { maxlength: 500 }),
          async (data) => {
            await api('/posts/' + id(p.id) + '/comments', {
              method: 'POST',
              body: data,
            });
            ui.go('post', params);
          },
          '댓글 등록',
        ),
      )
    );
  }
  function commentForm(postId, parentId) {
    ui.edit(
      '답글',
      field('content', '내용', 'textarea', '', { maxlength: 500 }),
      async (data) => {
        await api('/posts/' + id(postId) + '/comments', {
          method: 'POST',
          body: { ...data, parentId },
        });
        ui.go('post', { id: postId });
      },
      '답글 등록',
    );
  }
  async function postEdit(params) {
    const p = params.id ? await api('/posts/' + id(params.id)) : null;
    const sets = p ? null : await allItems('/sets');
    return (
      heading(p ? '게시물 수정' : '작품 공유') +
      panel(
        ui.form(
          (!p
            ? field(
                'setId',
                '공유할 세트',
                sets.items.map((s) => [s.id, s.title]),
                params.setId,
              )
            : '') +
            field('title', '제목', 'text', p?.title, { maxlength: 50 }) +
            field('description', '소개', 'textarea', p?.description, {
              optional: true,
              maxlength: 1000,
            }) +
            field('tags', '태그 (쉼표로 구분)', 'text', p?.tags?.join(', '), {
              optional: true,
            }) +
            field(
              'sharePrompt',
              '프롬프트 공개',
              'checkbox',
              p?.promptInfo != null,
              { optional: true },
            ),
          async (data) => {
            data.tags = tagList(data.tags);
            if (data.tags.length > 5) throw Error('태그는 최대 5개입니다.');
            const result = await api(p ? '/posts/' + id(p.id) : '/posts', {
              method: p ? 'PATCH' : 'POST',
              body: data,
            });
            ui.go('post', { id: result.id });
          },
          p ? '수정 저장' : '공유하기',
        ),
      )
    );
  }
  async function user(params) {
    const p = await api('/users/' + id(params.id));
    return (
      heading(p.nickname, p.bio || '') +
      panel(
        picture(p.profileImageUrl, p.nickname) +
          '<p>팔로워 ' +
          h(p.followerCount) +
          ' · 팔로잉 ' +
          h(p.followingCount) +
          ' · 작품 ' +
          h(p.postCount) +
          '</p><div class="row">' +
          ui.action(p.isFollowing ? '언팔로우' : '팔로우', async () => {
            await api('/users/' + id(p.id) + '/follow', {
              method: p.isFollowing ? 'DELETE' : 'POST',
            });
            ui.go('user', params);
          }) +
          ui.link('작품 보기', 'community', { authorId: p.id }) +
          ui.action('신고', () => report('USER', p.id)) +
          (p.isCreator
            ? ui.action('후원', () =>
                ui.edit(
                  '창작자 후원',
                  field('amount', '후원 금액', 'number', 1000, {
                    min: 1000,
                    max: 100000,
                  }) +
                    field('message', '응원 메시지', 'textarea', '', {
                      optional: true,
                      maxlength: 100,
                    }) +
                    field('isAnonymous', '익명으로 후원', 'checkbox', false, {
                      optional: true,
                    }),
                  async (data, form) => {
                    const order = await api('/donations', {
                      method: 'POST',
                      idempotencyKey: ui.key(form),
                      body: { ...data, creatorId: p.id },
                    });
                    ui.close();
                    payments.orderDialog(order);
                  },
                  '후원 주문 만들기',
                  '<p class="muted">혜택 없는 후원이며, 후원 결제 후 환불되지 않습니다.</p>',
                ),
              )
            : '') +
          '</div>',
      )
    );
  }
  async function rankings(params) {
    const kind = params.kind || 'posts',
      period = params.period || 'WEEKLY';
    const items = (await api('/rankings/' + kind + '?period=' + period)).items;
    return (
      heading('랭킹') +
      panel(
        ui.form(
          field(
            'kind',
            '분야',
            [
              ['posts', '인기 이모티콘'],
              ['prompts', '인기 프롬프트'],
              ['creators', '인기 제작자'],
            ],
            kind,
          ) +
            field(
              'period',
              '기간',
              [
                ['DAILY', '오늘'],
                ['WEEKLY', '이번 주'],
                ['MONTHLY', '이번 달'],
              ],
              period,
            ),
          (data) => ui.go('rankings', data),
          '조회',
        ),
      ) +
      (items.length
        ? panel(
            items
              .map(
                (r, index) =>
                  '<div class="list-row"><div><strong>' +
                  h(r.rank || index + 1) +
                  ' · ' +
                  h(r.title || r.user?.nickname) +
                  '</strong><p class="muted">' +
                  h(r.usedCount ?? r.score ?? r.likeCount) +
                  '</p></div>' +
                  ui.link(
                    '보기',
                    kind === 'creators'
                      ? 'user'
                      : kind === 'prompts' && r.kind === 'PRODUCT'
                        ? 'product'
                        : 'post',
                    { id: r.user?.id || r.id },
                  ) +
                  '</div>',
              )
              .join(''),
          )
        : empty())
    );
  }
  async function reports(params) {
    return (
      heading('내 신고 내역') +
      (await ui.paginate(
        '/reports/me',
        (items) =>
          panel(
            items
              .map(
                (r) =>
                  '<div class="list-row"><div>' +
                  h(r.targetType) +
                  ' · ' +
                  h(r.reason) +
                  '<p>' +
                  h(r.detail) +
                  '</p><small>' +
                  date(r.createdAt) +
                  '</small></div><span>' +
                  h(label(r.status)) +
                  '</span></div>',
              )
              .join(''),
          ),
        { ...params, route: 'reports' },
      ))
    );
  }
  return { community, post, 'post-edit': postEdit, user, rankings, reports };
}
