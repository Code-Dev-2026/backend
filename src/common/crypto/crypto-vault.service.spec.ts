import { ConfigService } from "@nestjs/config";
import { AesEncryptionService } from "./aes-encryption.service";
import { BlindIndexService } from "./blind-index.service";
import { CryptoVaultService } from "./crypto-vault.service";

const MASTER = Buffer.alloc(32, 1).toString("base64");
const HMAC = Buffer.alloc(32, 2).toString("base64");

function config(values: Record<string, string | undefined>): ConfigService {
  return {
    get: jest.fn((key: string, def?: string) => values[key] ?? def),
  } as unknown as ConfigService;
}

function vault(values: Record<string, string | undefined>) {
  const cfg = config(values);
  return new CryptoVaultService(
    new AesEncryptionService(cfg),
    new BlindIndexService(cfg),
    cfg,
  );
}

describe("CryptoVaultService", () => {
  const service = vault({
    APP_ENCRYPTION_MASTER_KEY: MASTER,
    APP_BLIND_INDEX_HMAC_KEY: HMAC,
  });

  it("cifra con AES-256-GCM en formato key_version:iv:tag:ciphertext", () => {
    const enc = service.encrypt("Mateo Gómez Restrepo");
    const parts = enc.split(":");

    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(Buffer.from(parts[1], "base64")).toHaveLength(12); // IV de 96 bits
    expect(Buffer.from(parts[2], "base64")).toHaveLength(16); // tag GCM
    expect(enc).not.toContain("Mateo");
    expect(enc).toMatch(
      /^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
    );
  });

  it("descifra en memoria el valor original", () => {
    expect(service.decrypt(service.encrypt("Calle 10 # 5-20"))).toBe(
      "Calle 10 # 5-20",
    );
  });

  it("usa un IV distinto en cada cifrado", () => {
    expect(service.encrypt("1088123456")).not.toBe(
      service.encrypt("1088123456"),
    );
  });

  it("detecta manipulación del texto cifrado (integridad GCM)", () => {
    const [v, iv, tag, ct] = service.encrypt("asma").split(":");
    const tampered = Buffer.from(ct, "base64");
    tampered[0] ^= 0xff;

    expect(() =>
      service.decrypt(`${v}:${iv}:${tag}:${tampered.toString("base64")}`),
    ).toThrow();
  });

  it("genera un blind index HMAC-SHA256 determinístico de 64 hex", () => {
    const a = service.generateBlindIndex("1088123456");

    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(service.generateBlindIndex("1088123456")).toBe(a);
    expect(service.generateBlindIndex("1088123457")).not.toBe(a);
  });

  it("el blind index depende de la llave del sistema", () => {
    const otro = vault({
      APP_ENCRYPTION_MASTER_KEY: MASTER,
      APP_BLIND_INDEX_HMAC_KEY: Buffer.alloc(32, 3).toString("base64"),
    });

    expect(otro.generateBlindIndex("1088123456")).not.toBe(
      service.generateBlindIndex("1088123456"),
    );
  });

  it("encryptOptional/decryptOptional conservan null", () => {
    expect(service.encryptOptional(null)).toBeNull();
    expect(service.decryptOptional(null)).toBeNull();
    expect(service.decryptOptional(service.encryptOptional("asma"))).toBe(
      "asma",
    );
  });

  describe("en producción", () => {
    it("rechaza las llaves por defecto", () => {
      expect(() =>
        vault({
          NODE_ENV: "production",
          APP_ENCRYPTION_MASTER_KEY:
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          APP_BLIND_INDEX_HMAC_KEY: HMAC,
        }),
      ).toThrow("APP_ENCRYPTION_MASTER_KEY");
      expect(() =>
        vault({
          NODE_ENV: "production",
          APP_ENCRYPTION_MASTER_KEY: MASTER,
          APP_BLIND_INDEX_HMAC_KEY:
            "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
        }),
      ).toThrow("APP_BLIND_INDEX_HMAC_KEY");
    });

    it("rechaza usar la misma llave para cifrado e índice", () => {
      expect(() =>
        vault({
          NODE_ENV: "production",
          APP_ENCRYPTION_MASTER_KEY: MASTER,
          APP_BLIND_INDEX_HMAC_KEY: MASTER,
        }),
      ).toThrow("distintas");
    });

    it("acepta llaves propias", () => {
      expect(() =>
        vault({
          NODE_ENV: "production",
          APP_ENCRYPTION_MASTER_KEY: MASTER,
          APP_BLIND_INDEX_HMAC_KEY: HMAC,
        }),
      ).not.toThrow();
    });
  });
});
