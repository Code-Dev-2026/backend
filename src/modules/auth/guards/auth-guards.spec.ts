import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { TokenService } from "../token.service";
import { AppMfaGuard } from "./app-mfa.guard";
import { JwtAuthGuard } from "./jwt-auth.guard";

function makeContext(
  request: Record<string, unknown>,
  type: string = "http",
): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function makeReflector(isPublic: boolean): Reflector {
  return {
    getAllAndOverride: jest.fn().mockReturnValue(isPublic),
  } as unknown as Reflector;
}

describe("JwtAuthGuard", () => {
  const jwt = new JwtService({ secret: "test-jwt-secret" });
  const tokens = new TokenService(jwt);
  const subject = {
    id_usuario: "018e38d9-3f00-7200-a000-000000000002",
    email: "acudiente@correo.co",
    roles: ["ACUDIENTE"],
  };

  it("debe dejar pasar rutas públicas sin token", async () => {
    const guard = new JwtAuthGuard(makeReflector(true), tokens);

    await expect(guard.canActivate(makeContext({ headers: {} }))).resolves.toBe(
      true,
    );
  });

  it("debe dejar pasar contextos que no son HTTP", async () => {
    const guard = new JwtAuthGuard(makeReflector(false), tokens);

    await expect(
      guard.canActivate(makeContext({ headers: {} }, "rpc")),
    ).resolves.toBe(true);
  });

  it("debe rechazar si no hay cabecera Authorization", async () => {
    const guard = new JwtAuthGuard(makeReflector(false), tokens);

    await expect(
      guard.canActivate(makeContext({ headers: {} })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("debe rechazar un esquema distinto de Bearer", async () => {
    const guard = new JwtAuthGuard(makeReflector(false), tokens);
    const request = { headers: { authorization: "Basic abc123" } };

    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("debe aceptar un Access Token válido y poblar request.user", async () => {
    const guard = new JwtAuthGuard(makeReflector(false), tokens);
    const token = await tokens.signAccessToken(subject, false);
    const request: Record<string, unknown> = {
      headers: { authorization: `Bearer ${token}` },
    };

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({ id_usuario: subject.id_usuario });
  });

  it("debe rechazar un token inválido", async () => {
    const guard = new JwtAuthGuard(makeReflector(false), tokens);
    const request = { headers: { authorization: "Bearer no.es.jwt" } };

    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("debe rechazar el token provisional MFA como Access Token", async () => {
    const guard = new JwtAuthGuard(makeReflector(false), tokens);
    const challenge = await tokens.signMfaChallengeToken(subject, "desafio-1");
    const request = { headers: { authorization: `Bearer ${challenge}` } };

    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

describe("AppMfaGuard", () => {
  const coordinadora = {
    id_usuario: "u1",
    email: "c@x.co",
    roles: ["COORDINADORA_CONVIVENCIA"],
  };

  it("debe dejar pasar rutas públicas aunque no haya usuario", () => {
    const guard = new AppMfaGuard(makeReflector(true));

    expect(guard.canActivate(makeContext({}))).toBe(true);
  });

  it("debe dejar pasar contextos que no son HTTP", () => {
    const guard = new AppMfaGuard(makeReflector(false));

    expect(guard.canActivate(makeContext({}, "rpc"))).toBe(true);
  });

  it("debe bloquear a un rol directivo sin MFA verificado", () => {
    const guard = new AppMfaGuard(makeReflector(false));
    const request = { user: { ...coordinadora, mfa_autenticado: false } };

    expect(() => guard.canActivate(makeContext(request))).toThrow(
      UnauthorizedException,
    );
  });

  it("debe permitir a un rol directivo con MFA verificado", () => {
    const guard = new AppMfaGuard(makeReflector(false));
    const request = { user: { ...coordinadora, mfa_autenticado: true } };

    expect(guard.canActivate(makeContext(request))).toBe(true);
  });

  it("debe permitir a un rol sin MFA obligatorio", () => {
    const guard = new AppMfaGuard(makeReflector(false));
    const request = {
      user: { id_usuario: "u2", email: "a@x.co", roles: ["ACUDIENTE"] },
    };

    expect(guard.canActivate(makeContext(request))).toBe(true);
  });
});
