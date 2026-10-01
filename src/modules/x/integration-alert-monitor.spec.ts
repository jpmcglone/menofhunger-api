import { IntegrationOperationsService } from './integration-operations.service';
import * as Sentry from '@sentry/nestjs';
jest.mock('@sentry/nestjs', () => ({ captureMessage: jest.fn() }));

describe('operational alert transitions', () => {
  it('notifies once per opening/escalation, resolves recovery, and alerts on recurrence', async () => {
    const alerts = new Map<string, any>();
    let spend = 80;
    const tx: any = { $executeRaw: jest.fn(), integrationOperationalAlert: {
      findUnique: async({where}:any)=>alerts.get(where.key),
      upsert: async({where,create,update}:any)=>alerts.set(where.key, alerts.has(where.key)?{...alerts.get(where.key),...update}:create),
      updateMany: async({where,data}:any)=>{for(const [key,row] of alerts)if(!where.key.notIn.includes(key))alerts.set(key,{...row,...data});},
    } };
    const prisma: any = { $transaction:(fn:any)=>fn(tx),integrationSpendControl:{findUnique:async()=>null},integrationUsageReservation:{count:async()=>0},
      $queryRaw:async(strings:any)=>String(strings).includes('integration:month')?[{company:BigInt(spend),daily:0n,provider:0n,bucket:0n,analytics:0n,publications:0n,regular:0n,expensive:0n,pendingRegular:0n,pendingExpensive:0n}]:[{count:0n}],
    };
    const service = new IntegrationOperationsService(prisma,{raw:()=>({ping:async()=>true})} as any,
      {integrationBudget:()=>({enabled:true,companyMonthlyMicros:100,companyDailyMicros:100,providerMonthlyMicros:100,sharedMonthlyMicros:100})} as any,
      {} as any,{} as any,{prune:jest.fn()} as any);
    const notify=Sentry.captureMessage as jest.Mock;notify.mockClear();
    await service.check(); await service.check(); expect(notify).toHaveBeenCalledTimes(1);
    spend=100;await service.check();expect(notify).toHaveBeenCalledTimes(2);
    spend=20;await service.check();expect(alerts.get('company-month').resolvedAt).toBeInstanceOf(Date);
    spend=80;await service.check();expect(notify).toHaveBeenCalledTimes(3);
  });
});
