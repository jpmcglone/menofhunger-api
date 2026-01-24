import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './modules/app/app.module';
import { ApiResponseInterceptor } from './common/interceptors/api-response.interceptor';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { AppConfigService } from './modules/app/app-config.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  app.use(cookieParser());
  app.useGlobalInterceptors(new ApiResponseInterceptor());
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();

  const appConfig = app.get(AppConfigService);
  const port = appConfig.port();

  app.enableCors({
    credentials: true,
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Allow non-browser clients (no Origin header)
      if (!origin) return callback(null, true);
      if (appConfig.isOriginAllowed(origin)) return callback(null, true);
      // Avoid surfacing this as a 500; simply do not set CORS headers.
      // Browsers will block the response, and we log it server-side for clarity.
      appConfig.logCorsBlocked(origin);
      return callback(null, false);
    },
  });

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

