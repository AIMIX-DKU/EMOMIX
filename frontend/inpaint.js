// 이모티콘 위에 브러시로 수정할 영역을 칠하고, 그 부분만 다시 그리게 요청하는 창.
import { api, uploadImage } from './api.js';
import { h } from './service-ui.js';

const BRUSH = 'rgba(35, 93, 222, 0.55)';

export function createInpaint(ui) {
  // emoticon: { id, label, imageUrl }
  async function open(emoticon) {
    const estimate = await api('/generations/estimates', {
      method: 'POST',
      body: { type: 'INPAINT', count: 1 },
    });
    const cost = estimate.creditCost,
      enough = estimate.sufficient;
    const body = ui.dialog(
      '부분 수정 · ' + (emoticon.label || ''),
      '<div class="inpaint-pro">' +
        '<p class="muted">바꾸고 싶은 부분을 브러시로 칠한 뒤, 어떻게 바꿀지 적어 주세요. 칠한 곳만 다시 그려져요.</p>' +
        '<div class="inpaint-stage"><img alt="" decoding="async"><canvas aria-label="수정할 영역을 브러시로 칠하는 캔버스"></canvas></div>' +
        '<div class="inpaint-tools">' +
        '<label>브러시 크기<input type="range" name="size" min="6" max="80" value="28"></label>' +
        '<div class="tabs" role="group">' +
        '<button type="button" data-tool="paint" aria-pressed="true">브러시</button>' +
        '<button type="button" data-tool="erase" aria-pressed="false">지우개</button></div>' +
        '<button type="button" class="secondary" data-act="undo">되돌리기</button>' +
        '<button type="button" class="secondary" data-act="clear">전체 지우기</button>' +
        '</div>' +
        '<label>어떻게 바꿀까요?<textarea name="prompt" rows="2" maxlength="300" placeholder="예) 눈을 하트 모양으로 바꿔 주세요"></textarea></label>' +
        '<div class="row between"><span class="muted">보유 ' +
        h(estimate.creditBalance) +
        ' 크레딧</span><button type="button" class="primary" data-act="go"' +
        (enough ? '' : ' disabled') +
        '>수정 생성 · ' +
        h(cost) +
        ' 크레딧</button></div>' +
        (enough
          ? ''
          : '<p class="live-error" role="alert">크레딧이 부족해요. 지갑에서 충전해 주세요.</p>') +
        '</div>',
    );
    const stage = body.querySelector('.inpaint-stage'),
      img = stage.querySelector('img'),
      canvas = stage.querySelector('canvas'),
      ctx = canvas.getContext('2d');
    const strokes = [];
    let tool = 'paint',
      current = null,
      ready = false,
      busy = false;
    const key = crypto.randomUUID();
    let maskUploadId = null,
      maskSignature = '';

    // 같은 획 목록을 화면(파란 반투명)과 서버 전송용(흰색/검정)에 똑같이 그린다.
    function drawStroke(c, stroke, color, erase) {
      c.save();
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.lineWidth = stroke.size;
      c.strokeStyle = color;
      c.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
      c.beginPath();
      stroke.points.forEach(([x, y], index) => {
        if (index === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      });
      if (stroke.points.length === 1) {
        const [x, y] = stroke.points[0];
        c.lineTo(x + 0.01, y);
      }
      c.stroke();
      c.restore();
    }
    function redraw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const stroke of strokes)
        drawStroke(ctx, stroke, BRUSH, stroke.erase);
    }
    const painted = () => strokes.some((s) => !s.erase);
    img.addEventListener(
      'load',
      () => {
        canvas.width = img.naturalWidth || 512;
        canvas.height = img.naturalHeight || 512;
        ready = true;
      },
      { once: true },
    );
    img.src = emoticon.imageUrl;

    const point = (event) => {
      const rect = canvas.getBoundingClientRect();
      return [
        ((event.clientX - rect.left) * canvas.width) / rect.width,
        ((event.clientY - rect.top) * canvas.height) / rect.height,
      ];
    };
    const brush = () => {
      const rect = canvas.getBoundingClientRect();
      return (
        Number(body.querySelector('[name=size]').value) *
        (canvas.width / Math.max(rect.width, 1))
      );
    };
    canvas.addEventListener('pointerdown', (event) => {
      if (!ready || busy) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      current = { points: [point(event)], size: brush(), erase: tool === 'erase' };
      strokes.push(current);
      redraw();
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!current) return;
      current.points.push(point(event));
      redraw();
    });
    const end = () => {
      current = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    body.addEventListener('click', async (event) => {
      const toolButton = event.target.closest('[data-tool]');
      if (toolButton) {
        tool = toolButton.dataset.tool;
        body
          .querySelectorAll('[data-tool]')
          .forEach((b) => b.setAttribute('aria-pressed', String(b === toolButton)));
        return;
      }
      const act = event.target.closest('[data-act]')?.dataset.act;
      if (act === 'undo') {
        strokes.pop();
        redraw();
      } else if (act === 'clear') {
        strokes.length = 0;
        redraw();
      } else if (act === 'go') {
        const button = event.target.closest('[data-act]');
        const prompt = body.querySelector('[name=prompt]').value.trim();
        if (!ready || !painted())
          return ui.notify('바꿀 부분을 브러시로 먼저 칠해 주세요.', 'error');
        if (!prompt) return ui.notify('어떻게 바꿀지 적어 주세요.', 'error');
        busy = true;
        button.disabled = true;
        button.textContent = '보내는 중…';
        try {
          const mask = document.createElement('canvas');
          mask.width = canvas.width;
          mask.height = canvas.height;
          const m = mask.getContext('2d');
          m.fillStyle = '#000';
          m.fillRect(0, 0, mask.width, mask.height);
          // 지우개는 검정으로 덮고, 칠한 곳은 흰색으로 — 흰 영역이 수정 대상
          for (const stroke of strokes)
            drawStroke(m, stroke, stroke.erase ? '#000' : '#fff', false);
          const blob = await new Promise((resolve) => mask.toBlob(resolve, 'image/png'));
          if (!blob) throw new Error('마스크를 만들지 못했어요.');
          const signature = strokes.length + ':' + blob.size;
          if (signature !== maskSignature || !maskUploadId) {
            maskUploadId = (
              await uploadImage(new File([blob], 'mask.png', { type: 'image/png' }), 'MASK')
            ).uploadId;
            maskSignature = signature;
          }
          const job = await api('/emoticons/' + encodeURIComponent(emoticon.id) + '/inpaints', {
            method: 'POST',
            idempotencyKey: key + ':' + maskSignature,
            body: { maskUploadId, prompt },
          });
          ui.close();
          ui.go('job', { id: job.jobId });
        } catch (error) {
          ui.notify(error.message, 'error');
          busy = false;
          button.disabled = false;
          button.textContent = '수정 생성 · ' + cost + ' 크레딧';
        }
      }
    });
  }
  return { open };
}
