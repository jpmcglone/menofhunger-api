import { Readable } from 'node:stream';
import { NotFoundException } from '@nestjs/common';
import { ChannelMediaService, channelMediaLimits } from './channel-media.service';

function setup() {
  const key = 'channel-uploads/user/channel/upload/original.mp4';
  const prisma: any = {
    messageMedia: { findFirst: jest.fn().mockResolvedValue({ r2Key: key, thumbnailR2Key: `${key}.jpg` }) },
    mediaAsset: { findUnique: jest.fn().mockResolvedValue({ deletedAt: null }) },
    report: { findUnique: jest.fn().mockResolvedValue({ targetType: 'message', subjectMessageId: 'reported' }) },
    groupChannelUpload: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const access: any = { channel: jest.fn().mockResolvedValue({ channel: { conversationId: 'conversation' } }) };
  const config: any = { r2: () => null, channelMediaBucket: () => 'private' };
  const body = Readable.from(['bytes']);
  const send = jest.fn().mockResolvedValue({ Body: body, ContentType: 'video/mp4', ContentRange: 'bytes 0-4/5' });
  const service = new ChannelMediaService(prisma, access, config);
  jest.spyOn(service as any, 'storage').mockReturnValue({ s3: { send }, bucket: 'private' });
  return { service, prisma, access, send, body, key };
}

describe('protected channel media', () => {
  it('requires current channel access before looking up any media', async () => {
    const h = setup(); h.access.channel.mockRejectedValue(new NotFoundException());
    await expect(h.service.read('u', 'g', 'c', 'm', false)).rejects.toThrow();
    expect(h.prisma.messageMedia.findFirst).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });
  it('does not reveal storage configuration to viewers without channel access', async () => {
    const h = setup(); h.access.channel.mockRejectedValue(new NotFoundException('Channel unavailable.'));
    const storage = jest.spyOn(h.service as any, 'storage');
    await expect(h.service.read('u', 'g', 'c', 'm', false)).rejects.toThrow('Channel unavailable');
    await expect(h.service.initialize('u', 'g', 'c', { contentType: 'image/png', bytes: 10 })).rejects.toThrow('Channel unavailable');
    await expect(h.service.commit('u', 'g', 'c', 'upload', {})).rejects.toThrow('Channel unavailable');
    expect(storage).not.toHaveBeenCalled();
  });
  it('uses the private bucket for access-checked byte ranges and derivatives', async () => {
    const h = setup(); await h.service.read('u', 'g', 'c', 'm', true, 'bytes=0-4');
    expect(h.send.mock.calls[0][0].input).toEqual({ Bucket: 'private', Key: `${h.key}.jpg`, Range: 'bytes=0-4' });
    expect(h.access.channel).toHaveBeenCalledTimes(2);
    expect(h.prisma.messageMedia.findFirst.mock.calls[0][0].where.message).toEqual({ conversationId: 'conversation', deletedForAll: false });
  });
  it('destroys an opened stream when membership is revoked during the storage read', async () => {
    const h = setup(); h.access.channel.mockResolvedValueOnce({ channel: { conversationId: 'conversation' } }).mockRejectedValueOnce(new NotFoundException());
    await expect(h.service.read('u', 'g', 'c', 'm', false)).rejects.toThrow();
    expect(h.body.destroyed).toBe(true);
  });
  it('bounds report review to the specific reported message', async () => {
    const h = setup(); h.prisma.messageMedia.findFirst.mockResolvedValue(null);
    await expect(h.service.readReportedMedia('report', 'unrelated', false)).rejects.toThrow('Reported media unavailable');
    expect(h.prisma.messageMedia.findFirst).toHaveBeenCalledWith({ where: { id: 'unrelated', messageId: 'reported', source: 'upload' } });
    expect(h.send).not.toHaveBeenCalled();
  });
  it('rejects multi-ranges and deleted assets before issuing a read', async () => {
    const h = setup();
    await expect(h.service.read('u', 'g', 'c', 'm', false, 'bytes=0-2,4-5')).rejects.toThrow('Invalid media range');
    h.prisma.mediaAsset.findUnique.mockResolvedValue({ deletedAt: new Date() });
    await expect(h.service.read('u', 'g', 'c', 'm', false)).rejects.toThrow('Media unavailable');
    expect(h.send).not.toHaveBeenCalled();
  });
  it('binds committed uploads to their uploader and channel', async () => {
    const h = setup();
    await expect(h.service.consume(h.prisma, 'u', 'c', 'upload')).rejects.toThrow('Upload unavailable');
    expect(h.prisma.groupChannelUpload.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'upload', userId: 'u', channelId: 'c', committedAt: { not: null }, consumedAt: null });
  });
  it('retains existing media tier and duration restrictions', () => {
    expect(() => channelMediaLimits('video', { premium: false, premiumPlus: false })).toThrow('premium');
    expect(channelMediaLimits('video', { premium: true, premiumPlus: false }).duration).toBe(300);
    expect(channelMediaLimits('video', { premium: true, premiumPlus: true }).duration).toBe(900);
    expect(channelMediaLimits('audio', { premium: false, premiumPlus: false }).duration).toBe(120);
  });
});
