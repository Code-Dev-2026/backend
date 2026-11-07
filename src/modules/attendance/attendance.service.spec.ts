import { AttendanceService } from "./attendance.service";
import { CustodyStateEnum } from "@common/enums/custody-state.enum";

describe("AttendanceService (Sprint 2)", () => {
  let service: AttendanceService;

  beforeEach(() => {
    service = new AttendanceService();
  });

  it("debe registrar el abordaje si hay aforo disponible (RN-01)", async () => {
    const result = await service.registerBoarding({
      id_viaje: "trip-1",
      qr_token: "valid-token",
      id_parada: "stop-1",
    });

    expect(result.estado_custodia).toBe(CustodyStateEnum.A_BORDO_VEHICULO);
    expect(result.aforo_resultante).toBe(24);
  });

  it("debe registrar el descenso en paradero", async () => {
    const result = await service.registerAlighting("trip-1", "est-1");
    expect(result.estado_custodia).toBe(CustodyStateEnum.ENTREGADO_A_TUTOR);
  });
});
