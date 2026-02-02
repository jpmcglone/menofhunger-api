import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  root() {
    return { data: { service: 'menofhunger-api' } };
  }
}

