import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { ApiError } from '../common/envelope.js';
import { parse, z } from '../common/validate.js';
import { PrismaService } from '../prisma.service.js';
import { ExportService } from './export.service.js';

export const exportFormat = z.enum(['ORIGINAL', 'TRANSPARENT_PNG', 'DISCORD']);

@Controller()
export class DownloadController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ExportService) private readonly exporter: ExportService,
  ) {}

  @Get('emoticons/:id/download') @Access('user')
  async one(@CurrentUser() me: Me, @Param('id') id: string, @Query('format') format: string) {
    const f = parse(exportFormat, format);
    const e = await this.prisma.emoticon.findUnique({ where: { id }, include: { current: true, set: true } });
    if (!e || e.set.deletedAt || e.set.ownerId !== me.id) throw new ApiError('NOT_FOUND');
    if (!e.current) throw new ApiError('VALIDATION_ERROR', '아직 생성이 끝나지 않은 이모티콘입니다.');
    return this.exporter.one({ label: e.label, imageKey: e.current.imageKey }, f);
  }

  @Get('sets/:id/download') @Access('user')
  async zip(@CurrentUser() me: Me, @Param('id') id: string, @Query('format') format: string) {
    const f = parse(exportFormat, format);
    const set = await this.prisma.emoticonSet.findFirst({
      where: { id, deletedAt: null }, include: { emoticons: { where: { status: 'READY' }, include: { current: true }, orderBy: { createdAt: 'asc' } } },
    });
    if (!set || set.ownerId !== me.id) throw new ApiError('NOT_FOUND');
    const list = set.emoticons.filter((e) => e.current).map((e) => ({ label: e.label, imageKey: e.current!.imageKey }));
    if (!list.length) throw new ApiError('VALIDATION_ERROR', '내려받을 이모티콘이 없습니다.');
    return this.exporter.zip(set.title, list, f);
  }

  @Get('guides/export') @Access('none')
  guide() {
    return {
      discord: {
        width: 128, height: 128, maxBytes: 256 * 1024, formats: ['PNG', 'JPEG', 'GIF'],
        steps: [
          'Discord 서버 설정 > 이모지(Emoji)를 엽니다.',
          '"이모지 업로드"를 눌러 내려받은 파일을 선택합니다.',
          '이름을 확인하고 저장합니다. 서버 부스트 수준에 따라 등록 가능 개수가 다릅니다.',
        ],
      },
      notices: [
        'EmoMix는 외부 플랫폼에 자동 등록하지 않습니다. 규격에 맞춘 파일과 안내만 제공합니다.',
        'AI 생성물의 권리와 사용 범위는 AI 생성물 이용 안내 약관을 확인하세요.',
      ],
      kakao: { supported: false, message: '카카오 이모티콘은 생성형 AI 이모티콘 제안을 제한하고 있어 지원하지 않습니다.' },
    };
  }
}
