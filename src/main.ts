import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './modules/app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  app.use(helmet());
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  const port = Number(config.get<string>('PORT') ?? '3001');

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Men of Hunger API')
    .setDescription('NestJS API intended for consumption by a Next.js app.')
    .setVersion('0.1.0')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  await app.listen(port);
}

void bootstrap();

