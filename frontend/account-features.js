import { api } from './api.js';
import { label, cardCompany } from './labels.js';
import {
  h,
  id,
  heading,
  panel,
  field,
  empty,
  money,
  date,
} from './service-ui.js';

export function createAccount(ui, payments) {
  const reload = (page, params = {}) => ui.go(page, params);
  const save = async (path, method, body, page) => {
    await api(path, { method, body });
    ui.notify('저장했습니다.');
    if (page) reload(page);
  };
  const accountFields = () =>
    field('bankName', '은행명') +
    field('accountHolder', '예금주') +
    field('accountNumber', '모의 계좌번호', 'text', '', {
      help: '시제품 정산에는 가상 계좌 정보를 입력하세요.',
    });
  function creatorForm(existing = false) {
    return ui.form(
      accountFields() +
        (!existing
          ? field('agree', '창작자 약관에 동의합니다.', 'checkbox')
          : ''),
      async (data) =>
        save(
          '/creators/me',
          existing ? 'PATCH' : 'POST',
          {
            payoutAccount: {
              bankName: data.bankName,
              accountHolder: data.accountHolder,
              accountNumber: data.accountNumber,
            },
            ...(!existing ? { agreedTermIds: ['term-creator'] } : {}),
          },
          'creator',
        ),
      existing ? '정산 계좌 변경' : '창작자 등록',
    );
  }
  async function security() {
    const identities = await api('/users/me/identities');
    return (
      heading('계정·보안') +
      panel(
        '<h2>비밀번호 변경</h2>' +
          ui.form(
            field('currentPassword', '현재 비밀번호', 'password') +
              field('newPassword', '새 비밀번호', 'password', '', {
                help: '8자 이상, 영문·숫자·특수문자를 포함해 주세요.',
              }),
            (data) => save('/users/me/password', 'PUT', data),
            '비밀번호 변경',
          ) +
          '<h2>로그인 수단</h2>' +
          identities.items
            .map(
              (item) =>
                '<div class="list-row"><span>' +
                h(item.provider) +
                ' · ' +
                h(item.identifier) +
                '</span>' +
                ui.action('연동 해제', () =>
                  ui.confirm(
                    '연동 해제',
                    '마지막 로그인 수단은 해제할 수 없습니다.',
                    () =>
                      save(
                        '/users/me/identities/' + id(item.provider),
                        'DELETE',
                        undefined,
                        'security',
                      ),
                  ),
                ) +
                '</div>',
            )
            .join('') +
          ui.action('Discord 연동', () => {
            location.href = '/api/v1/auth/discord?mode=LINK&redirectPath=/';
          }) +
          ui.link('약관·회원 탈퇴', 'agreements'),
      )
    );
  }
  async function settings() {
    const data = await api('/users/me/settings');
    const labels = {
      comment: '댓글·답글',
      like: '좋아요',
      follow: '팔로우',
      sale: '판매·후원',
      generation: '생성 완료·실패',
      marketing: '마케팅 수신',
    };
    return (
      heading('알림 설정') +
      panel(
        ui.form(
          Object.entries(labels)
            .map(([key, label]) =>
              field(key, label, 'checkbox', data.notifications[key], {
                optional: true,
              }),
            )
            .join(''),
          (data) =>
            save('/users/me/settings', 'PATCH', { notifications: data }),
          '설정 저장',
        ),
      )
    );
  }
  async function agreements() {
    const user = await api('/users/me');
    const terms = (await api('/terms')).items.filter(
      (t) => user.isCreator || t.type !== 'CREATOR',
    );
    return (
      heading('약관·회원 탈퇴') +
      panel(
        ui.form(
          terms
            .map(
              (t) =>
                field(
                  t.id,
                  t.title + (t.required ? ' (필수)' : ' (선택)'),
                  'checkbox',
                  t.required,
                  { optional: !t.required },
                ) +
                ui.action('약관 내용', async () => {
                  const detail = await api('/terms/' + id(t.id));
                  ui.dialog(
                    detail.title,
                    '<div class="terms">' + h(detail.content) + '</div>',
                  );
                }),
            )
            .join(''),
          (data) =>
            save('/users/me/agreements', 'PUT', {
              agreedTermIds: terms.filter((t) => data[t.id]).map((t) => t.id),
            }),
          '선택한 동의 상태 저장',
          '<p class="muted">필수 항목은 동의해야 합니다. 선택 항목을 포함해 현재 선택한 전체 상태로 저장합니다.</p>',
        ) +
          '<h2>회원 탈퇴</h2>' +
          ui.form(
            field('confirmText', '확인을 위해 탈퇴를 입력하세요.'),
            async (data) => {
              if (data.confirmText !== '탈퇴')
                throw Error('탈퇴를 정확히 입력해 주세요.');
              await api('/users/me', { method: 'DELETE', body: data });
              location.assign('/');
            },
            '탈퇴 신청',
          ),
      )
    );
  }
  async function discordSignup() {
    const terms = (await api('/terms')).items.filter(
      (t) => t.type !== 'CREATOR',
    );
    return (
      heading('Discord 가입 완료') +
      panel(
        ui.form(
          field('nickname', '닉네임') +
            terms
              .map((t) =>
                field(t.id, t.title, 'checkbox', false, {
                  optional: !t.required,
                }),
              )
              .join(''),
          async (data) => {
            await api('/auth/discord/signup', {
              method: 'POST',
              body: {
                nickname: data.nickname,
                agreedTermIds: terms.filter((t) => data[t.id]).map((t) => t.id),
              },
            });
            history.replaceState(null, '', '/');
            location.assign('/');
          },
          '가입 완료',
        ),
      )
    );
  }
  async function notifications(params) {
    const count = await api('/notifications/unread-count');
    const list = await ui.paginate(
      '/notifications' + (params.unread ? '?unreadOnly=true' : ''),
      (items) =>
        panel(
          items
            .map(
              (n) =>
                '<article class="list-row"><div><strong>' +
                h(n.title) +
                '</strong><p>' +
                h(n.body) +
                '</p><small>' +
                date(n.createdAt) +
                (n.isRead ? ' · 읽음' : ' · 안 읽음') +
                '</small></div><div class="row">' +
                ui.action('열기', () => {
                  const routes = {
                    POST: 'post',
                    USER: 'user',
                    PRODUCT: 'product',
                    SET: 'set',
                    GENERATION: 'job',
                    JOB: 'job',
                    EMOTICON: 'editor',
                    REPORT: 'reports',
                    SETTLEMENT: 'creator',
                  };
                  if (routes[n.targetType] && n.targetId)
                    ui.go(routes[n.targetType], { id: n.targetId });
                  else
                    ui.dialog(n.title, '<p>' + h(n.body || n.title) + '</p>');
                }) +
                (!n.isRead
                  ? ui.action('읽음', () =>
                      save(
                        '/notifications/' + id(n.id) + '/read',
                        'PATCH',
                        undefined,
                        'notifications',
                      ),
                    )
                  : '') +
                ui.action('삭제', () =>
                  save(
                    '/notifications/' + id(n.id),
                    'DELETE',
                    undefined,
                    'notifications',
                  ),
                ) +
                '</div></article>',
            )
            .join(''),
        ),
      { ...params, route: 'notifications' },
      { empty: empty(params.unread ? '안 읽은 알림이 없어요.' : '새 알림이 없어요. 좋아요, 댓글, 결제 소식이 여기에 모여요.') },
    );
    return (
      heading('알림', '안 읽은 알림 ' + count.count + '개') +
      '<div class="row space">' +
      ui.action('전체 읽음', () =>
        save('/notifications/read-all', 'POST', undefined, 'notifications'),
      ) +
      ui.link(params.unread ? '모두 보기' : '안 읽은 알림만', 'notifications', {
        unread: !params.unread,
      }) +
      '</div>' +
      list
    );
  }
  async function wallet(params) {
    const data = await api('/wallet');
    const tab = params.tab || 'credit';
    const menus =
      '<div class="row space">' +
      ui.link('크레딧 내역', 'wallet', { tab: 'credit' }) +
      ui.link('포인트 내역', 'wallet', { tab: 'point' }) +
      ui.link('보상 규칙', 'wallet', { tab: 'rewards' }) +
      '</div>';
    const history =
      tab === 'rewards'
        ? panel(
            (await api('/rewards/rules')).rules
              .map(
                (r) =>
                  '<div class="list-row"><span>' +
                  h(r.label || r.key || r.rule) +
                  '</span><span>' +
                  h(r.points || r.amount || 0) +
                  ' 포인트</span></div>',
              )
              .join(''),
          )
        : await ui.paginate(
            '/wallet/' +
              (tab === 'point' ? 'point' : 'credit') +
              '-transactions',
            (items) =>
              panel(
                items
                  .map(
                    (r) =>
                      '<div class="list-row"><div>' +
                      h(r.reason || label(r.type)) +
                      '<small> · ' +
                      date(r.createdAt) +
                      '</small></div><strong>' +
                      h(r.amount) +
                      '</strong></div>',
                  )
                  .join(''),
              ),
            { ...params, route: 'wallet' },
          );
    const packages = (await api('/credit-packages')).items;
    return (
      heading('지갑·충전') +
      panel(
        '<p class="balance">' +
          h(data.credit.balance) +
          ' 크레딧</p><p>예약 ' +
          h(data.credit.reserved) +
          ' 크레딧 · 활동 ' +
          h(data.activityPoint.balance) +
          ' 포인트</p>' +
          ui.link('구독 요금제', 'subscription') +
          ui.form(
            field('points', '교환할 포인트', 'number', 100, {
              min: 100,
              step: 100,
              help: '서버 정책의 비율과 월간 한도가 적용됩니다.',
            }),
            async (values, form) => {
              await api('/wallet/point-exchanges', {
                method: 'POST',
                body: values,
                idempotencyKey: ui.key(form),
              });
              ui.go('wallet');
              ui.notify('교환했습니다.');
            },
            '포인트 교환',
          ) +
          '<h2>크레딧 패키지</h2>' +
          packages
            .map((pkg) => {
              let key = crypto.randomUUID();
              return (
                '<div class="list-row"><span>' +
                h(pkg.name) +
                ' · ' +
                h(pkg.credits) +
                ' 크레딧 · ' +
                money(pkg.price) +
                '</span>' +
                ui.action('충전', () =>
                  payments.order('CREDIT_PACKAGE', pkg.id, key),
                ) +
                '</div>'
              );
            })
            .join(''),
      ) +
      menus +
      history
    );
  }
  async function subscription(params) {
    const [plans, state] = await Promise.all([
      api('/subscription-plans'),
      api('/subscriptions/me'),
    ]);
    const invoices = await ui.paginate(
      '/subscriptions/me/invoices',
      (items) =>
        panel(
          '<h2>구독 청구서</h2>' +
            items
              .map(
                (i) =>
                  '<div class="list-row"><div>' +
                  h(label(i.planCode)) +
                  ' · ' +
                  h(label(i.status)) +
                  '<p class="muted">' +
                  date(i.periodStart) +
                  ' ~ ' +
                  date(i.periodEnd) +
                  '</p><p>' +
                  h(i.failReason) +
                  '</p></div><span>' +
                  money(i.amount) +
                  '</span></div>',
              )
              .join(''),
        ),
      { ...params, route: 'subscription' },
    );
    const sub = state.subscription;
    return (
      heading('구독 관리', '요금·생성 한도·우선 대기열을 확인하세요.') +
      '<div class="grid">' +
      plans.items
        .map((p) =>
          panel(
            '<h2>' +
              h(p.name) +
              (state.plan.code === p.code ? ' <span class="badge ok">이용 중</span>' : '') +
              '</h2><p class="balance">' +
              money(p.price) +
              '</p><p>' +
              (p.monthlyCredits ? '월 ' + h(p.monthlyCredits) + ' 크레딧' : '구독 크레딧 없음') +
              ' · 일 ' +
              h(p.dailyGenerationLimit) +
              '회</p><p>우선 대기열 ' +
              (p.priorityQueue ? '제공' : '미제공') +
              ' · 판매 수수료 ' +
              Number(p.sellerFeeRate * 100).toFixed(1) +
              '%</p>' +
              (p.code === 'FREE' || state.plan.code === p.code
                ? '<p class="muted">' + (p.code === 'FREE' ? '기본 요금제' : '현재 이용 중인 요금제') + '</p>'
                : sub
                  ? ui.action('다음 결제일부터 변경', () =>
                      ui.confirm(
                        '요금제 변경',
                        p.name + ' 요금제로 변경 예약합니다.',
                        () =>
                          save(
                            '/subscriptions/me',
                            'PATCH',
                            { planCode: p.code },
                            'subscription',
                          ),
                      ),
                    )
                  : ui.action(
                      '카드 등록 후 구독',
                      () => payments.billing(p.code),
                      true,
                    )),
          ),
        )
        .join('') +
      '</div>' +
      panel(
        '<h2>현재 구독</h2><p>' +
          h(state.plan.name) +
          '</p>' +
          (sub
            ? '<p>' +
              h(label(sub.status)) +
              (sub.cancelAtPeriodEnd
                ? ' · ' + date(sub.currentPeriodEnd) + '에 해지됩니다'
                : ' · 다음 결제 ' + date(sub.nextBillingAt)) +
              '</p><p>카드 ' +
              h(cardCompany(sub.card.company)) +
              ' ' +
              h(sub.card.numberMasked) +
              '</p><p>변경 예약 ' +
              h(sub.scheduledPlanCode || '없음') +
              '</p><div class="row">' +
              ui.action('결제 카드 변경', () =>
                payments.billing(sub.planCode, true),
              ) +
              (sub.cancelAtPeriodEnd
                ? ui.action('해지 예약 취소', () =>
                    save(
                      '/subscriptions/me/resume',
                      'POST',
                      undefined,
                      'subscription',
                    ),
                  )
                : ui.action('기간 종료 시 해지', () =>
                    ui.confirm(
                      '구독 해지',
                      '현재 이용 기간이 끝날 때 해지됩니다.',
                      () =>
                        save(
                          '/subscriptions/me',
                          'DELETE',
                          undefined,
                          'subscription',
                        ),
                    ),
                  )) +
              '</div>'
            : '<p>유료 구독을 이용 중이지 않습니다.</p>'),
      ) +
      invoices
    );
  }
  async function creator(params) {
    const me = await api('/users/me');
    if (!me.isCreator) {
      const terms = (await api('/terms')).items.filter(
        (t) => t.type === 'CREATOR',
      );
      return (
        heading('창작자 등록') +
        panel(
          terms
            .map((t) =>
              ui.action(t.title, async () => {
                const d = await api('/terms/' + id(t.id));
                ui.dialog(
                  d.title,
                  '<div class="terms">' + h(d.content) + '</div>',
                );
              }),
            )
            .join('') + creatorForm(),
        )
      );
    }
    const menu =
      '<div class="row space">' +
      ['products', 'sales', 'ledger', 'settlements', 'account', 'donations']
        .map((key, i) =>
          ui.link(
            [
              '판매 상품',
              '판매 내역',
              '판매 장부',
              '정산',
              '정산 계좌',
              '받은 후원',
            ][i],
            'creator',
            { tab: key },
          ),
        )
        .join('') +
      '</div>';
    const tab = params.tab || 'products';
    if (tab === 'account') {
      const data = await api('/creators/me');
      return (
        heading('창작자 센터') +
        menu +
        panel(
          '<p>' +
            h(data.payoutAccount.bankName) +
            ' · ' +
            h(data.payoutAccount.accountNumberMasked) +
            '</p>' +
            creatorForm(true),
        )
      );
    }
    if (tab === 'products')
      return (
        heading('판매 상품') +
        menu +
        ui.link('상품 등록', 'product-edit') +
        (await ui.paginate(
          '/seller/products',
          (items) =>
            panel(
              items
                .map(
                  (p) =>
                    '<div class="list-row"><div>' +
                    h(p.title) +
                    ' · ' +
                    money(p.price) +
                    ' · ' +
                    h(label(p.status)) +
                    '</div>' +
                    ui.link('관리', 'product-edit', { id: p.id }) +
                    '</div>',
                )
                .join(''),
            ),
          { ...params, route: 'creator' },
        ))
      );
    if (tab === 'settlements') {
      const balance = await api('/seller/balance');
      return (
        heading('정산') +
        menu +
        panel(
          '<p>정산 가능 ' +
            money(balance.availableAmount) +
            '</p>' +
            ui.form(
              field('amount', '신청 금액', 'number', '', { min: 1 }),
              async (data, form) => {
                await api('/seller/settlements', {
                  method: 'POST',
                  body: data,
                  idempotencyKey: ui.key(form),
                });
                ui.go('creator', { tab });
              },
              '정산 요청',
            ),
        ) +
        (await ui.paginate(
          '/seller/settlements',
          (items) =>
            panel(
              items
                .map(
                  (r) =>
                    '<div class="list-row">' +
                    money(r.amount) +
                    ' · ' +
                    h(label(r.status)) +
                    ' · ' +
                    date(r.createdAt) +
                    '</div>',
                )
                .join(''),
            ),
          { ...params, route: 'creator' },
        ))
      );
    }
    const path = tab === 'donations' ? '/donations/received' : '/seller/' + tab;
    return (
      heading('창작자 센터') +
      menu +
      (await ui.paginate(
        path,
        (items) =>
          panel(
            items
              .map(
                (r) =>
                  '<div class="list-row"><div>' +
                  h(r.productTitle || r.type || r.from?.nickname || '익명') +
                  '<p class="muted">' +
                  date(r.createdAt) +
                  ' ' +
                  h(label(r.status)) +
                  '</p></div><span>' +
                  money(r.amount) +
                  ' ' +
                  (r.net !== undefined ? '순수익 ' + money(r.net) : '') +
                  '</span></div>',
              )
              .join(''),
          ),
        { ...params, route: 'creator' },
      ))
    );
  }
  return {
    security,
    settings,
    agreements,
    'discord-signup': discordSignup,
    notifications,
    wallet,
    subscription,
    creator,
  };
}
