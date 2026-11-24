(() => {
  'use strict';

  const form = document.querySelector('#generation-form');
  const input = document.querySelector('#prompt');
  const count = document.querySelector('#count');
  const generate = document.querySelector('#generate');
  const generateLabel = document.querySelector('#generate-label');
  const status = document.querySelector('#status');
  const emptyResult = document.querySelector('#empty-result');
  const image = document.querySelector('#result-image');
  const actions = document.querySelector('#result-actions');
  const download = document.querySelector('#download');
  const skip = document.querySelector('#skip');
  const apiBase = document
    .querySelector('meta[name="emomix-api-base"]')
    .content.trim()
    .replace(/\/$/, '');
  const defaultButtonLabel = generateLabel.textContent;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const palettes = {
    blue: ['#aeedff', '#58b7f5', '#2878d7'],
    green: ['#dcf9c0', '#79d9a1', '#23916e'],
    pink: ['#ffe4ef', '#ff9ec4', '#df518b'],
    yellow: ['#fff4b5', '#ffd069', '#e29328'],
  };
  function interpret(prompt) {
    const shape = /별|star/i.test(prompt)
      ? 'star'
      : /구름|cloud/i.test(prompt)
        ? 'cloud'
        : 'droplet';
    const expression = /졸|잠|sleep/i.test(prompt)
      ? 'sleep'
      : /놀|깜짝|surpris/i.test(prompt)
        ? 'surprise'
        : 'smile';
    const explicitColor = Object.keys(palettes).find((color) =>
      ({
        blue: /파랑|파란|파란색|하늘색|blue/i,
        green: /초록|녹색|green/i,
        pink: /분홍|핑크|pink/i,
        yellow: /노랑|노란|금색|yellow/i,
      })[color].test(prompt),
    );
    const hash = [...prompt].reduce(
      (value, char) => (Math.imul(value, 31) + char.codePointAt(0)) >>> 0,
      0,
    );
    const palette =
      palettes[explicitColor] ?? Object.values(palettes)[hash % 4];
    return { shape, expression, palette };
  }
  function drawCharacter({ shape, expression, palette }) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('캔버스를 열 수 없습니다.');
    const body = context.createLinearGradient(75, 60, 177, 216);
    body.addColorStop(0, palette[0]);
    body.addColorStop(0.54, palette[1]);
    body.addColorStop(1, palette[2]);
    context.beginPath();
    if (shape === 'star') {
      for (let point = 0; point < 10; point++) {
        const angle = -Math.PI / 2 + (point * Math.PI) / 5;
        const radius = point % 2 ? 66 : 103;
        const x = 128 + Math.cos(angle) * radius;
        const y = 132 + Math.sin(angle) * radius;
        if (point === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.lineJoin = 'round';
      context.lineWidth = 15;
      context.strokeStyle = body;
    } else if (shape === 'cloud') {
      context.moveTo(55, 192);
      context.bezierCurveTo(4, 192, 19, 112, 66, 110);
      context.bezierCurveTo(61, 63, 116, 51, 138, 81);
      context.bezierCurveTo(167, 52, 215, 80, 211, 118);
      context.bezierCurveTo(258, 132, 245, 193, 209, 192);
    } else {
      context.moveTo(122, 28);
      context.bezierCurveTo(130, 16, 140, 25, 149, 43);
      context.bezierCurveTo(168, 80, 209, 103, 209, 151);
      context.bezierCurveTo(209, 199, 171, 223, 128, 223);
      context.bezierCurveTo(83, 223, 47, 198, 47, 153);
      context.bezierCurveTo(47, 108, 94, 72, 122, 28);
    }
    context.closePath();
    context.fillStyle = body;
    context.fill();
    if (shape === 'star') context.stroke();
    function oval(x, y, rx, ry, color) {
      context.beginPath();
      context.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();
    }
    context.save();
    context.translate(91, 102);
    context.rotate(0.63);
    oval(0, 0, 9, 23, '#e8fbff');
    context.restore();
    oval(76, 160, 13, 7, '#b3e8ff');
    oval(180, 160, 13, 7, '#b3e8ff');
    const ink = '#123766';
    context.strokeStyle = ink;
    context.lineCap = 'round';
    context.lineWidth = 5;
    for (const x of [101, 155]) {
      if (expression === 'sleep') {
        context.beginPath();
        context.moveTo(x - 10, 139);
        context.quadraticCurveTo(x, 150, x + 10, 139);
        context.stroke();
      } else {
        oval(x, 136, 6, expression === 'surprise' ? 11 : 8, ink);
      }
    }
    if (expression === 'surprise') {
      oval(128, 166, 10, 13, ink);
    } else if (expression === 'sleep') {
      oval(128, 166, 6, 4, ink);
    } else {
      context.beginPath();
      context.moveTo(113, 158);
      context.quadraticCurveTo(128, 183, 143, 158);
      context.closePath();
      context.fillStyle = ink;
      context.fill();
    }
    return canvas.toDataURL('image/png');
  }

  function showStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('error', isError);
  }

  function clearResult() {
    image.hidden = true;
    image.removeAttribute('src');
    image.alt = '';
    download.removeAttribute('href');
    actions.hidden = true;
    emptyResult.hidden = false;
  }

  async function api(path, options = {}) {
    const response = await fetch(apiBase + path, {
      credentials: 'include',
      signal: AbortSignal.timeout(15000),
      ...options,
    });
    const body = await response.json().catch(() => null);
    if (response.status === 401)
      throw new Error('로그인한 뒤 다시 시도해 주세요.');
    if (!response.ok || !body?.success) {
      throw new Error(body?.message ?? '생성 서버에 연결할 수 없어요.');
    }
    return body.data;
  }

  async function requestAiImage(prompt) {
    const { csrfToken } = await csrfReady;
    const { items } = await api('/style-presets');
    const stylePreset = items[0]?.key;
    if (!stylePreset) throw new Error('사용할 수 있는 그림체가 없어요.');

    const headers = {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const character = await api('/characters', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: '새 이모티콘',
        description: prompt,
        stylePreset,
      }),
    });
    let job = await api(
      '/characters/' + encodeURIComponent(character.id) + '/candidates',
      {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ count: 1 }),
      },
    );

    const deadline = Date.now() + 5 * 60 * 1000;
    while (job.status === 'QUEUED' || job.status === 'RUNNING') {
      const queued = job.status === 'QUEUED';
      const position =
        job.queuePosition > 0
          ? ' 앞에서 ' + job.queuePosition + '번째예요.'
          : '';
      showStatus(
        queued
          ? '생성 대기 중이에요.' + position
          : 'AI가 이모티콘을 그리고 있어요.',
      );
      if (Date.now() >= deadline) {
        throw new Error(
          '생성 상태 확인 시간이 끝났어요. 작업 ID: ' + job.jobId,
        );
      }
      await wait(2000);
      job = await api('/generations/' + encodeURIComponent(job.jobId));
    }

    const imageUrl = job.result?.images?.[0]?.imageUrl;
    if (job.status !== 'SUCCEEDED' || !imageUrl) {
      throw new Error(
        '생성 작업을 완료하지 못했어요.' +
          (job.errorCode ? ' (' + job.errorCode + ')' : ''),
      );
    }
    return imageUrl;
  }

  async function generateImage(prompt) {
    if (apiBase) return requestAiImage(prompt);
    await wait(180);
    return drawCharacter(interpret(prompt));
  }

  async function downloadAiPng(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('이미지를 받지 못했어요.');
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('이미지를 변환할 수 없어요.');
      ctx.drawImage(bitmap, 0, 0);
      const png = await new Promise((resolve) =>
        canvas.toBlob(resolve, 'image/png'),
      );
      if (!png) throw new Error('PNG를 만들 수 없어요.');
      const objectUrl = URL.createObjectURL(png);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = download.download;
      link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } finally {
      bitmap.close();
    }
  }

  const csrfReady = apiBase ? api('/auth/csrf') : Promise.resolve(null);
  csrfReady.catch(() =>
    showStatus('인증 서버에 연결하지 못했어요. 새로고침해 주세요.', true),
  );
  if (!apiBase) showStatus('샘플 모드예요. 프롬프트를 입력해 보세요.');

  input.addEventListener('input', () => {
    input.setCustomValidity('');
    count.textContent = input.value.length + ' / ' + input.maxLength;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (generate.disabled) return;
    const prompt = input.value.trim();
    if (!prompt) {
      input.setCustomValidity('공백을 제외한 프롬프트를 입력해 주세요.');
      input.reportValidity();
      return;
    }

    clearResult();
    input.readOnly = true;
    generate.disabled = true;
    generateLabel.textContent = '만드는 중…';
    showStatus(apiBase ? '생성을 요청하고 있어요.' : '샘플을 그리고 있어요.');

    try {
      const url = await generateImage(prompt);
      image.src = url;
      image.alt = '이모티콘 미리보기: ' + prompt;
      await image.decode();
      download.href = url;
      emptyResult.hidden = true;
      image.hidden = false;
      actions.hidden = false;
      showStatus(apiBase ? '이모티콘이 완성됐어요.' : '샘플이 완성됐어요.');
    } catch (error) {
      clearResult();
      showStatus(error.message || '이모티콘을 만들지 못했어요.', true);
    } finally {
      input.readOnly = false;
      generate.disabled = false;
      generateLabel.textContent = defaultButtonLabel;
    }
  });

  download.addEventListener('click', async (event) => {
    if (!apiBase) return;
    event.preventDefault();
    const url = download.href;
    try {
      await downloadAiPng(url);
    } catch {
      if (!actions.hidden && download.href === url) {
        showStatus(
          'PNG를 저장하지 못했어요. 미리보기를 우클릭해 이미지를 저장해 주세요.',
          true,
        );
      }
    }
  });

  skip.addEventListener('click', () => {
    clearResult();
    showStatus('결과를 지웠어요. 입력한 문장으로 다시 만들 수 있어요.');
    generate.focus();
  });
})();
