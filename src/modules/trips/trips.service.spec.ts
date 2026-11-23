import { BadRequestException, ConflictException } from "@nestjs/common";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import { CustodyService } from "../custody/custody.service";
import { FsmCustodyState, TripDirection } from "../custody/domain/custody.types";
import { TripsService } from "./trips.service";

describe("TripsService (Sprint 2)", () => {
  let service: TripsService;
  let custodyService: CustodyService;

  beforeEach(() => {
    custodyService = new CustodyService();
    service = new TripsService(custodyService);
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

  it("debe iniciar y finalizar un viaje en estado FINALIZADO cuando no hay menores a bordo", async () => {
    const started = await service.startTrip("trip-1");
    expect(started.estado).toBe(TripStateEnum.EN_CURSO);

    const finished = await service.finishTrip("trip-1");
    expect(finished.estado).toBe(TripStateEnum.FINALIZADO);
  });

  it("debe bloquear el cierre del viaje (FINALIZADO) si existen menores A_BORDO_VEHICULO (Issue #7)", async () => {
    const tripId = "018e38d9-3f00-7200-a000-000000000031";
    const studentId = "018e38d9-3f00-7200-a000-0000000000a1";

    await custodyService.enrollStudentInTrip(tripId, studentId);
    await custodyService.executeTransition({
      id_viaje: tripId,
      id_estudiante: studentId,
      estado_destino: FsmCustodyState.EN_ESPERA_ABORDAJE,
      tipo_recorrido: TripDirection.MANANA,
    });
    await custodyService.executeTransition({
      id_viaje: tripId,
      id_estudiante: studentId,
      estado_destino: FsmCustodyState.A_BORDO_VEHICULO,
      tipo_recorrido: TripDirection.MANANA,
    });

    await expect(service.finishTrip(tripId)).rejects.toThrow(ConflictException);

    // Tras desembarcar en colegio, el viaje sí puede cerrarse
    await custodyService.executeTransition({
      id_viaje: tripId,
      id_estudiante: studentId,
      estado_destino: FsmCustodyState.EN_COLEGIO,
      tipo_recorrido: TripDirection.MANANA,
    });

    const finished = await service.finishTrip(tripId);
    expect(finished.estado).toBe(TripStateEnum.FINALIZADO);
  });
});
