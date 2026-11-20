import { UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { TokenService } from "./token.service";

describe("TokenService", () => {
  const jwt = new JwtService({ secret: "test-jwt-secret" });
  const service = new TokenService(jwt);
  const subject = {
    id_usuario: "018e38d9-3f00-7200-a000-000000000001",
    email: "coordinacion@sanbenito.edu.co",
    roles: ["COORDINADORA_CONVIVENCIA"],
  };

  it("debe emitir un Access Token de 15 minutos y verificarlo", async () => {
    const token = await service.signAccessToken(subject, true);
    const decoded = jwt.decode(token) as { iat: number; exp: number };
    const user = await service.verifyAccessToken(token);

    expect(decoded.exp - decoded.iat).toBe(900);
    expect(user).toEqual({
      id_usuario: subject.id_usuario,
      email: subject.email,
      roles: subject.roles,
      mfa_autenticado: true,
    });
  });

  it("debe marcar mfa_autenticado en false si MFA no fue verificado", async () => {
    const token = await service.signAccessToken(subject, false);
    const user = await service.verifyAccessToken(token);

    expect(user.mfa_autenticado).toBe(false);
  });

  it("debe emitir un token provisional MFA de 5 minutos", async () => {
    const token = await service.signMfaChallengeToken(subject);
    const decoded = jwt.decode(token) as { iat: number; exp: number };
    const result = await service.verifyMfaChallengeToken(token);

    expect(decoded.exp - decoded.iat).toBe(300);
    expect(result.id_usuario).toBe(subject.id_usuario);
  });

  it("debe rechazar un token provisional MFA usado como Access Token", async () => {
    const challenge = await service.signMfaChallengeToken(subject);

    await expect(service.verifyAccessToken(challenge)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("debe rechazar un Access Token usado como token provisional MFA", async () => {
    const access = await service.signAccessToken(subject, true);

    await expect(service.verifyMfaChallengeToken(access)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("debe rechazar un token expirado", async () => {
    const expired = await jwt.signAsync(
      {
        sub: subject.id_usuario,
        email: subject.email,
        roles: subject.roles,
        mfa: true,
        typ: "access",
      },
      { expiresIn: "-10s" },
    );

    await expect(service.verifyAccessToken(expired)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("debe rechazar un token manipulado", async () => {
    const token = await service.signAccessToken(subject, false);
    const [header, , signature] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...subject, sub: subject.id_usuario, mfa: true, typ: "access" }),
    ).toString("base64url");

    await expect(
      service.verifyAccessToken(`${header}.${forgedPayload}.${signature}`),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("debe rechazar un token firmado con otro secreto", async () => {
    const other = new JwtService({ secret: "otro-secreto" });
    const foreign = await other.signAsync({
      sub: subject.id_usuario,
      email: subject.email,
      roles: subject.roles,
      mfa: true,
      typ: "access",
    });

    await expect(service.verifyAccessToken(foreign)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
