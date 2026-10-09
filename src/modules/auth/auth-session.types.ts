import type { toUserDto } from '../../common/dto/user.dto';

export interface SessionResult {
  user: ReturnType<typeof toUserDto>;
  sessionId: string;
  expiresAt: Date;
  renewed: boolean;
  /**
   * Set when this session was created by a site admin impersonating `user`.
   * The effective identity is still `user`; this is the admin really driving it.
   */
  impersonatedByUserId: string | null;
  /**
   * Set when a person is acting as a page. Effective identity is still `user` (the page).
   */
  operatedByUserId: string | null;
}
