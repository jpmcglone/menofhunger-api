import { AdminGuard } from '../admin/admin.guard';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TaxonomyController } from './taxonomy.controller';
import { TaxonomyService } from './taxonomy.service';

@Module({
  imports: [AuthModule],
  controllers: [TaxonomyController],
  providers: [TaxonomyService, AdminGuard],
  exports: [TaxonomyService],
})
export class TaxonomyModule {}
