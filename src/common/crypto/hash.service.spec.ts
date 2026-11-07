import { HashService } from "./hash.service";

describe("HashService (SHA-256 e Inmutabilidad WORM)", () => {
  let hashService: HashService;

  beforeEach(() => {
    hashService = new HashService();
  });

  it("debe generar un hash SHA-256 determinista de 64 caracteres", () => {
    const data = "camino_seguro_audit_event";
    const hash1 = hashService.sha256(data);
    const hash2 = hashService.sha256(data);

    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
  });

  it("debe generar encadenamiento criptográfico con chainHash", () => {
    const id = "018e38d9-3f00-7200-a000-000000000001";
    const prev =
      "0000000000000000000000000000000000000000000000000000000000000000";
    const payload = JSON.stringify({ action: "BOARDING" });
    const salt = "random_salt";

    const chained = hashService.chainHash(id, prev, payload, salt);
    expect(chained).toBeDefined();
    expect(chained.length).toBe(64);
  });

  it("debe hashear y verificar contraseñas correctamente", async () => {
    const password = "SuperSecretPassword#2026";
    const hashed = await hashService.hashPassword(password);

    expect(hashed.startsWith("pbkdf2:")).toBe(true);
    const isValid = await hashService.verifyPassword(password, hashed);
    expect(isValid).toBe(true);

    const isInvalid = await hashService.verifyPassword("WrongPassword", hashed);
    expect(isInvalid).toBe(false);
  });

  it("debe retornar false si contraseña o hash son inválidos", async () => {
    expect(await hashService.verifyPassword("", "invalid")).toBe(false);
    expect(await hashService.verifyPassword("pass", "")).toBe(false);
    expect(await hashService.verifyPassword("pass", "bad_format")).toBe(false);
  });
});
