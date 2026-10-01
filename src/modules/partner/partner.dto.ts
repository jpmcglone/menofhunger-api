import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PartnerProfileDto {
  @ApiProperty() id!: string;
  @ApiProperty() username!: string;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ type: String, nullable: true }) bio!: string | null;
  @ApiProperty({ type: String, nullable: true }) avatarUrl!: string | null;
  @ApiProperty() canonicalUrl!: string;
  @ApiProperty({ enum: ['person', 'page'] }) accountKind!: string;
  @ApiProperty() createdAt!: string;
  @ApiPropertyOptional({ type: 'object', properties: { followers: { type: 'integer' }, following: { type: 'integer' } } }) counts?: { followers: number; following: number };
}
export class PartnerVerificationDto {
  @ApiProperty() accountId!: string;
  @ApiProperty({ enum: ['none', 'manual', 'identity'] }) status!: string;
  @ApiProperty({ type: String, nullable: true }) verifiedAt!: string | null;
  @ApiProperty() checkedAt!: string;
}
export class PartnerMediaDto {
  @ApiProperty() kind!: string;
  @ApiProperty({ type: String, nullable: true }) url!: string | null;
  @ApiProperty({ type: String, nullable: true }) alt!: string | null;
  @ApiProperty({ type: Number, nullable: true }) width!: number | null;
  @ApiProperty({ type: Number, nullable: true }) height!: number | null;
}
export class PartnerEngagementDto {
  @ApiProperty({ description: 'Visible boosts from permitted, non-banned accounts.' }) boosts!: number;
  @ApiProperty({ description: 'Visible direct replies for posts, visible comments for articles.' }) comments!: number;
  @ApiProperty({ description: 'Recorded distinct signed-in viewers, filtered for permitted accounts; not reach.' }) uniqueViewers!: number;
  @ApiPropertyOptional({ description: 'Visible article reaction records; a member can use multiple reactions.' }) reactions?: number;
}
export class PartnerSourceDto {
  @ApiProperty() name!: string;
  @ApiProperty() url!: string;
}
export class PartnerContentDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['post', 'article'] }) kind!: string;
  @ApiProperty() canonicalUrl!: string;
  @ApiProperty({ enum: ['published'] }) status!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) editedAt!: string | null;
  @ApiProperty() body!: string;
  @ApiProperty({ enum: ['text', 'html'] }) bodyFormat!: string;
  @ApiProperty() publishedAt!: string;
  @ApiProperty({ type: PartnerSourceDto }) source!: PartnerSourceDto;
  @ApiPropertyOptional({ type: PartnerEngagementDto }) engagement?: PartnerEngagementDto;
  @ApiPropertyOptional() title?: string;
  @ApiPropertyOptional({ nullable: true }) excerpt?: string | null;
  @ApiProperty({ type: PartnerProfileDto }) author!: PartnerProfileDto;
  @ApiProperty({ type: [PartnerMediaDto] }) media!: PartnerMediaDto[];
}
export class PartnerConnectionDto {
  status?: 'active' | 'expired' | 'suspended' | 'needs_reauthorization';
  id!: string;
  clientName!: string;
  accountId!: string;
  scopes!: string[];
  createdAt!: string;
  expiresAt!: string;
}
export class XMonthlyAllowanceDto {
  totalLimit!: number;
  linkLimit!: number;
  totalRemaining!: number;
  linkRemaining!: number;
  resetsAt!: string;
  /** Compatibility aliases. */
  linkPostsLeft!: number;
  nativePostsLeft!: number;
}

export class PartnerPaginationDto {
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class PartnerArticleCommentDto {
  @ApiProperty() id!: string;
  @ApiProperty() articleId!: string;
  @ApiProperty({ type: String, nullable: true }) parentId!: string | null;
  @ApiProperty() body!: string;
  @ApiProperty({ enum: ['text'] }) bodyFormat!: string;
  @ApiProperty() canonicalUrl!: string;
  @ApiProperty({ enum: ['published'] }) status!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) editedAt!: string | null;
  @ApiProperty({ type: PartnerProfileDto }) author!: PartnerProfileDto;
}
export class PartnerContinuationDto {
  @ApiProperty() url!: string;
  @ApiProperty({ example: 600 }) expiresIn!: number;
}
