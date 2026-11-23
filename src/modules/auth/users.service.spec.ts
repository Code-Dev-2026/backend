import { ConflictException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateUserDto } from "./dto/create-user.dto";
import { Argon2idPasswordHasher } from "./infrastructure/argon2id-password-hasher";
import { InMemoryUserRepository } from "./infrastructure/in-memory-user.repository";
import { UsersService } from "./users.service";

describe("UsersService", () => {
  const dto = {
    email: "Conductor@Transportes.co",
    password: "ContrasenaSegura2026",
    rol: "CONDUCTOR",
  };

  let users: InMemoryUserRepository;
  let hasher: Argon2idPasswordHasher;
  let service: UsersService;

  beforeEach(() => {
    users = new InMemoryUserRepository();
    hasher = new Argon2idPasswordHasher();
    service = new UsersService(users, hasher);
  });

  it("crea el usuario con id UUIDv7 y contraseña en Argon2id", async () => {
    const created = await service.create(dto);
    const stored = await users.findByEmail(dto.email);

    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(created).toEqual({
      id: created.id,
      email: "conductor@transportes.co",
      rol: "CONDUCTOR",
      mfa_enabled: true,
      is_active: true,
    });
    expect(created).not.toHaveProperty("password_hash");
    expect(stored?.password_hash.startsWith("$argon2id$")).toBe(true);
    await expect(
      hasher.verify(dto.password, stored!.password_hash),
    ).resolves.toBe(true);
    expect(stored?.roles).toEqual(["CONDUCTOR"]);
    expect(stored?.estado).toBe("ACTIVO");
  }, 20_000);

  it("rechaza un correo ya registrado", async () => {
    await service.create(dto);

    await expect(
      service.create({ ...dto, email: "conductor@transportes.co" }),
    ).rejects.toThrow(ConflictException);
  }, 20_000);
});

describe("CreateUserDto", () => {
  async function errores(datos: Record<string, unknown>) {
    const result = await validate(plainToInstance(CreateUserDto, datos));
    return result.map((e) => e.property);
  }

  it("acepta datos válidos", async () => {
    await expect(
      errores({
        email: "monitora@transportes.co",
        password: "ContrasenaSegura2026",
        rol: "MONITORA",
      }),
    ).resolves.toEqual([]);
  });

  it("rechaza rol inexistente, correo inválido y contraseña débil", async () => {
    await expect(
      errores({ email: "x", password: "debil", rol: "HACKER" }),
    ).resolves.toEqual(expect.arrayContaining(["email", "password", "rol"]));
  });
});
