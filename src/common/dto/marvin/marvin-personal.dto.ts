export type MarvinPersonalActionDto = {
  id: string;
  kind: 'bookmark' | 'preferences' | 'draft';
  title: string;
  preview: string;
  draft: string | null;
  status: string;
  createdAt: string;
  expiresAt: string;
  receipt: string | null;
};
export type MarvinParticipationDto = {
  asOf: string;
  suggestions: { postId: string; username: string | null; name: string | null; body: string; reason: string }[];
};
