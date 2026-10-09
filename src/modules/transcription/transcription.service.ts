import { MessagesRealtimeService } from "../messages/messages-realtime.service";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import OpenAI, { toFile } from "openai";
import { AppConfigService } from "../app/app-config.service";
import { ChannelMessagesService } from "../group-channels/channel-messages.service";
import { isProtectedChannelKey } from "../group-channels/channel-media.service";
import { JobsService } from "../jobs/jobs.service";
import { JOBS } from "../jobs/jobs.constants";
import { PrismaService } from "../prisma/prisma.service";
import { SideEffectsRegistry } from "../side-effects/side-effects.registry";

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const PROMPT =
  "A short voice note between members of Men of Hunger, a Christian community. Transcribe verbatim with correct punctuation and capitalization. Keep proper nouns, names, and scripture references accurate.";
const CONTENT_TYPES: Record<string, string> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  webm: "audio/webm",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
};

class PermanentTranscriptionError extends Error {}

@Injectable()
export class TranscriptionService implements OnModuleInit {
  private readonly logger = new Logger(TranscriptionService.name);
  private readonly s3: S3Client | null;
  private client: OpenAI | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly registry: SideEffectsRegistry,
    private readonly jobs: JobsService,
    private readonly dms: MessagesRealtimeService,
    private readonly channels: ChannelMessagesService,
  ) {
    const r2 = config.r2();
    this.s3 = r2
      ? new S3Client({
          region: "auto",
          endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
          credentials: {
            accessKeyId: r2.accessKeyId,
            secretAccessKey: r2.secretAccessKey,
          },
        })
      : null;
  }

  onModuleInit() {
    this.registry.register(
      "media.transcribe.request",
      async ({ messageId }) => {
        await this.request(messageId);
      },
    );
  }

  async request(messageId: string) {
    if (!this.config.audioTranscription().enabled) return;
    const pending = await this.prisma.messageMedia.findMany({
      where: {
        messageId,
        kind: "audio",
        source: "upload",
        transcriptStatus: null,
        r2Key: { not: null },
      },
      select: { id: true },
    });
    for (const { id } of pending) {
      const claimed = await this.prisma.messageMedia.updateMany({
        where: { id, transcriptStatus: null },
        data: { transcriptStatus: "queued" },
      });
      if (claimed.count === 0) continue;
      await this.jobs.enqueue(
        JOBS.mediaTranscribe,
        { mediaId: id },
        {
          jobId: `transcribe-media-${id}`,
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        },
      );
    }
    if (pending.length > 0) await this.announce(messageId);
  }

  async process(mediaId: string, finalAttempt = true) {
    const settings = this.config.audioTranscription();
    const media = await this.prisma.messageMedia.findUnique({
      where: { id: mediaId },
      select: {
        id: true,
        messageId: true,
        r2Key: true,
        transcriptStatus: true,
      },
    });
    if (
      !media?.r2Key ||
      (media.transcriptStatus !== "queued" &&
        media.transcriptStatus !== "processing")
    )
      return;
    if (!settings.enabled) return;
    await this.prisma.messageMedia.update({
      where: { id: mediaId },
      data: { transcriptStatus: "processing" },
    });
    try {
      const text = await this.transcribe(media.r2Key, settings);
      await this.prisma.messageMedia.update({
        where: { id: mediaId },
        data: {
          transcriptStatus: "ready",
          transcript: text,
          transcribedAt: new Date(),
        },
      });
    } catch (error) {
      if (error instanceof PermanentTranscriptionError || finalAttempt) {
        this.logger.warn(
          `Transcription failed for ${mediaId}: ${(error as Error).message}`,
        );
        await this.prisma.messageMedia.update({
          where: { id: mediaId },
          data: { transcriptStatus: "failed" },
        });
        await this.announce(media.messageId);
        if (error instanceof PermanentTranscriptionError) return;
      }
      throw error;
    }
    await this.announce(media.messageId);
  }

  private async transcribe(
    key: string,
    settings: ReturnType<AppConfigService["audioTranscription"]>,
  ) {
    const protectedKey = isProtectedChannelKey(key);
    const bucket = protectedKey
      ? this.config.channelMediaBucket()
      : this.config.r2()?.bucket;
    if (!this.s3 || !bucket) throw new Error("Storage is not configured.");
    let object;
    try {
      object = await this.s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "NoSuchKey" || error.name === "NotFound")
      )
        throw new PermanentTranscriptionError("Audio is gone.");
      throw error;
    }
    if (!object.Body || (object.ContentLength ?? 0) > MAX_AUDIO_BYTES)
      throw new PermanentTranscriptionError("Audio is empty or too large.");
    const bytes = await object.Body.transformToByteArray();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES)
      throw new PermanentTranscriptionError("Audio is empty or too large.");
    const extension = key.split(".").pop()?.toLowerCase() ?? "m4a";
    this.client ??= new OpenAI({ apiKey: settings.apiKey });
    const file = await toFile(bytes, `voice.${extension}`, {
      type: CONTENT_TYPES[extension] ?? "audio/mp4",
    });
    const result = await this.client.audio.transcriptions.create({
      file,
      model: settings.model,
      prompt: PROMPT,
      response_format: "json",
    });
    return result.text.trim();
  }

  private async announce(messageId: string) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { conversationId: true, threadRootId: true },
    });
    if (!message) return;
    const channel = await this.prisma.groupChannel.findUnique({
      where: { conversationId: message.conversationId },
      select: { id: true, groupId: true },
    });
    if (channel)
      await this.channels.publishMediaChange(
        channel.groupId,
        channel.id,
        messageId,
      );
    else await this.dms.rebroadcastMessage(messageId);
  }
}
