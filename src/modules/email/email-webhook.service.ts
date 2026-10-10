import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { isUniqueViolation } from "../../common/prisma/errors";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppConfigService } from "../app/app-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailDeliveryService } from "./email-delivery.service";
import { EmailPreferencesService } from "./email-preferences.service";

const schema = z
  .object({
    type: z.string(),
    data: z
      .object({
        email_id: z.string(),
        to: z.array(z.string()).optional(),
        bounce: z
          .object({ type: z.string().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** Svix documented HMAC protocol. Exact raw bytes and a bounded timestamp are mandatory. */
export function verifyResendSignature(
  raw: Buffer,
  headers: Record<string, string | undefined>,
  secret: string,
  now = Date.now(),
): void {
  const id = headers["svix-id"];
  const timestamp = headers["svix-timestamp"];
  const signatures = headers["svix-signature"];
  if (
    !id ||
    !timestamp ||
    !signatures ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300
  )
    throw new BadRequestException("Invalid email webhook signature.");
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (!key.length)
    throw new BadRequestException("Invalid email webhook signature.");
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.`)
    .update(raw)
    .digest();
  const valid = signatures.split(" ").some((signature) => {
    const [version, value] = signature.split(",");
    if (version !== "v1" || !value) return false;
    const candidate = Buffer.from(value, "base64");
    return (
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected)
    );
  });
  if (!valid) throw new BadRequestException("Invalid email webhook signature.");
}

@Injectable()
export class EmailWebhookService {
  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly delivery: EmailDeliveryService,
    private readonly preferences: EmailPreferencesService,
  ) {}

  async receive(
    raw: Buffer | undefined,
    headers: Record<string, string | undefined>,
  ): Promise<{ ok: true }> {
    const secret = this.config.emailWebhookSecret();
    if (!secret)
      throw new ServiceUnavailableException("Email webhook is not configured.");
    if (!raw)
      throw new BadRequestException("Email webhook requires a raw body.");
    verifyResendSignature(raw, headers, secret);
    let event: z.infer<typeof schema>;
    try {
      event = schema.parse(JSON.parse(raw.toString("utf8")));
    } catch {
      throw new BadRequestException("Invalid email webhook.");
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.emailProviderEvent.create({
          data: {
            id: headers["svix-id"]!,
            type: event.type,
            messageId: event.data.email_id,
          },
        });
        const row = await tx.emailDelivery.findUnique({
          where: { providerMessageId: event.data.email_id },
        });
        // Provider events can arrive before send() saves the ID. Authenticated to[]
        // still ensures complaints/bounces immediately stop later sends.
        const hashes = new Set(
          (event.data.to ?? []).map((to) => this.preferences.recipientHash(to)),
        );
        if (row) hashes.add(row.recipientHash);
        const complained = event.type === "email.complained";
        const bounced = event.type === "email.bounced";
        if (complained || bounced) {
          // Resend emits bounced after final delivery failure, not a delivery delay.
          for (const hash of hashes)
            await this.delivery.suppress(
              hash,
              complained ? "complaint" : "bounce",
              tx,
            );
        }
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A repeated Svix event is already committed; processing is transactional.
    }
    // The send result may bind the provider ID during this transaction. Reading
    // again after commit closes that overlap, including replay of a committed event.
    await this.delivery.reconcileProviderEvents(event.data.email_id);
    return { ok: true };
  }
}
