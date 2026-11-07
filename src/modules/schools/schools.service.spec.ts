import { NotFoundException } from "@nestjs/common";
import { SchoolsService } from "./schools.service";

describe("SchoolsService (Sprint 1)", () => {
  let service: SchoolsService;

  beforeEach(() => {
    service = new SchoolsService();
  });

  it("debe retornar información del Colegio San Benito del Otún", async () => {
    const school = await service.getSanBenitoInfo();
    expect(school.nombre).toContain("San Benito del Otún");
    expect(school.activo).toBe(true);
  });

  it("debe buscar colegio por ID", async () => {
    const school = await service.findById(
      "018e38d9-3f00-7200-a000-000000000002",
    );
    expect(school.id_colegio).toBe("018e38d9-3f00-7200-a000-000000000002");
  });

  it("debe arrojar NotFoundException si el colegio no existe", async () => {
    await expect(service.findById("unknown-id")).rejects.toThrow(
      NotFoundException,
    );
  });
});
