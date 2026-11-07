import { Controller, Post, Body } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import {
  PassengersService,
  OccasionalPassengerRequestDto,
} from "./passengers.service";

@ApiTags("Pasajeros Ocasionales (Sprint 3)")
@Controller("passengers")
export class PassengersController {
  constructor(private readonly passengersService: PassengersService) {}

  @Post("occasional-request")
  @ApiOperation({
    summary:
      "Solicitar cupo de pasajero ocasional con >= 2 horas de antelación (RN-03)",
  })
  @ApiResponse({ status: 200, description: "Cupo asignado." })
  @ApiResponse({
    status: 400,
    description: "Anticipación insuficiente o sin cupos liberados.",
  })
  async requestOccasionalSeat(@Body() dto: OccasionalPassengerRequestDto) {
    return this.passengersService.requestOccasionalSeat(dto);
  }
}
