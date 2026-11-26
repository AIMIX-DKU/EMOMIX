// 파일 선택 칸을 "끌어다 놓기 + 미리보기" 영역으로 보강한다. 마크업은 그대로 두고 CSS 와 이벤트만 더한다.
export function enhanceFileInputs(root) {
  const labelOf = (input) => input.closest('label');
  function show(input) {
    const label = labelOf(input);
    if (!label) return;
    label.querySelector('.file-preview')?.remove();
    const file = input.files?.[0];
    label.classList.toggle('has-file', !!file);
    if (!file) return;
    const box = document.createElement('span');
    box.className = 'file-preview';
    if (file.type.startsWith('image/')) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = URL.createObjectURL(file);
      img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: true });
      box.append(img);
    }
    const name = document.createElement('span');
    name.textContent = file.name + ' (' + Math.ceil(file.size / 1024) + 'KB)';
    box.append(name);
    label.append(box);
  }
  root.addEventListener('change', (event) => {
    if (event.target.matches?.('input[type=file]')) show(event.target);
  });
  for (const type of ['dragover', 'dragenter'])
    root.addEventListener(type, (event) => {
      const label = event.target.closest?.('label:has(input[type=file])');
      if (!label) return;
      event.preventDefault();
      label.classList.add('dragging');
    });
  for (const type of ['dragleave', 'drop'])
    root.addEventListener(type, (event) => {
      const label = event.target.closest?.('label:has(input[type=file])');
      if (!label) return;
      label.classList.remove('dragging');
      if (type !== 'drop') return;
      event.preventDefault();
      const input = label.querySelector('input[type=file]');
      if (!input || !event.dataTransfer?.files?.length) return;
      input.files = event.dataTransfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
}
