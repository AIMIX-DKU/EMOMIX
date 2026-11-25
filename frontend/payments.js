import { api } from './api.js';
import { heading, panel, h, money } from './service-ui.js';

let sdkPromise;
async function paymentClient(forBilling = false) {
  const mainKey = import.meta.env.VITE_TOSS_CLIENT_KEY;
  const key = forBilling
    ? import.meta.env.VITE_TOSS_BILLING_CLIENT_KEY ||
      (/^(test|live)_ck_/.test(mainKey || '') ? mainKey : '')
    : mainKey;
  if (!key)
    throw new Error(
      forBilling
        ? '구독 카드 등록용 공개 키(VITE_TOSS_BILLING_CLIENT_KEY)가 필요합니다.'
        : '결제 클라이언트 키가 아직 설정되지 않았습니다. 운영자에게 문의해 주세요.',
    );
  if (forBilling && !/^(test|live)_ck_/.test(key))
    throw new Error(
      '카드 등록에는 API 개별 연동용 공개 키(test_ck 또는 live_ck)가 필요합니다.',
    );
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://js.tosspayments.com/v2/standard';
      script.onload = resolve;
      script.onerror = () => {
        sdkPromise = undefined;
        script.remove();
        reject(new Error('결제창을 불러오지 못했습니다.'));
      };
      document.head.append(script);
    });
  }
  await sdkPromise;
  return {
    sdk: window.TossPayments(key),
    widget: /^(test|live)_gck_/.test(key),
  };
}
const callback = (name) =>
  location.origin + location.pathname + '?payment=' + name;
const storageKey = 'emomix-payment';
const read = () => JSON.parse(sessionStorage.getItem(storageKey) || 'null');
const write = (value) =>
  sessionStorage.setItem(storageKey, JSON.stringify(value));

export function createPayments(ui) {
  async function checkout(order) {
    const { sdk, widget } = await paymentClient();
    const user = await api('/users/me');
    write({
      kind: 'order',
      orderNo: order.orderNo,
      amount: order.amount,
      userId: user.id,
      key: read()?.orderNo === order.orderNo ? read().key : crypto.randomUUID(),
    });
    const request = {
      orderId: order.orderNo,
      orderName: order.orderName,
      successUrl: callback('success'),
      failUrl: callback('fail'),
    };
    if (widget) {
      const widgets = sdk.widgets({ customerKey: user.id });
      await widgets.setAmount({ currency: 'KRW', value: order.amount });
      const suffix = crypto.randomUUID();
      const methodsId = 'payment-methods-' + suffix,
        agreementId = 'payment-agreement-' + suffix;
      const body = ui.dialog(
        '결제수단 선택',
        '<p class="balance">' +
          money(order.amount) +
          '</p><div id="' +
          methodsId +
          '"></div><div id="' +
          agreementId +
          '"></div>' +
          ui.action('결제하기', () => widgets.requestPayment(request), true),
      );
      const submit = body.querySelector('[data-do]');
      submit.disabled = true;
      await Promise.all([
        widgets.renderPaymentMethods({
          selector: '#' + methodsId,
          variantKey: import.meta.env.VITE_TOSS_PAYMENT_VARIANT || 'DEFAULT',
        }),
        widgets.renderAgreement({
          selector: '#' + agreementId,
          variantKey:
            import.meta.env.VITE_TOSS_AGREEMENT_VARIANT || 'AGREEMENT',
        }),
      ]);
      if (submit.isConnected) submit.disabled = false;
      return;
    }
    await sdk.payment({ customerKey: user.id }).requestPayment({
      ...request,
      method: 'CARD',
      amount: { currency: 'KRW', value: order.amount },
    });
  }
  async function billing(planCode, changeCard = false) {
    const { sdk } = await paymentClient(true);
    const [state, user] = await Promise.all([
      api('/subscriptions/me'),
      api('/users/me'),
    ]);
    write({
      kind: changeCard ? 'card' : 'subscription',
      planCode,
      customerKey: state.customerKey,
      userId: user.id,
      key: crypto.randomUUID(),
    });
    await sdk.payment({ customerKey: state.customerKey }).requestBillingAuth({
      method: 'CARD',
      successUrl: callback('billing'),
      failUrl: callback('fail'),
    });
  }
  function orderDialog(order) {
    ui.dialog(
      '주문 확인',
      panel(
        '<h3>' +
          h(order.orderName) +
          '</h3><p class="balance">' +
          money(order.amount) +
          '</p><p class="muted">주문번호 ' +
          h(order.orderNo) +
          '</p>' +
          ui.action('결제창 열기', () => checkout(order), true),
      ),
    );
  }
  async function order(type, targetId, key) {
    await paymentClient();
    const result = await api('/orders', {
      method: 'POST',
      idempotencyKey: key,
      body: {
        type,
        ...(type === 'PRODUCT'
          ? { productId: targetId }
          : { packageId: targetId }),
      },
    });
    orderDialog(result);
  }
  async function callbackView() {
    const params = new URLSearchParams(location.search);
    if (params.get('payment') === 'fail')
      return (
        heading('결제를 완료하지 못했어요') +
        panel(
          '<p>' +
            h(params.get('message') || '결제가 취소되었습니다.') +
            '</p>' +
            ui.link('주문 내역', 'orders'),
        )
      );
    const pending = read();
    if (!pending)
      throw new Error(
        '이 브라우저의 결제 요청 정보를 찾을 수 없습니다. 주문 내역을 확인해 주세요.',
      );
    const user = await api('/users/me');
    if (pending.userId !== user.id)
      throw new Error('결제를 시작한 계정으로 로그인해 주세요.');
    const confirm = async () => {
      if (params.get('payment') === 'success') {
        const orderNo = params.get('orderId');
        const serverOrder = await api('/orders/' + encodeURIComponent(orderNo));
        if (
          pending.orderNo !== orderNo ||
          Number(params.get('amount')) !== serverOrder.amount ||
          pending.amount !== serverOrder.amount
        )
          throw new Error('주문 금액이 일치하지 않습니다.');
        await api('/payments/confirm', {
          method: 'POST',
          idempotencyKey: pending.key,
          body: {
            orderNo,
            amount: serverOrder.amount,
            paymentKey: params.get('paymentKey'),
          },
        });
      } else {
        if (params.get('customerKey') !== pending.customerKey)
          throw new Error('카드 등록 요청 정보가 일치하지 않습니다.');
        const body = {
          authKey: params.get('authKey'),
          customerKey: pending.customerKey,
        };
        await api(
          pending.kind === 'card'
            ? '/subscriptions/me/payment-method'
            : '/subscriptions',
          {
            method: pending.kind === 'card' ? 'PUT' : 'POST',
            idempotencyKey: pending.key,
            body: {
              ...body,
              ...(pending.kind === 'subscription'
                ? { planCode: pending.planCode }
                : {}),
            },
          },
        );
      }
      sessionStorage.removeItem(storageKey);
      history.replaceState(null, '', location.pathname);
      ui.go(pending.kind === 'order' ? 'orders' : 'subscription');
      ui.notify('결제 처리가 완료됐습니다.');
    };
    return (
      heading('결제 승인 확인') +
      panel(
        '<p>인증된 결제 결과를 서버에 전달해 승인합니다.</p>' +
          ui.action('결제 결과 확인', confirm, true),
      )
    );
  }
  return { order, orderDialog, checkout, billing, callbackView };
}
