/** Room name + subscription-cap conventions shared by the gateway handler modules. */

export const MAX_POST_SUBSCRIPTIONS_PER_SOCKET = 60;
export const MAX_ARTICLE_SUBSCRIPTIONS_PER_SOCKET = 20;
export const MAX_GROUP_SUBSCRIPTIONS_PER_SOCKET = 20;

export function postRoom(postId: string): string {
  return `post:${postId}`;
}
export function groupRoom(groupId: string): string {
  return `group:${groupId}`;
}
export function articleRoom(articleId: string): string {
  return `article:${articleId}`;
}
export function radioChatRoom(stationId: string): string {
  return `radioChat:${stationId}`;
}
export function spaceRoom(spaceId: string): string {
  return `space:${spaceId}`;
}
export function spacesChatRoom(spaceId: string): string {
  return `spacesChat:${spaceId}`;
}
