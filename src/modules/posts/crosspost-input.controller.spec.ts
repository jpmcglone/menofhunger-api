import { PostsController } from './posts.controller';
import { ScheduledPostsController } from './scheduled-posts.controller';

describe('crosspost request choices', () => {
  it.each(['link', 'native'])('preserves Pickax %s on immediate posts', async pickax => {
    const reachedMutation = new Error('mutation reached');
    const posts = { createPost: jest.fn().mockRejectedValue(reachedMutation) };
    await expect(PostsController.prototype.create.call({ posts }, { body: 'example.com', crosspost: { pickax } }, 'user')).rejects.toBe(reachedMutation);
    expect(posts.createPost).toHaveBeenCalledWith(expect.objectContaining({ crosspost: { pickax } }));
  });
  it('rejects X shares before creating a post', async () => {
    const posts = { createPost: jest.fn() };
    await expect(PostsController.prototype.create.call({ posts }, { body: 'Hello', crosspost: { x: 'link' } }, 'user')).rejects.toThrow();
    expect(posts.createPost).not.toHaveBeenCalled();
  });
  it.each(['link', 'native'])('preserves Pickax %s when scheduling and editing', async pickax => {
    const scheduledPosts = { createScheduled: jest.fn().mockResolvedValue({}), updateScheduled: jest.fn().mockResolvedValue({}) };
    const controller = new ScheduledPostsController(scheduledPosts as any);
    const crosspost = { pickax, x: 'native' };
    await controller.create({ body: 'Hello', visibility: 'public', scheduled_at: new Date(Date.now() + 600000).toISOString(), crosspost }, 'user');
    await controller.update('id', { crosspost }, 'user');
    expect(scheduledPosts.createScheduled).toHaveBeenCalledWith(expect.objectContaining({ crosspost }));
    expect(scheduledPosts.updateScheduled).toHaveBeenCalledWith(expect.objectContaining({ crosspost }));
  });
  it('rejects a scheduled X share before updating', async () => {
    const scheduledPosts = { updateScheduled: jest.fn() };
    await expect(new ScheduledPostsController(scheduledPosts as any).update('id', { crosspost: { x: 'link' } }, 'user')).rejects.toThrow();
    expect(scheduledPosts.updateScheduled).not.toHaveBeenCalled();
  });
});
