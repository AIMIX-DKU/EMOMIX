import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { WorkerController } from './worker.controller.js';
vi.mock('../common/wallet.js', () => ({
  consumeCredits: vi.fn(),
  releaseCredits: vi.fn(),
  reserveCredits: vi.fn(),
  totalCredits: vi.fn(),
}));

describe('worker character inpaint completion', () => {
  it('preserves pixels outside the mask and appends a character result, not an emoticon version', async () => {
    const original = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    const generated = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#0000ff' },
    })
      .png()
      .toBuffer();
    const pixels = Buffer.alloc(4 * 4 * 3);
    pixels.fill(255, (1 * 4 + 1) * 3, (1 * 4 + 1) * 3 + 3);
    const mask = await sharp(pixels, {
      raw: { width: 4, height: 4, channels: 3 },
    })
      .png()
      .toBuffer();
    const job = {
      id: 'job',
      type: 'INPAINT',
      targetType: 'CHARACTER',
      targetId: 'character',
      status: 'RUNNING',
      leaseExpiresAt: new Date(Date.now() + 60000),
      userId: 'owner',
      creditCost: 1,
      params: { count: 1, maskKey: 'mask', originalKey: 'original' },
    };
    const tx = {
      generationJob: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn(),
      },
      characterCandidate: {
        create: vi.fn().mockResolvedValue({ id: 'edited' }),
      },
      emoticonVersion: { create: vi.fn() },
    };
    const prisma = {
      generationJob: { findUnique: vi.fn().mockResolvedValue(job) },
      $transaction: vi.fn(async (callback) => callback(tx)),
    };
    let merged: Buffer | undefined;
    const storage = {
      readBytes: vi.fn(async (key: string) =>
        key === 'original' ? original : key === 'mask' ? mask : generated,
      ),
      put: vi.fn(async (_key, bytes) => {
        merged = bytes;
      }),
    };
    const notify = { send: vi.fn() };
    const controller = new WorkerController(
      prisma as never,
      storage as never,
      notify as never,
    );
    await controller.complete('job', {
      images: [{ uploadKey: 'generated/job/input.png' }],
    });
    expect(tx.characterCandidate.create).toHaveBeenCalledWith({
      data: {
        characterId: 'character',
        jobId: 'job',
        imageKey: expect.stringMatching(/^generated\/job\//),
      },
    });
    expect(tx.emoticonVersion.create).not.toHaveBeenCalled();
    await expect(
      controller.complete('job', {
        images: [
          { uploadKey: 'generated/job/one.png' },
          { uploadKey: 'generated/job/two.png' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const rgb = await sharp(merged!).removeAlpha().raw().toBuffer();
    expect([...rgb.subarray(0, 3)]).toEqual([255, 0, 0]);
    expect([...rgb.subarray(15, 18)]).toEqual([0, 0, 255]);
    expect([...rgb.subarray(45, 48)]).toEqual([255, 0, 0]);
  });
});
