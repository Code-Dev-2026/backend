import { Module } from '@nestjs/common';
import { BillingIsolationService } from './billing-isolation.service';
import { BillingIsolationController } from './billing-isolation.controller';

@Module({
  controllers: [BillingIsolationController],
  providers: [BillingIsolationService],
  exports: [BillingIsolationService],
})
export class BillingIsolationModule {}
