import { BadRequestException } from "@nestjs/common";
import { PassengersService } from "./passengers.service";

describe("PassengersService (Sprint 3)", () => {
  let service: PassengersService;

  beforeEach(() => {
    service = new PassengersService();
  });

  it("debe aprobar solicitud con >= 2 horas de antelación (RN-03)", async () => {
    const result = await service.requestOccasionalSeat({
      id_estudiante: "est-1",
      id_viaje: "trip-1",
      id_parada_destino: "stop-2",
      autorizado_por_acudiente: true,
      horas_anticipacion: 3,
    });

    expect(result.solicitud_aprobada).toBe(true);
    expect(result.cupo_asignado).toBeDefined();
  });

  it("debe rechazar solicitud con menos de 2 horas de antelación", async () => {
    await expect(
      service.requestOccasionalSeat({
        id_estudiante: "est-1",
        id_viaje: "trip-1",
        id_parada_destino: "stop-2",
        autorizado_por_acudiente: true,
        horas_anticipacion: 1,
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
