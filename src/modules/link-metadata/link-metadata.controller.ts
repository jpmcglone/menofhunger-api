import { profileLinkMetadata } from "./profile-link-metadata";
import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { z } from "zod";
import type { Response } from "express";
import { OptionalAuthGuard } from "../auth/optional-auth.guard";
import { LinkMetadataService } from "./link-metadata.service";
import { Throttle } from "@nestjs/throttler";
import {
  rateLimitLimit,
  rateLimitTtl,
} from "../../common/throttling/rate-limit.resolver";

const getSchema = z.object({
  url: z.string().trim().max(2048).url(),
  // Response-shape cache key used by clients when rich metadata fields change.
  v: z.coerce.number().int().positive().optional(),
  purpose: z.enum(["profile"]).optional(),
});

@UseGuards(OptionalAuthGuard)
@Controller("link-metadata")
export class LinkMetadataController {
  constructor(private readonly linkMetadata: LinkMetadataService) {}

  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 120),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get()
  async get(
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = getSchema.parse(query);
    const result = await this.linkMetadata.getMetadata(
      parsed.url,
      parsed.purpose === "profile",
    );
    const meta =
      parsed.purpose === "profile" ? profileLinkMetadata(result) : result;
    // Failed lookups must recover on retry, not persist in client/edge caches.
    res.setHeader(
      "Cache-Control",
      meta
        ? parsed.purpose === "profile"
          ? "public, max-age=86400"
          : "public, max-age=604800"
        : "no-store",
    );
    return { data: meta };
  }
}
