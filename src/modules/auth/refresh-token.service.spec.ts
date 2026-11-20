import { UnauthorizedException } from "@nestjs/common";
import { HashService } from "@common/crypto/hash.service";
import { RefreshTokenService } from "./refresh-token.service";
import { InMemoryTokenRepository } from "./infrastructure/in-memory-token.repository";

describe("RefreshTokenService", () => {
  const idUsuario = "018e38d9-3f00-7200-a000-000000000001";
  const hashService = new HashService();
  let repository: InMemoryTokenRepository;
  let audit: { registrarIncidente: jest.Mock };
  let service: RefreshTokenService;

  beforeEach(() => {
    repository = new InMemoryTokenRepository();
    audit = { registrarIncidente: jest.fn().mockResolvedValue(undefined) };
    service = new RefreshTokenService(repository, hashService, audit);
  });

  it("debe guardar solo el hash SHA-256 y no el token en claro", async () => {
    const { token } = await service.issue(idUsuario);
    const saved = await repository.consumeByHash(hashService.sha256(token));

    expect(saved.status).toBe("OK");
    expect(saved.token?.token_hash).toBe(hashService.sha256(token));
    expect(saved.token?.token_hash).not.toBe(token);
    expect(saved.token?.token_hash).toHaveLength(64);
  });

  it("debe rotar: consume el token y emite uno nuevo en la misma familia", async () => {
    const first = await service.issue(idUsuario);
    const second = await service.rotate(first.token);

    expect(second.idUsuario).toBe(idUsuario);
    expect(second.familyId).toBe(first.familyId);
    expect(second.token).not.toBe(first.token);
    expect(audit.registrarIncidente).not.toHaveBeenCalled();
  });

  it("debe permitir rotar varias veces seguidas con el token más reciente", async () => {
    const first = await service.issue(idUsuario);
    const second = await service.rotate(first.token);
    const third = await service.rotate(second.token);

    expect(third.familyId).toBe(first.familyId);
  });

  it("debe revocar toda la familia y auditar al reusar un token consumido", async () => {
    const first = await service.issue(idUsuario);
    const second = await service.rotate(first.token);

    await expect(service.rotate(first.token)).rejects.toThrow(
      UnauthorizedException,
    );

    // El token legítimo más reciente también queda revocado
    await expect(service.rotate(second.token)).rejects.toThrow(
      UnauthorizedException,
    );

    expect(audit.registrarIncidente).toHaveBeenCalledWith(
      expect.objectContaining({
        tipo_evento: "REFRESH_TOKEN_REUSE_DETECTED",
        id_usuario: idUsuario,
        payload: expect.objectContaining({ family_id: first.familyId }),
      }),
    );
  });

  it("no debe revocar familias de otras sesiones", async () => {
    const sessionA = await service.issue(idUsuario);
    const sessionB = await service.issue(idUsuario);
    const a2 = await service.rotate(sessionA.token);

    await expect(service.rotate(sessionA.token)).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(service.rotate(sessionB.token)).resolves.toBeDefined();
    expect(a2.familyId).not.toBe(sessionB.familyId);
  });

  it("debe rechazar un token desconocido sin generar incidente", async () => {
    await expect(service.rotate("token-inventado")).rejects.toThrow(
      UnauthorizedException,
    );
    expect(audit.registrarIncidente).not.toHaveBeenCalled();
  });

  it("debe rechazar un token vacío", async () => {
    await expect(service.rotate("")).rejects.toThrow(UnauthorizedException);
  });

  it("debe rechazar un token expirado", async () => {
    const token = "token-expirado-de-prueba";
    await repository.save({
      id_token: "018e38d9-3f00-7200-a000-0000000000aa",
      id_usuario: idUsuario,
      family_id: "018e38d9-3f00-7200-a000-0000000000bb",
      token_hash: hashService.sha256(token),
      revocado: false,
      expira_en: new Date(Date.now() - 1000),
    });

    await expect(service.rotate(token)).rejects.toThrow(UnauthorizedException);
  });

  it("con dos rotaciones concurrentes del mismo token, solo una gana", async () => {
    const first = await service.issue(idUsuario);

    const results = await Promise.allSettled([
      service.rotate(first.token),
      service.rotate(first.token),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});
