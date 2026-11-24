import { Inject, Injectable } from '@nestjs/common';
import type { Post, Prisma, User, Tag, PostTag, Upload } from '@prisma/client';
import { PrismaService } from '../prisma.service.js';
import { StorageService } from '../common/storage.service.js';

export type SnapshotItem = { id: string; label: string; imageKey: string; thumbKey?: string | null };
export type PostFull = Post & { author: User & { profileImage: Upload | null }; tags: (PostTag & { tag: Tag })[] };

export const POST_INCLUDE = {
  author: { include: { profileImage: true } },
  tags: { include: { tag: true } },
} satisfies Prisma.PostInclude;

/** 공개 목록에 노출 가능한 게시물 조건(삭제·숨김 제외). */
export const VISIBLE: Prisma.PostWhereInput = { deletedAt: null, hidden: false };

@Injectable()
export class CommunityService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  /** 작성자 요약. 탈퇴한 사용자는 이름과 이미지를 가린다. */
  async userBrief(u: User & { profileImage: Upload | null }) {
    const gone = u.status === 'WITHDRAWN';
    return {
      id: u.id,
      nickname: gone ? '탈퇴한 사용자' : u.nickname,
      profileImageUrl: gone ? null : await this.storage.getUrl(u.profileImage?.storageKey),
    };
  }

  /** 목록 항목(POST_ITEM). meId 가 있으면 isLiked 를 한 번에 조회한다. */
  async items(posts: PostFull[], meId?: string) {
    const liked = meId && posts.length
      ? new Set((await this.prisma.like.findMany({ where: { userId: meId, postId: { in: posts.map((p) => p.id) } }, select: { postId: true } })).map((l) => l.postId))
      : new Set<string>();
    return Promise.all(
      posts.map(async (p) => ({
        id: p.id, title: p.title,
        thumbnailUrls: await Promise.all(((p.snapshot as SnapshotItem[]) ?? []).slice(0, 4).map((s) => this.storage.getUrl(s.thumbKey ?? s.imageKey))),
        tags: p.tags.map((t) => t.tag.name), author: await this.userBrief(p.author),
        likeCount: p.likeCount, commentCount: p.commentCount, isLiked: liked.has(p.id), createdAt: p.createdAt,
      })),
    );
  }
}
