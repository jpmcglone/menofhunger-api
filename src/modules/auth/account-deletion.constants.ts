/** `User.bannedReason` while a self-requested deletion is inside its grace window (the member can still sign in to cancel). */
export const ACCOUNT_DELETION_PENDING_REASON = 'self_deleted_pending';
/** `User.bannedReason` once the finalize job has claimed the account for erasure. */
export const ACCOUNT_DELETION_ERASING_REASON = 'self_deleted_erasing';
