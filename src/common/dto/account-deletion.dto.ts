export type AccountDeletionRequestDto = {
  success: true;
  deletionScheduledAt: string;
  /** Private capability; reveal only to the account requesting deletion. */
  deletionStatusToken: string;
};
export type AccountDeletionStatusDto = {
  status: 'scheduled' | 'processing' | 'completed' | 'cancelled';
  scheduledAt: string;
  completedAt: string | null;
};
