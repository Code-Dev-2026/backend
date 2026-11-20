import * as bcrypt from "bcryptjs";
import { Argon2idPasswordHasher } from "./argon2id-password-hasher";

class HasherSinArgon2 extends Argon2idPasswordHasher {
  protected loadArgon2() {
    return null;
  }
}

describe("Argon2idPasswordHasher", () => {
  const hasher = new Argon2idPasswordHasher();

  it("debe generar un hash Argon2id con los parámetros ASVS", async () => {
    const hash = await hasher.hash("ContrasenaSegura#2026");

    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).toContain("m=65536,t=3,p=4");
  });

  it("debe verificar una contraseña correcta", async () => {
    const hash = await hasher.hash("ContrasenaSegura#2026");

    await expect(hasher.verify("ContrasenaSegura#2026", hash)).resolves.toBe(
      true,
    );
  });

  it("debe rechazar una contraseña incorrecta", async () => {
    const hash = await hasher.hash("ContrasenaSegura#2026");

    await expect(hasher.verify("otra-contrasena", hash)).resolves.toBe(false);
  });

  it("debe generar hashes distintos para la misma contraseña (salt)", async () => {
    const a = await hasher.hash("misma-contrasena");
    const b = await hasher.hash("misma-contrasena");

    expect(a).not.toBe(b);
  });

  it("debe verificar hashes Bcrypt existentes", async () => {
    const bcryptHash = await bcrypt.hash("legado-bcrypt", 4);

    await expect(hasher.verify("legado-bcrypt", bcryptHash)).resolves.toBe(
      true,
    );
    await expect(hasher.verify("incorrecta", bcryptHash)).resolves.toBe(false);
  });

  it("debe usar Bcrypt como fallback si Argon2 no está disponible", async () => {
    const fallback = new HasherSinArgon2();
    const hash = await fallback.hash("fallback-pass");

    expect(hash.startsWith("$2")).toBe(true);
    await expect(fallback.verify("fallback-pass", hash)).resolves.toBe(true);
  });

  it("debe devolver false con entradas vacías o formato desconocido", async () => {
    await expect(hasher.verify("", "hash")).resolves.toBe(false);
    await expect(hasher.verify("pass", "")).resolves.toBe(false);
    await expect(hasher.verify("pass", "texto-plano")).resolves.toBe(false);
  });
});
