import { Module } from '@nestjs/common';
import { PostsModule } from '../posts/posts.module';
import { ArticlesModule } from '../articles/articles.module';
import { BoardModule } from '../board/board.module';
import { BookmarksModule } from '../bookmarks/bookmarks.module';
import { SearchModule } from '../search/search.module';
import { TopicsModule } from '../topics/topics.module';
import { HashtagsModule } from '../hashtags/hashtags.module';
import { CashtagsModule } from '../cashtags/cashtags.module';
import { LinkMetadataModule } from '../link-metadata/link-metadata.module';
import { GiphyModule } from '../giphy/giphy.module';
import { UploadsModule } from '../uploads/uploads.module';
import { AvatarVideoModule } from '../uploads/avatar-video.module';
import { PostViewsModule } from '../post-views/post-views.module';
import { ArticleViewsModule } from '../article-views/article-views.module';
import { DailyContentModule } from '../daily-content/daily-content.module';
import { ScriptureModule } from '../scripture/scripture.module';
import { Websters1828Module } from '../websters1828/websters1828.module';
import { RadioModule } from '../radio/radio.module';
import { FitnessModule } from '../fitness/fitness.module';
import { SpacesModule } from '../spaces/spaces.module';
import { TranscriptionModule } from '../transcription/transcription.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { ModerationScreenModule } from '../moderation-screen/moderation-screen.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';

/** Aggregate wiring for posts, articles, search, media, and daily content. Imports only; providers stay scoped to their own modules. */
@Module({
  imports: [
    PostsModule,
    ArticlesModule,
    BoardModule,
    BookmarksModule,
    SearchModule,
    TopicsModule,
    HashtagsModule,
    CashtagsModule,
    LinkMetadataModule,
    GiphyModule,
    UploadsModule,
    AvatarVideoModule,
    PostViewsModule,
    ArticleViewsModule,
    DailyContentModule,
    ScriptureModule,
    Websters1828Module,
    RadioModule,
    FitnessModule,
    SpacesModule,
    TranscriptionModule,
    EmbeddingsModule,
    ModerationScreenModule,
    TaxonomyModule,
  ],
})
export class ContentFeaturesModule {}
