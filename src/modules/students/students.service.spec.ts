import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { StudentsService } from "./students.service";
import { AesEncryptionService } from "@common/crypto/aes-encryption.service";
import { BlindIndexService } from "@common/crypto/blind-index.service";
import { NotFoundException } from "@nestjs/common";

describe("StudentsService (Sprint 1)", () => {
  let service: StudentsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StudentsService,
        AesEncryptionService,
        BlindIndexService,
        {
          provide: ConfigService,
          useValue: {
            get: jest
              .fn()
              .mockReturnValue("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
          },
        },
      ],
    }).compile();

    service = module.get<StudentsService>(StudentsService);
  });

  it("debe obtener y descifrar el perfil de estudiante", async () => {
    const student = await service.getStudentById(
      "018e38d9-3f00-7200-a000-000000000001",
    );
    expect(student.nombres).toBe("Mateo");
    expect(student.apellidos).toBe("Gómez Restrepo");
    expect(student.activo).toBe(true);
  });

  it("debe arrojar NotFoundException si no existe", async () => {
    await expect(service.getStudentById("not-found")).rejects.toThrow(
      NotFoundException,
    );
  });

  it("debe buscar documento mediante blind indexing", async () => {
    const result = await service.findByDocument("1088123456");
    expect(result.blindIndexFound).toBeDefined();
    expect(result.blindIndexFound.length).toBe(64);
  });
});
