import { Module } from "@nestjs/common";
import { CustodyModule } from "../custody/custody.module";
import { TripsController } from "./trips.controller";
import { TripsService } from "./trips.service";

@Module({
  imports: [CustodyModule],
  controllers: [TripsController],
  providers: [TripsService],
  exports: [TripsService],
})
export class TripsModule {}
