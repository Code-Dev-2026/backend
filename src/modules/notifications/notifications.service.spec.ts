import { NotificationsService } from "./notifications.service";

describe("NotificationsService (Sprint 3)", () => {
  let service: NotificationsService;

  beforeEach(() => {
    service = new NotificationsService();
  });

  it("debe despachar notificación push cumpliendo SLA < 2.5s", async () => {
    const result = await service.sendPushNotification({
      id_estudiante: "est-1",
      id_acudiente: "acu-1",
      titulo: "Abordaje Confirmado",
      mensaje: "Su hijo ha abordado la ruta escolar.",
      tipo_alerta: "TRANSICION_CUSTODIA",
    });

    expect(result.despachado).toBe(true);
    expect(result.cumple_sla_2_5s).toBe(true);
    expect(result.id_notificacion).toBeDefined();
  });
});
