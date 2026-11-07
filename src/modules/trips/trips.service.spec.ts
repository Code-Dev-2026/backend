import { BadRequestException } from "@nestjs/common";
import { TripsService } from "./trips.service";
import { TripStateEnum } from "@common/enums/trip-state.enum";

describe("TripsService (Sprint 2)", () => {
  let service: TripsService;

  beforeEach(() => {
    service = new TripsService();
  });

  it("debe despachar un nuevo viaje", async () => {
    const result = await service.dispatchTrip({
      id_ruta: "route-1",
      id_vehiculo: "veh-1",
      id_conductor: "cond-1",
      id_monitora: "mon-1",
      sentido: "IDA_COLEGIO",
    });

    expect(result.estado).toBe(TripStateEnum.PROGRAMADO);
    expect(result.id_viaje).toBeDefined();
  });

  it("debe arrojar BadRequestException si faltan datos", async () => {
    await expect(
      service.dispatchTrip({
        id_ruta: "",
        id_vehiculo: "",
        id_conductor: "",
        id_monitora: "",
        sentido: "IDA_COLEGIO",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("debe iniciar y finalizar un viaje", async () => {
    const started = await service.startTrip("trip-1");
    expect(started.estado).toBe(TripStateEnum.EN_CURSO);

    const finished = await service.finishTrip("trip-1");
    expect(finished.estado).toBe(TripStateEnum.COMPLETADO);
  });
});
