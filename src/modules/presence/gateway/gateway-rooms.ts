/** Room name + subscription-cap conventions shared by the gateway handler modules. */

export const MAX_POST_SUBSCRIPTIONS_PER_SOCKET = 60;
export const MAX_ARTICLE_SUBSCRIPTIONS_PER_SOCKET = 20;
export const MAX_GROUP_SUBSCRIPTIONS_PER_SOCKET = 20;

export function postRoom(postId: string): string {
  return `post:${postId}`;
}
export function channelRoom(channelId: string): string {
  return `channel:${channelId}`;
}
export const MAX_CHANNEL_SUBSCRIPTIONS_PER_SOCKET = 300;
export function groupRoom(groupId: string): string {
  return `group:${groupId}`;
}
/** Board list rooms by audience tier: public for everyone, verified/premium by viewer tier. */
export function boardRoom(tier: 'public' | 'verified' | 'premium'): string {
  return `board:${tier}`;
}
/** Members map rooms: counts for everyone, members (with faces) for verified viewers. */
export function membersMapRoom(access: 'counts' | 'members'): string {
  return `members-map:${access}`;
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
