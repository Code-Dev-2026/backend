import { Module } from "@nestjs/common";
import { BillingIsolationController } from "./billing-isolation.controller";
import { BillingIsolationService } from "./billing-isolation.service";

@Module({
  controllers: [BillingIsolationController],
  providers: [BillingIsolationService],
  exports: [BillingIsolationService],
})
export class BillingIsolationModule {}
