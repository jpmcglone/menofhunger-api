import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { PagesService } from './pages.service';
import { PersonAccountGuard } from './person-account.guard';

@Module({
  imports: [AuthModule, BillingModule],
  providers: [PagesService, PersonAccountGuard],
  exports: [PagesService, PersonAccountGuard],
})
export class PagesModule {}
