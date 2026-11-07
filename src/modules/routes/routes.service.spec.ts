import { NotFoundException } from "@nestjs/common";
import { RoutesService } from "./routes.service";

describe("RoutesService (Sprint 2)", () => {
  let service: RoutesService;

  beforeEach(() => {
    service = new RoutesService();
  });

  it("debe obtener detalles de la ruta y paradas ordenadas", async () => {
    const route = await service.getRouteDetails(
      "018e38d9-3f00-7200-a000-000000000020",
    );
    expect(route.codigo).toBe("RUTA-SUR-01");
    expect(route.paradas.length).toBe(3);
    expect(route.srid).toBe(4326);
  });

  it("debe arrojar NotFoundException con ruta inexistente", async () => {
    await expect(service.getRouteDetails("not-found")).rejects.toThrow(
      NotFoundException,
    );
  });
});
