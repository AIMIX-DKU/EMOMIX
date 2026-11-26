export function createMaskEditor() {
  let key,
    mask,
    ready = false,
    revision = 0,
    tool = 'paint',
    size = 28,
    abort;
  function mount(root, imageKey) {
    abort?.abort();
    abort = new AbortController();
    const options = { signal: abort.signal };
    const stage = root.querySelector('[data-character-mask]');
    if (!stage) return;
    const image = stage.querySelector('img'),
      canvas = stage.querySelector('canvas');
    const status = root.querySelector('[data-mask-status]');
    if (key !== imageKey) {
      key = imageKey;
      mask = null;
      ready = false;
      revision++;
    }
    const context = canvas.getContext('2d');
    function render() {
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (mask) context.drawImage(mask, 0, 0);
      context.globalCompositeOperation = 'source-in';
      context.fillStyle = '#2864f0';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = 'source-over';
      status.textContent = ready
        ? '파란색으로 표시한 부분만 수정해요.'
        : '이미지를 불러오고 있어요.';
    }
    function initialize() {
      if (!image.naturalWidth) return;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      if (!mask) {
        mask = document.createElement('canvas');
        mask.width = canvas.width;
        mask.height = canvas.height;
      }
      ready = true;
      render();
    }
    image.addEventListener('load', initialize, options);
    image.addEventListener(
      'error',
      () => {
        ready = false;
        status.textContent =
          '이미지를 불러오지 못했어요. 다시 불러온 뒤 선택해 주세요.';
      },
      options,
    );
    if (image.complete && image.naturalWidth) initialize();
    const range = root.querySelector('[data-mask-size]');
    range.value = size;
    range.addEventListener(
      'input',
      () => {
        size = Number(range.value);
      },
      options,
    );
    root.querySelectorAll('[data-mask-tool]').forEach((button) => {
      button.setAttribute(
        'aria-pressed',
        String(tool === button.dataset.maskTool),
      );
      button.addEventListener(
        'click',
        () => {
          tool = button.dataset.maskTool;
          root
            .querySelectorAll('[data-mask-tool]')
            .forEach((b) =>
              b.setAttribute(
                'aria-pressed',
                String(b.dataset.maskTool === tool),
              ),
            );
        },
        options,
      );
    });
    root.querySelector('[data-mask-clear]').addEventListener(
      'click',
      () => {
        if (!mask) return;
        mask.getContext('2d').clearRect(0, 0, mask.width, mask.height);
        revision++;
        render();
      },
      options,
    );
    let previous;
    const point = (event) => {
      const rect = canvas.getBoundingClientRect();
      return [
        ((event.clientX - rect.left) * canvas.width) / rect.width,
        ((event.clientY - rect.top) * canvas.height) / rect.height,
        (size * canvas.width) / rect.width,
      ];
    };
    const draw = (event) => {
      if (!previous || !ready) return;
      const next = point(event),
        ctx = mask.getContext('2d');
      ctx.globalCompositeOperation =
        tool === 'erase' ? 'destination-out' : 'source-over';
      ctx.strokeStyle = ctx.fillStyle = '#fff';
      ctx.lineWidth = next[2];
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(previous[0], previous[1]);
      ctx.lineTo(next[0], next[1]);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(next[0], next[1], next[2] / 2, 0, 2 * Math.PI);
      ctx.fill();
      previous = next;
      revision++;
      render();
    };
    canvas.addEventListener(
      'pointerdown',
      (event) => {
        if (!ready || event.button > 0) return;
        event.preventDefault();
        canvas.setPointerCapture(event.pointerId);
        previous = point(event);
        draw(event);
      },
      options,
    );
    canvas.addEventListener('pointermove', draw, options);
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'])
      canvas.addEventListener(
        name,
        () => {
          previous = null;
        },
        options,
      );
  }
  async function file() {
    if (!ready || !mask)
      throw Error('이미지가 준비된 후 수정할 부분을 칠해 주세요.');
    const data = mask
      .getContext('2d')
      .getImageData(0, 0, mask.width, mask.height).data;
    if (!data.some((value, index) => index % 4 === 3 && value))
      throw Error('이미지에서 수정할 부분을 먼저 칠해 주세요.');
    const output = document.createElement('canvas');
    output.width = mask.width;
    output.height = mask.height;
    const ctx = output.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, output.width, output.height);
    ctx.drawImage(mask, 0, 0);
    const blob = await new Promise((resolve) =>
      output.toBlob(resolve, 'image/png'),
    );
    if (!blob) throw Error('수정 영역을 저장하지 못했어요.');
    return new File([blob], 'character-mask.png', { type: 'image/png' });
  }
  return {
    mount,
    file,
    get revision() {
      return revision;
    },
  };
}
