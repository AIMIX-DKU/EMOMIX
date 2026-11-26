import sharp from 'sharp';

export type ExportFormat = 'ORIGINAL' | 'TRANSPARENT_PNG' | 'DISCORD';
export const DISCORD_MAX_BYTES = 256 * 1024;

/** 이미지를 내려받기 형식으로 변환한다. 변환 불필요(ORIGINAL)면 호출하지 않는다. */
export async function convertImage(src: Buffer, format: Exclude<ExportFormat, 'ORIGINAL'>): Promise<{ data: Buffer; warnings: string[] }> {
  const warnings: string[] = [];
  if (format === 'TRANSPARENT_PNG') {
    const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = info;
    const px = (x: number, y: number) => (y * w + x) * 4;
    const corners = [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)];
    const dist = (a: number, b: number) => Math.max(Math.abs(data[a] - data[b]), Math.abs(data[a + 1] - data[b + 1]), Math.abs(data[a + 2] - data[b + 2]));
    const solid = corners.every((c) => data[c + 3] > 0) && corners.every((c) => dist(corners[0], c) <= 24);
    if (solid) {
      const bg = corners[0];
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0 && dist(bg, i) <= 36) data[i + 3] = 0;
      warnings.push('단색 배경을 투명하게 바꿨습니다. 배경이 복잡한 이미지는 정확하지 않을 수 있습니다.');
    } else if (!corners.some((c) => data[c + 3] === 0)) {
      warnings.push('배경이 단색이 아니어서 투명 처리를 하지 못했습니다. 원본을 PNG로 변환해 제공합니다.');
    }
    return { data: await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(), warnings };
  }

  // DISCORD: 128x128, 256KB 이하
  let out = await sharp(src).resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  if (out.length > DISCORD_MAX_BYTES) {
    out = await sharp(out).png({ palette: true, quality: 70, effort: 7 }).toBuffer();
    warnings.push('용량이 256KB를 넘어 색상을 줄여 압축했습니다.');
  }
  if (out.length > DISCORD_MAX_BYTES) warnings.push('압축 후에도 256KB를 넘습니다.');
  return { data: out, warnings };
}

/** 인페인트 결과 합성: 마스크 흰색 영역은 생성 결과, 나머지는 원본 픽셀을 그대로 보존한다. */
export async function compositeInpaint(original: Buffer, generated: Buffer, mask: Buffer): Promise<Buffer> {
  const meta = await sharp(original).metadata();
  const w = meta.width!;
  const h = meta.height!;
  const gen = await sharp(generated).resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const m = await sharp(mask).resize(w, h, { fit: 'fill' }).greyscale().raw().toBuffer();
  const overlay = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    overlay[i * 4] = gen[i * 3];
    overlay[i * 4 + 1] = gen[i * 3 + 1];
    overlay[i * 4 + 2] = gen[i * 3 + 2];
    overlay[i * 4 + 3] = m[i];
  }
  const top = await sharp(overlay, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  return sharp(original).ensureAlpha().composite([{ input: top }]).png().toBuffer();
}

/** 판매 미리보기: 256px 로 줄이고 대각선 반투명 띠를 덮는다(글꼴이 필요 없는 워터마크). */
export async function watermarkPreview(src: Buffer): Promise<Buffer> {
  const svg = Buffer.from(
    '<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg"><defs>' +
      '<pattern id="p" width="56" height="56" patternUnits="userSpaceOnUse" patternTransform="rotate(-35)">' +
      '<rect width="56" height="16" fill="#ffffff" fill-opacity="0.45"/><rect y="16" width="56" height="3" fill="#000000" fill-opacity="0.15"/></pattern></defs>' +
      '<rect width="256" height="256" fill="url(#p)"/></svg>',
  );
  const base = await sharp(src).resize(256, 256, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toBuffer();
  return sharp(base).composite([{ input: svg }]).png().toBuffer();
}

/** 목록용 작은 이미지(최대 384px, WebP). */
export const makeThumb = (src: Buffer) =>
  sharp(src).rotate().resize(384, 384, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
