import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { StorageService } from '../common/storage.service.js';
import { convertImage, type ExportFormat } from './image-convert.js';

export const safeName = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'emoticon';
const TTL = 600;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface ExportItem {
  label: string;
  imageKey: string;
}

/** 이미지 변환(원본/투명 PNG/Discord 규격)과 ZIP 묶음. 변환 결과는 스토리지에 캐시한다. */
@Injectable()
export class ExportService {
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  /** 이미지 파일은 불변이라 원본 키의 해시를 캐시 키로 쓴다. */
  private async file(srcKey: string, format: ExportFormat) {
    if (format === 'ORIGINAL') return { key: srcKey, size: (await this.storage.head(srcKey))?.size ?? 0, warnings: [] as string[] };
    const key = `converted/${sha(srcKey).slice(0, 32)}/${format}.png`;
    const head = await this.storage.head(key);
    if (head) return { key, size: head.size, warnings: [] as string[] };
    const out = await convertImage(await this.storage.readBytes(srcKey), format);
    await this.storage.put(key, out.data, 'image/png');
    return { key, size: out.data.length, warnings: out.warnings };
  }

  async one(item: ExportItem, format: ExportFormat) {
    const out = await this.file(item.imageKey, format);
    const fileName = `${safeName(item.label)}.png`;
    return {
      url: await this.storage.getUrl(out.key, TTL, fileName), fileName, sizeBytes: out.size,
      expiresAt: new Date(Date.now() + TTL * 1000), warnings: out.warnings,
    };
  }

  async zip(title: string, items: ExportItem[], format: ExportFormat) {
    const zipKey = `converted/zips/${sha(format + items.map((i) => i.imageKey + i.label).join(',')).slice(0, 32)}.zip`;
    const fileName = `${safeName(title)}.zip`;
    let warnings: string[] = [];
    let size = (await this.storage.head(zipKey))?.size;
    if (!size) {
      const files: Record<string, Uint8Array> = {};
      const used = new Map<string, number>();
      for (const it of items) {
        const out = await this.file(it.imageKey, format);
        warnings.push(...out.warnings);
        const base = safeName(it.label);
        const n = used.get(base) ?? 0;
        used.set(base, n + 1);
        files[`${n ? `${base}_${n + 1}` : base}.png`] = new Uint8Array(await this.storage.readBytes(out.key));
      }
      files['README.txt'] = strToU8(
        `EmoMix 이모티콘 세트: ${title}\n형식: ${format}\n파일 수: ${items.length}\n\n` +
          'Discord 서버 이모지는 서버 설정 > 이모지에서 파일을 업로드해 등록합니다(128x128, 256KB 이하).\n' +
          'AI로 생성된 이미지의 사용 범위는 서비스의 AI 생성물 이용 안내를 따릅니다.\n',
      );
      const data = Buffer.from(zipSync(files, { level: 0 })); // PNG 는 이미 압축돼 있어 저장만 한다
      await this.storage.put(zipKey, data, 'application/zip');
      size = data.length;
      warnings = [...new Set(warnings)];
    }
    return { url: await this.storage.getUrl(zipKey, TTL, fileName), fileName, sizeBytes: size, expiresAt: new Date(Date.now() + TTL * 1000), warnings };
  }
}
