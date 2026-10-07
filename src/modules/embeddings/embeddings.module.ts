import { Global, Module } from '@nestjs/common';
import { AppConfigModule } from '../app/app-config.module';
import { EmbeddingsCron } from './embeddings.cron';
import { EmbeddingsService } from './embeddings.service';

/** Global so search, onboarding, and recommendations can use vectors without importing each other. */
@Global()
@Module({
  imports: [AppConfigModule],
  providers: [EmbeddingsService, EmbeddingsCron],
  exports: [EmbeddingsService, EmbeddingsCron],
})
export class EmbeddingsModule {}
