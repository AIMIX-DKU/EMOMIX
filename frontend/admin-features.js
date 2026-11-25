import { api, ApiError } from './api.js';
import { h, id, heading, panel, field, money, date } from './service-ui.js';

export function createAdmin(ui) {
  const policyLabels = {
    sellerFeeRate: '판매 수수료율',
    pointToCreditRate: '포인트→크레딧 비율',
    monthlyPointEarnCap: '월 포인트 적립 한도',
    monthlyPointExchangeCap: '월 교환 한도',
    dailyGenerationLimit: '일 생성 한도',
    signupGrantCredits: '가입 크레딧',
    maxQueueLength: '최대 대기열',
    minSettlementAmount: '최소 정산 금액',
  };
  async function admin(params) {
    const user = await api('/users/me');
    if (user.role !== 'ADMIN')
      throw new ApiError('관리자 권한이 필요합니다.', 403, 'FORBIDDEN');
    const tab = params.tab || 'reports';
    const menu =
      '<div class="row space">' +
      [
        'reports',
        'users',
        'contents',
        'credits',
        'stats',
        'policies',
        'settlements',
      ]
        .map((key, i) =>
          ui.link(
            [
              '신고',
              '사용자',
              '콘텐츠',
              '크레딧 지급',
              '생성 통계',
              '운영 정책',
              '정산',
            ][i],
            'admin',
            { tab: key },
          ),
        )
        .join('') +
      '</div>';
    let body = '';
    if (tab === 'reports')
      body = await ui.paginate(
        '/admin/reports',
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
                  h(r.status) +
                  '</p></div>' +
                  ui.action('상세·처리', async () => {
                    const detail = await api(
                      '/admin/reports/' + id(r.reportId),
                    );
                    ui.edit(
                      '신고 처리',
                      '<div class="terms">' +
                        Object.entries(detail.targetSnapshot)
                          .map(
                            ([key, value]) =>
                              '<p>' + h(key) + ' · ' + h(value) + '</p>',
                          )
                          .join('') +
                        '</div>' +
                        field('action', '처리', [
                          ['DISMISS', '기각'],
                          ['HIDE_CONTENT', '숨김'],
                          ['WARN', '경고'],
                          ['SUSPEND_USER', '사용자 정지'],
                        ]) +
                        field('note', '처리 메모', 'textarea', '', {
                          optional: true,
                          maxlength: 500,
                        }),
                      async (data) => {
                        await api('/admin/reports/' + id(r.reportId), {
                          method: 'PATCH',
                          body: data,
                        });
                        ui.go('admin', params);
                      },
                      '처리',
                    );
                  }) +
                  '</div>',
              )
              .join(''),
          ),
        { ...params, route: 'admin' },
      );
    if (tab === 'users')
      body =
        panel(
          ui.form(
            field('keyword', '닉네임·이메일 검색', 'text', params.keyword, {
              optional: true,
            }),
            (data) => ui.go('admin', { ...data, tab }),
            '검색',
          ),
        ) +
        (await ui.paginate(
          '/admin/users?keyword=' + id(params.keyword || ''),
          (items) =>
            panel(
              items
                .map(
                  (u) =>
                    '<div class="list-row"><div>' +
                    h(u.nickname) +
                    ' · ' +
                    h(u.status) +
                    '<p>' +
                    h(u.email) +
                    '</p></div><div class="row">' +
                    ui.action('정지', () =>
                      ui.edit(
                        '사용자 정지',
                        field('reason', '사유', 'textarea', '', {
                          maxlength: 300,
                        }) +
                          field('until', '해제 일시', 'datetime-local', '', {
                            optional: true,
                          }),
                        async (data) => {
                          if (data.until)
                            data.until = new Date(data.until).toISOString();
                          await api(
                            '/admin/users/' + id(u.id) + '/suspension',
                            { method: 'POST', body: data },
                          );
                          ui.go('admin', params);
                        },
                        '정지',
                      ),
                    ) +
                    ui.action('정지 해제', () =>
                      ui.confirm(
                        '정지 해제',
                        u.nickname + '님의 정지를 해제합니다.',
                        async () => {
                          await api(
                            '/admin/users/' + id(u.id) + '/suspension',
                            { method: 'DELETE' },
                          );
                          ui.go('admin', params);
                        },
                      ),
                    ) +
                    '</div></div>',
                )
                .join(''),
            ),
          { ...params, route: 'admin' },
        ));
    if (tab === 'contents')
      body = panel(
        ui.form(
          field('targetType', '콘텐츠 종류', [
            ['POST', '게시물'],
            ['COMMENT', '댓글'],
            ['PRODUCT', '상품'],
            ['REVIEW', '후기'],
          ]) +
            field('targetId', '콘텐츠 ID') +
            field('hidden', '숨김 처리', 'checkbox', true, { optional: true }) +
            field('reason', '처리 사유', 'textarea', '', { maxlength: 300 }),
          async (data) => {
            await api(
              '/admin/contents/' +
                id(data.targetType) +
                '/' +
                id(data.targetId) +
                '/visibility',
              {
                method: 'PATCH',
                body: { hidden: data.hidden, reason: data.reason },
              },
            );
            ui.notify('공개 상태를 변경했습니다.');
          },
          '공개 상태 변경',
        ),
      );
    if (tab === 'credits')
      body = panel(
        ui.form(
          field('userId', '사용자 ID') +
            field('amount', '지급 크레딧', 'number', 1, {
              min: 1,
              max: 100000,
            }) +
            field('reason', '사유', 'textarea', '', { maxlength: 300 }),
          async (data, form) => {
            await api('/admin/credits/grants', {
              method: 'POST',
              body: data,
              idempotencyKey: ui.key(form),
            });
            ui.notify('크레딧을 지급했습니다.');
            form.reset();
            delete form.dataset.requestKey;
          },
          '지급',
        ),
      );
    if (tab === 'policies') {
      const values = await api('/admin/policies');
      body = panel(
        ui.form(
          Object.entries(policyLabels)
            .map(([key, label]) =>
              field(key, label, 'number', values[key], {
                min: 0,
                step: key.includes('Rate') ? '0.001' : 1,
              }),
            )
            .join(''),
          (data) => {
            ui.confirm(
              '정책 변경',
              '입력한 운영 정책을 적용합니다.',
              async () => {
                await api('/admin/policies', { method: 'PUT', body: data });
                ui.go('admin', params);
              },
            );
          },
          '변경 검토',
        ),
      );
    }
    if (tab === 'stats') {
      const from =
          params.from || new Date(Date.now() - 7 * 86400000).toISOString(),
        to = params.to || new Date().toISOString();
      const stats = await api(
        '/admin/generations/stats?from=' + id(from) + '&to=' + id(to),
      );
      body = panel(
        ui.form(
          field('from', '시작', 'datetime-local', from.slice(0, 16)) +
            field('to', '종료', 'datetime-local', to.slice(0, 16)),
          (data) =>
            ui.go('admin', {
              tab,
              from: new Date(data.from).toISOString(),
              to: new Date(data.to).toISOString(),
            }),
          '기간 조회',
        ) +
          '<h2>생성 현황</h2>' +
          Object.entries(stats)
            .filter(
              ([key, value]) => key !== 'daily' && typeof value !== 'object',
            )
            .map(([key, value]) => '<p>' + h(key) + ' · ' + h(value) + '</p>')
            .join('') +
          (stats.daily || [])
            .map(
              (day) =>
                '<div class="list-row">' +
                h(day.date) +
                ' · 생성 ' +
                h(day.jobs) +
                ' · 실패 ' +
                h(day.failed) +
                '</div>',
            )
            .join(''),
      );
    }
    if (tab === 'settlements')
      body = await ui.paginate(
        '/admin/settlements',
        (items) =>
          panel(
            items
              .map(
                (s) =>
                  '<div class="list-row"><div>' +
                  h(s.creatorId) +
                  '<p>' +
                  h(s.status) +
                  ' · ' +
                  money(s.amount) +
                  ' · ' +
                  date(s.requestedAt) +
                  '</p></div>' +
                  ui.action('처리', () =>
                    ui.edit(
                      '정산 처리',
                      field('status', '상태', [
                        ['APPROVED', '승인'],
                        ['REJECTED', '반려'],
                        ['PAID', '모의 지급 완료'],
                      ]) +
                        field('note', '메모', 'textarea', '', {
                          optional: true,
                          maxlength: 300,
                        }),
                      async (data) => {
                        await api('/admin/settlements/' + id(s.id), {
                          method: 'PATCH',
                          body: data,
                        });
                        ui.go('admin', params);
                      },
                      '처리',
                    ),
                  ) +
                  '</div>',
              )
              .join(''),
          ),
        { ...params, route: 'admin' },
      );
    return heading('관리자') + menu + body;
  }
  return { admin };
}
