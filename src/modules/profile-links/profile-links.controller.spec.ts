import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ProfileLinksController } from './profile-links.controller';

describe('ProfileLinksController route order', () => {
  it('declares me/links routes before :username/links', () => {
    const proto = ProfileLinksController.prototype as unknown as Record<string, unknown>;
    const routes = Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor' && Reflect.getMetadata(PATH_METADATA, proto[name] as object) !== undefined)
      .map((name) => ({
        path: Reflect.getMetadata(PATH_METADATA, proto[name] as object) as string,
        method: Reflect.getMetadata(METHOD_METADATA, proto[name] as object) as RequestMethod,
      }));
    const paths = routes.map((r) => r.path);
    expect(paths).toEqual(['me/links', 'me/links', 'me/links/settings', ':username/links']);
    expect(routes.map((r) => r.method)).toEqual([
      RequestMethod.GET,
      RequestMethod.PUT,
      RequestMethod.PATCH,
      RequestMethod.GET,
    ]);
    expect(Math.max(...paths.map((p, i) => (p.startsWith('me/') ? i : -1)))).toBeLessThan(paths.indexOf(':username/links'));
  });
});
