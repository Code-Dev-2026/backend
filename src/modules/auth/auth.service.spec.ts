import { UnauthorizedException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { IPasswordHasher } from "./domain/password-hasher.interface";
import { InMemoryUserRepository } from "./infrastructure/in-memory-user.repository";

class FakeHasher implements IPasswordHasher {
  verifyCalls = 0;
  async hash(plain: string) {
    return `fake:${plain}`;
  }
  async verify(plain: string, hash: string) {
    this.verifyCalls++;
    return hash === `fake:${plain}`;
  }
}

describe("AuthService", () => {
  const user = {
    id_usuario: "018e38d9-3f00-7200-a000-000000000002",
    email: "Acudiente@Correo.co",
    password_hash: "fake:ContrasenaSegura#2026",
    estado: "ACTIVO" as const,
    mfa_habilitado: false,
    roles: ["ACUDIENTE"],
  };

  let users: InMemoryUserRepository;
  let hasher: FakeHasher;
  let service: AuthService;

  beforeEach(() => {
    users = new InMemoryUserRepository();
    users.add(user);
    hasher = new FakeHasher();
    service = new AuthService(users, hasher);
  });

  it("debe devolver el usuario con credenciales válidas", async () => {
    const result = await service.validateCredentials(
      "acudiente@correo.co",
      "ContrasenaSegura#2026",
    );

    expect(result.id_usuario).toBe(user.id_usuario);
  });

  it("debe ignorar mayúsculas y espacios en el correo", async () => {
    await expect(
      service.validateCredentials(
        "  ACUDIENTE@correo.co ",
        "ContrasenaSegura#2026",
      ),
    ).resolves.toBeDefined();
  });

  it("debe rechazar una contraseña incorrecta", async () => {
    await expect(
      service.validateCredentials("acudiente@correo.co", "incorrecta"),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("debe rechazar un correo inexistente con el mismo mensaje", async () => {
    const error = await service
      .validateCredentials("nadie@correo.co", "ContrasenaSegura#2026")
      .catch((e: UnauthorizedException) => e);
    const wrongPassword = await service
      .validateCredentials("acudiente@correo.co", "incorrecta")
      .catch((e: UnauthorizedException) => e);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).message).toBe(
      (wrongPassword as UnauthorizedException).message,
    );
  });

  it("debe hacer una verificación de relleno si el usuario no existe", async () => {
    await service
      .validateCredentials("nadie@correo.co", "cualquiera")
      .catch(() => undefined);

    expect(hasher.verifyCalls).toBe(1);
  });

  it.each(["INACTIVO", "BLOQUEADO"] as const)(
    "debe rechazar un usuario %s aunque la contraseña sea correcta",
    async (estado) => {
      users.setEstado(user.id_usuario, estado);

      await expect(
        service.validateCredentials(
          "acudiente@correo.co",
          "ContrasenaSegura#2026",
        ),
      ).rejects.toThrow(UnauthorizedException);
    },
  );

  it("debe rechazar credenciales vacías", async () => {
    await expect(service.validateCredentials("", "")).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
