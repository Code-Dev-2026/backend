import { NotFoundException } from "@nestjs/common";
import { TransportCompaniesService } from "./transport-companies.service";

describe("TransportCompaniesService (Sprint 1)", () => {
  let service: TransportCompaniesService;

  beforeEach(() => {
    service = new TransportCompaniesService();
  });

  it("debe obtener la información de la empresa de transporte", async () => {
    const info = await service.getCompanyInfo();
    expect(info.razon_social).toBe("Transportes Camino Seguro S.A.S.");
  });

  it("debe obtener la flota de vehículos homologados con capacidad nominal estricta", async () => {
    const fleet = await service.getFleet();
    expect(fleet.length).toBeGreaterThan(0);
    expect(fleet[0].capacidad_pasajeros).toBe(24);
  });

  it("debe consultar vehículo por ID", async () => {
    const vehicle = await service.getVehicleById(
      "018e38d9-3f00-7200-a000-000000000010",
    );
    expect(vehicle.placa).toBe("WGA123");
  });

  it("debe arrojar NotFoundException si el vehículo no existe", async () => {
    await expect(service.getVehicleById("non-existent")).rejects.toThrow(
      NotFoundException,
    );
  });
});
