import { api } from './api.js';
import {
  h,
  id,
  picture,
  heading,
  panel,
  field,
  money,
  date,
  allItems,
} from './service-ui.js';

export function createMarket(ui, payments) {
  function report(type, targetId) {
    ui.edit(
      '신고하기',
      field('reason', '사유', [
        ['COPYRIGHT', '저작권 침해'],
        ['INAPPROPRIATE', '부적절한 내용'],
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
  async function market(params) {
    const search = new URLSearchParams();
    if (params.keyword) search.set('keyword', params.keyword);
    if (params.type) search.set('type', params.type);
    return (
      heading('마켓', '작품과 제작 템플릿을 만나보세요.') +
      panel(
        ui.form(
          field('keyword', '검색', 'text', params.keyword, { optional: true }) +
            field(
              'type',
              '종류',
              [
                ['', '전체'],
                ['EMOTICON_SET', '이모티콘 세트'],
                ['PROMPT_TEMPLATE', '프롬프트 템플릿'],
                ['RECIPE_BUNDLE', '제작 레시피'],
              ],
              params.type,
              { optional: true },
            ),
          (data) => ui.go('market', data),
          '검색',
        ),
      ) +
      (await ui.paginate(
        '/products?' + search,
        (items) =>
          '<div class="grid">' +
          items
            .map(
              (p) =>
                '<article class="tile"><div class="art">' +
                picture(p.thumbnailUrl, p.title) +
                '</div><h3>' +
                h(p.title) +
                '</h3><p>' +
                money(p.price) +
                '</p><p class="muted">' +
                h(p.seller.nickname) +
                ' · 후기 ' +
                h(p.reviewCount) +
                '</p>' +
                ui.link('상품 보기', 'product', { id: p.id }) +
                '</article>',
            )
            .join('') +
          '</div>',
        { ...params, route: 'market' },
      ))
    );
  }
  async function product(params) {
    const p = await api('/products/' + id(params.id));
    let key = crypto.randomUUID();
    const reviews = await ui.paginate(
      '/products/' + id(p.id) + '/reviews',
      (items) =>
        panel(
          '<h2>후기</h2>' +
            items
              .map(
                (r) =>
                  '<div class="list-row"><div><strong>' +
                  h(r.author?.nickname) +
                  ' · ' +
                  h(r.rating) +
                  '점</strong><p>' +
                  h(r.content) +
                  '</p><small>' +
                  date(r.createdAt) +
                  '</small></div>' +
                  ui.action('후기 신고', () => report('REVIEW', r.id)) +
                  '</div>',
              )
              .join(''),
        ),
      { ...params, route: 'product' },
    );
    return (
      heading(p.title) +
      panel(
        '<div class="grid">' +
          p.previewImageUrls.map((url) => picture(url, p.title)).join('') +
          '</div><p>' +
          h(p.description) +
          '</p><p class="balance">' +
          money(p.price) +
          '</p><p>이용 범위 ' +
          h(p.licenseType) +
          ' · ' +
          h(p.licenseNote) +
          '</p>' +
          '<div class="row">' +
          ui.link(p.seller.nickname, 'user', { id: p.seller.id }) +
          ui.action('상품 신고', () => report('PRODUCT', p.id)) +
          (p.isMine
            ? ui.link('상품 관리', 'product-edit', { id: p.id })
            : p.isPurchased
              ? ui.action('구매 파일 다운로드', () => downloadProduct(p.id))
              : ui.action(
                  '구매하기',
                  () => payments.order('PRODUCT', p.id, key),
                  true,
                )) +
          (p.isPurchased && p.templateInfo
            ? ui.link('구매한 템플릿', 'template', { id: p.id })
            : '') +
          '</div>',
      ) +
      reviews +
      (p.isPurchased
        ? panel(
            ui.form(
              field(
                'rating',
                '별점',
                [
                  [5, '5점'],
                  [4, '4점'],
                  [3, '3점'],
                  [2, '2점'],
                  [1, '1점'],
                ],
                5,
              ) + field('content', '후기', 'textarea', '', { maxlength: 500 }),
              async (data) => {
                data.rating = Number(data.rating);
                await api('/products/' + id(p.id) + '/reviews', {
                  method: 'POST',
                  body: data,
                });
                ui.go('product', params);
              },
              '후기 등록',
            ),
          )
        : '')
    );
  }
  function downloadProduct(productId) {
    ui.dialog(
      '구매 작품 다운로드',
      ui.form(
        field('format', '형식', [
          ['ORIGINAL', '원본'],
          ['TRANSPARENT_PNG', '투명 PNG'],
          ['DISCORD', 'Discord'],
        ]),
        (data) =>
          ui.download(
            '/products/' + id(productId) + '/download?format=' + data.format,
          ),
        '다운로드',
        '<p class="muted">다운로드 시 이용 기록이 남아 환불이 제한될 수 있습니다.</p>',
      ),
    );
  }
  async function template(params) {
    if (!params.open)
      return (
        heading('구매한 제작 템플릿') +
        panel(
          '<p>템플릿 내용을 열면 이용 기록이 남아 환불이 제한될 수 있습니다.</p>' +
            ui.link('템플릿 내용 열기', 'template', { ...params, open: true }),
        )
      );
    const [t, sets] = await Promise.all([
      api('/products/' + id(params.id) + '/template'),
      allItems('/sets'),
    ]);
    const source = t.template || t;
    return (
      heading('구매한 제작 템플릿') +
      panel(
        '<h2>' +
          h(source.model) +
          ' ' +
          h(source.modelVersion) +
          '</h2><div class="terms">' +
          h(source.promptText) +
          '</div><p>' +
          h(source.postProcess) +
          '</p>' +
          ui.form(
            (source.variables || [])
              .map((v) =>
                field(v.key, v.label, 'text', v.defaultValue, {
                  optional: true,
                }),
              )
              .join('') +
              field(
                'setId',
                '적용할 세트',
                sets.items.map((s) => [s.id, s.title]),
              ) +
              field('emotion', '표정 라벨', 'text', '기쁨'),
            async (data, form) => {
              const { setId, emotion, ...variables } = data;
              const estimate = await api('/generations/estimates', {
                method: 'POST',
                body: { type: 'EMOTION_SET', count: 1 },
              });
              if (!estimate.sufficient) throw Error('크레딧이 부족합니다.');
              ui.confirm(
                '템플릿으로 생성',
                estimate.creditCost + ' 크레딧을 사용합니다.',
                async () => {
                  const job = await api('/sets/' + id(setId) + '/generations', {
                    method: 'POST',
                    idempotencyKey: ui.key(form),
                    body: {
                      emotions: [{ key: emotion }],
                      templateProductId: params.id,
                      variables,
                    },
                  });
                  ui.go('job', { id: job.jobId });
                },
              );
            },
            '템플릿 적용 비용 확인',
          ),
      )
    );
  }
  async function productEdit(params) {
    const p = params.id ? await api('/products/' + id(params.id)) : null;
    const sets = p ? null : await allItems('/sets');
    const fields =
      (!p
        ? field('type', '상품 종류', [
            ['EMOTICON_SET', '이모티콘 세트'],
            ['PROMPT_TEMPLATE', '프롬프트 템플릿'],
            ['RECIPE_BUNDLE', '제작 레시피'],
          ]) +
          field(
            'sourceSetId',
            '예시·판매 세트',
            sets.items.map((s) => [s.id, s.title]),
            params.setId,
          ) +
          field('licenseType', '사용 범위', [
            ['PERSONAL', '개인용'],
            ['COMMUNITY', '커뮤니티 운영 포함'],
          ])
        : '') +
      field('title', '제목', 'text', p?.title, { maxlength: 50 }) +
      field('description', '소개', 'textarea', p?.description, {
        maxlength: 2000,
      }) +
      field('price', '가격(원)', 'number', p?.price || 500, {
        min: 500,
        max: 100000,
      }) +
      field('licenseNote', '사용 안내', 'textarea', p?.licenseNote, {
        optional: true,
        maxlength: 500,
      }) +
      (!p
        ? '<details><summary>템플릿·레시피 상품 설정</summary><div class="stack">' +
          field('model', '모델', 'text', '', { optional: true }) +
          field('modelVersion', '모델 버전', 'text', '', { optional: true }) +
          field('promptText', '프롬프트 ({변수명} 사용 가능)', 'textarea', '', {
            optional: true,
          }) +
          field('variableNames', '변수명 (쉼표 구분)', 'text', '', {
            optional: true,
          }) +
          field(
            'requiresReferenceImage',
            '참고 이미지 필요',
            'checkbox',
            false,
            { optional: true },
          ) +
          field('postProcess', '후처리 안내', 'textarea', '', {
            optional: true,
          }) +
          '</div></details>'
        : '');
    return (
      heading(p ? '상품 수정' : '상품 등록') +
      panel(
        ui.form(
          fields,
          async (data) => {
            const {
              model,
              modelVersion,
              promptText,
              variableNames,
              requiresReferenceImage,
              postProcess,
              ...body
            } = data;
            if (!p && data.type !== 'EMOTICON_SET') {
              if (!model || !modelVersion || !promptText)
                throw Error('템플릿 모델·버전·프롬프트를 입력해 주세요.');
              body.template = {
                model,
                modelVersion,
                promptText,
                requiresReferenceImage: !!requiresReferenceImage,
                postProcess,
                settings: {},
                sampleSetId: data.sourceSetId,
                variables: String(variableNames || '')
                  .split(',')
                  .map((v) => v.trim())
                  .filter(Boolean)
                  .map((key) => ({ key, label: key, defaultValue: '' })),
              };
            }
            const result = await api(
              p ? '/products/' + id(p.id) : '/products',
              { method: p ? 'PATCH' : 'POST', body },
            );
            ui.go('product', { id: result.id });
          },
          '상품 저장',
        ) +
          (p
            ? ui.action('판매 중단', () =>
                ui.confirm(
                  '판매 중단',
                  '신규 판매를 중단합니다. 기존 구매자의 이용은 유지됩니다.',
                  async () => {
                    await api('/products/' + id(p.id), { method: 'DELETE' });
                    ui.go('creator');
                  },
                ),
              )
            : ''),
      )
    );
  }
  async function orders(params) {
    const tab = params.tab || 'orders';
    const menu =
      '<div class="row space">' +
      ui.link('주문 내역', 'orders') +
      ui.link('구매한 작품', 'library', { tab: 'purchases' }) +
      ui.link('보낸 후원', 'orders', { tab: 'sent' }) +
      ui.link('받은 후원', 'orders', { tab: 'received' }) +
      '</div>';
    return (
      heading('구매·후원') +
      menu +
      (await ui.paginate(
        tab === 'orders' ? '/orders' : '/donations/' + tab,
        (items) =>
          panel(
            items
              .map(
                (o) =>
                  '<div class="list-row"><div><strong>' +
                  h(
                    o.orderName ||
                      o.creator?.nickname ||
                      o.from?.nickname ||
                      '익명 후원',
                  ) +
                  '</strong><p class="muted">' +
                  date(o.createdAt) +
                  ' · ' +
                  h(o.status || '후원 완료') +
                  '</p><p>' +
                  h(o.message) +
                  '</p></div><div>' +
                  money(o.amount) +
                  (tab === 'orders'
                    ? ui.link('상세', 'order', { id: o.orderNo })
                    : '') +
                  '</div></div>',
              )
              .join(''),
          ),
        { ...params, route: 'orders' },
      ))
    );
  }
  async function order(params) {
    const o = await api('/orders/' + id(params.id));
    return (
      heading('주문 상세') +
      panel(
        '<h2>' +
          h(o.orderName) +
          '</h2><p>' +
          h(o.orderNo) +
          '</p><p>' +
          h(o.status) +
          ' · ' +
          money(o.amount) +
          '</p><p class="muted">주문 유효기간 ' +
          date(o.expiresAt) +
          '</p><div class="row">' +
          (o.status === 'PENDING_PAYMENT'
            ? ui.action('결제 계속하기', () => payments.checkout(o), true)
            : '') +
          (o.refundable || o.status === 'PENDING_PAYMENT'
            ? ui.action('취소·환불', () =>
                ui.edit(
                  '취소·환불 요청',
                  field('reason', '사유', 'textarea', '', { maxlength: 200 }),
                  async (data) => {
                    await api('/orders/' + id(o.orderNo) + '/cancel', {
                      method: 'POST',
                      body: data,
                    });
                    ui.go('order', params);
                  },
                  '취소·환불 요청',
                ),
              )
            : '') +
          '</div>',
      )
    );
  }
  return {
    market,
    product,
    template,
    'product-edit': productEdit,
    orders,
    order,
    payment: payments.callbackView,
  };
}
