import { JwtService } from "@nestjs/jwt";
import { TokenService } from "../auth/token.service";
import {
  WsHandshakeAuthenticator,
  WsHandshakeError,
} from "./ws-handshake.authenticator";

const SECRET = "secreto-propio-de-prueba-0123456789-abcdef";

describe("WsHandshakeAuthenticator (Issue #14 — ASVS V3.2)", () => {
  const jwt = new JwtService({ secret: SECRET });
  const tokens = new TokenService(jwt);
  const authenticator = new WsHandshakeAuthenticator(tokens);

  const access = (roles: string[], mfa = false) =>
    tokens.signAccessToken(
      { id_usuario: "u-1", email: "u@test.co", roles },
      mfa,
    );

  const expectCode = async (promise: Promise<unknown>, code: string) => {
    await expect(promise).rejects.toBeInstanceOf(WsHandshakeError);
    await expect(promise).rejects.toMatchObject({ code });
  };

  it("rechaza el handshake sin token", async () => {
    await expectCode(
      authenticator.authenticate({ auth: {} }),
      "TOKEN_REQUIRED",
    );
    await expectCode(
      authenticator.authenticate({ headers: { authorization: "Basic abc" } }),
      "TOKEN_REQUIRED",
    );
  });

  it("rechaza tokens inválidos, firmados con otro secreto o expirados", async () => {
    await expectCode(
      authenticator.authenticate({ auth: { token: "no.es.jwt" } }),
      "TOKEN_INVALID",
    );

    const foreign = await new JwtService({
      secret: "otro-secreto-ajeno-0123456789-xyz",
    }).signAsync({
      sub: "u-1",
      email: "x",
      roles: ["ACUDIENTE"],
      mfa: false,
      typ: "access",
    });
    await expectCode(
      authenticator.authenticate({ auth: { token: foreign } }),
      "TOKEN_INVALID",
    );

    const expired = await jwt.signAsync(
      {
        sub: "u-1",
        email: "x",
        roles: ["ACUDIENTE"],
        mfa: false,
        typ: "access",
      },
      { expiresIn: -10 },
    );
    await expectCode(
      authenticator.authenticate({ auth: { token: expired } }),
      "TOKEN_INVALID",
    );
  });

  it("rechaza el token provisional de MFA (typ distinto de access)", async () => {
    const challenge = await tokens.signMfaChallengeToken(
      { id_usuario: "u-1", email: "u@test.co", roles: ["ACUDIENTE"] },
      "cid-1",
    );
    await expectCode(
      authenticator.authenticate({ auth: { token: challenge } }),
      "TOKEN_INVALID",
    );
  });

  it("exige MFA a los roles institucionales que lo requieren", async () => {
    await expectCode(
      authenticator.authenticate({
        auth: { token: await access(["COORDINADORA_CONVIVENCIA"], false) },
      }),
      "MFA_REQUIRED",
    );
    const ok = await authenticator.authenticate({
      auth: { token: await access(["COORDINADORA_CONVIVENCIA"], true) },
    });
    expect(ok.kind).toBe("STAFF");
  });

  it("rechaza roles sin acceso al seguimiento en vivo", async () => {
    await expectCode(
      authenticator.authenticate({
        auth: { token: await access(["CONDUCTOR"]) },
      }),
      "ROLE_NOT_ALLOWED",
    );
    await expectCode(
      authenticator.authenticate({
        auth: { token: await access(["ADMINISTRADOR_CARTERA"]) },
      }),
      "ROLE_NOT_ALLOWED",
    );
  });

  it.each([
    [["ACUDIENTE"], "GUARDIAN"],
    [["parent"], "GUARDIAN"],
    [["MONITORA"], "STAFF"],
    [["JEFE_OPERACIONES"], "STAFF"],
    [["ACUDIENTE", "MONITORA"], "STAFF"],
  ])("clasifica %j como %s", async (roles, kind) => {
    const principal = await authenticator.authenticate({
      auth: { token: await access(roles) },
    });
    expect(principal.kind).toBe(kind);
    expect(principal.id_usuario).toBe("u-1");
  });

  it("acepta el token por header Authorization Bearer y prefijo en auth.token, y lee la expiración", async () => {
    const token = await access(["ACUDIENTE"]);
    const viaHeader = await authenticator.authenticate({
      headers: { authorization: `Bearer ${token}` },
    });
    const viaPrefixed = await authenticator.authenticate({
      auth: { token: `Bearer ${token}` },
    });
    expect(viaHeader.kind).toBe("GUARDIAN");
    expect(viaPrefixed.kind).toBe("GUARDIAN");
    // Access Token de 15 min (Issue #3).
    const remaining = viaHeader.expiresAtMs - Date.now();
    expect(remaining).toBeGreaterThan(14 * 60 * 1000);
    expect(remaining).toBeLessThanOrEqual(15 * 60 * 1000);
  });
});
