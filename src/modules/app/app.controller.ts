import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';

@Controller()
export class AppController {
  @Get()
  root() {
    return { data: { service: 'menofhunger-api' } };
  }

  /**
   * Apple App Site Association file for universal links.
   * Must be served at /.well-known/apple-app-site-association with Content-Type: application/json
   * and MUST NOT be wrapped in the API envelope (Apple validates the raw JSON).
   * Replace TEAMID with your Apple Developer Team ID and update the bundle ID as needed.
   */
  @Get('.well-known/apple-app-site-association')
  appleAppSiteAssociation(@Res() res: Response) {
    const aasa = {
      applinks: {
        apps: [],
        details: [
          {
            appIDs: ['TEAMID.com.menofhunger.app'],
            components: [
              { '/': '/p/*', comment: 'Post detail' },
              { '/': '/u/*', comment: 'User profile' },
              { '/': '/login', comment: 'Login' },
            ],
          },
        ],
      },
      webcredentials: {
        apps: ['TEAMID.com.menofhunger.app'],
      },
    };
    res.setHeader('Content-Type', 'application/json');
    res.json(aasa);
  }
}

