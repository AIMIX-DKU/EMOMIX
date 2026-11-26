import { CharacterController } from './character.controller.js';
import { vi, describe, it, expect } from 'vitest';

function fixture() {
  const character = {
    id: 'character',
    ownerId: 'owner',
    description: 'blue mascot',
    status: 'DRAFT',
  };
  const image = {
    id: 'source',
    characterId: character.id,
    imageKey: 'original.png',
  };
  const mask = { id: 'mask', storageKey: 'mask.png', width: 1, height: 1 };
  const prisma = {
    character: { findFirst: vi.fn().mockResolvedValue(character) },
    characterCandidate: { findFirst: vi.fn().mockResolvedValue(image) },
    upload: { findFirst: vi.fn().mockResolvedValue(mask), update: vi.fn() },
  };
  const storage = {
    readBytes: vi
      .fn()
      .mockResolvedValue(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          'base64',
        ),
      ),
  };
  const generation = {
    costOf: vi.fn().mockResolvedValue(1),
    create: vi.fn(async (spec) => spec),
  };
  const controller = new CharacterController(
    prisma as never,
    storage as never,
    generation as never,
  );
  const me = { id: 'owner' } as never;
  return { controller, prisma, generation, me, character, mask };
}
describe('saved character result edits', () => {
  it('references the selected result and requests exactly one new saved result', async () => {
    const f = fixture();
    const spec = await f.controller.regenerate(
      f.me,
      'character',
      'request-key',
      { sourceCandidateImageId: 'source', prompt: 'smiling eyes' },
    );
    expect(spec).toMatchObject({
      type: 'CHARACTER_CANDIDATES',
      targetType: 'CHARACTER',
      targetId: 'character',
      count: 1,
      idempotencyKey: 'request-key',
      work: { inputImageKeys: ['original.png'], count: 1 },
      fingerprint: ['edit', 'source', 'smiling eyes'],
    });
    expect(f.prisma.characterCandidate.findFirst).toHaveBeenCalledWith({
      where: { id: 'source', characterId: 'character' },
    });
  });
  it('does not allow another user or another character result to be edited', async () => {
    const f = fixture();
    f.character.ownerId = 'someone-else';
    await expect(
      f.controller.regenerate(f.me, 'character', 'request-key', {
        sourceCandidateImageId: 'source',
        prompt: 'eyes',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    f.character.ownerId = 'owner';
    f.prisma.characterCandidate.findFirst.mockResolvedValue(null);
    await expect(
      f.controller.regenerate(f.me, 'character', 'request-key', {
        sourceCandidateImageId: 'foreign',
        prompt: 'eyes',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.generation.create).not.toHaveBeenCalled();
  });
  it('requires an owned confirmed mask matching the source dimensions', async () => {
    const f = fixture();
    const body = {
      sourceCandidateImageId: 'source',
      maskUploadId: 'mask',
      prompt: 'smiling eyes',
    };
    const spec = await f.controller.inpaint(
      f.me,
      'character',
      'request-key',
      body,
    );
    expect(spec).toMatchObject({
      type: 'INPAINT',
      targetType: 'CHARACTER',
      count: 1,
      work: {
        maskKey: 'mask.png',
        originalKey: 'original.png',
        inputImageKeys: ['original.png'],
      },
    });
    expect(f.prisma.upload.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'mask',
        ownerId: 'owner',
        purpose: 'MASK',
        status: 'CONFIRMED',
      },
    });
    expect(f.prisma.upload.update).not.toHaveBeenCalled();
    f.mask.width = 2;
    await expect(
      f.controller.inpaint(f.me, 'character', 'new-request', body),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    f.prisma.upload.findFirst.mockResolvedValue(null);
    await expect(
      f.controller.inpaint(f.me, 'character', 'new-request', body),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
  it('rejects empty edit instructions before reserving credits', async () => {
    const f = fixture();
    await expect(
      f.controller.regenerate(f.me, 'character', 'request-key', {
        sourceCandidateImageId: 'source',
        prompt: ' ',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(f.generation.create).not.toHaveBeenCalled();
  });
});
