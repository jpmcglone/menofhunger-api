import { publicAssetUrl } from '../assets/public-asset-url';

export type AvatarVideoDto = {
  id: string;
  url: string;
  durationMs: number;
  width: number;
  height: number;
};

export type AvatarVideoCapabilitiesDto = {
  canSet: boolean;
  maxBytes: number;
  maxDurationSeconds: number;
};

export type AvatarVideoUploadDto = {
  id: string;
  status: string;
  error: string | null;
};

export function toAvatarVideoDto(
  row: { avatarVideoKey?: string | null; avatarVideoDurationMs?: number | null },
  publicBaseUrl: string | null | undefined,
): AvatarVideoDto | null {
  const url = publicAssetUrl({ publicBaseUrl, key: row.avatarVideoKey });
  if (!url || !row.avatarVideoKey || !row.avatarVideoDurationMs) return null;
  return { id: row.avatarVideoKey, url, durationMs: row.avatarVideoDurationMs, width: 320, height: 320 };
}
