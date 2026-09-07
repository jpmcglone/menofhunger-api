import { z } from 'zod';

export const AVATAR_VIDEO_QUEUE = 'moh_avatar_video';
export const AVATAR_VIDEO_MAX_INPUT_BYTES = 100 * 1024 * 1024;
export const AVATAR_VIDEO_MAX_OUTPUT_BYTES = 512 * 1024;
export const avatarVideoSelectionSchema = z.object({
  startSeconds: z.number().finite().min(0).max(600),
  durationSeconds: z.number().finite().min(0.1).max(5),
  // Normalized coordinates in the orientation-corrected source image.
  crop: z.object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1),
  }).refine(c => c.x + c.width <= 1.00001 && c.y + c.height <= 1.00001, 'Crop must fit inside the video.'),
});
export type AvatarVideoSelection = z.infer<typeof avatarVideoSelectionSchema>;

export function avatarCropPixels(selection: AvatarVideoSelection, width: number, height: number) {
  const c = selection.crop;
  const cropWidth = c.width * width;
  const cropHeight = c.height * height;
  if (Math.abs(cropWidth - cropHeight) > Math.max(2, cropWidth * 0.01)) {
    throw new Error('Please choose a square crop.');
  }
  const size = Math.max(2, Math.floor(Math.min(cropWidth, cropHeight) / 2) * 2);
  return { size, x: Math.min(width - size, Math.floor(c.x * width)), y: Math.min(height - size, Math.floor(c.y * height)) };
}
