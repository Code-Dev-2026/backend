import { Module } from "@nestjs/common";
import { TransportCompaniesController } from "./transport-companies.controller";
import { TransportCompaniesService } from "./transport-companies.service";

@Module({
  controllers: [TransportCompaniesController],
  providers: [TransportCompaniesService],
  exports: [TransportCompaniesService],
})
export class TransportCompaniesModule {}
