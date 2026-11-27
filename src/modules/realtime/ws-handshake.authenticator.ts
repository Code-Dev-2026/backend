import { ExecutionContext, Injectable } from "@nestjs/common";
import { userHasAnyRole } from "@common/enums/role.enum";
import { MfaGuard } from "@common/guards/mfa.guard";
import { TokenService } from "../auth/token.service";
import {
  GUARDIAN_STREAMING_ROLES,
  HANDSHAKE_ERROR_CODES,
  STAFF_STREAMING_ROLES,
} from "./domain/realtime.constants";
import { StreamingPrincipal } from "./domain/realtime.types";

export type HandshakeErrorCode =
  (typeof HANDSHAKE_ERROR_CODES)[keyof typeof HANDSHAKE_ERROR_CODES];

export class WsHandshakeError extends Error {
  constructor(
    readonly code: HandshakeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WsHandshakeError";
  }
}

export interface HandshakeCredentials {
  readonly auth?: Record<string, unknown>;
  readonly headers?: Record<string, string | string[] | undefined>;
}

/**
 * Autenticación obligatoria del handshake WebSocket (OWASP ASVS V3.2 — Issue #14).
 *
 * Reutiliza `TokenService.verifyAccessToken` (Issue #3, HS256, `typ=access`) y la
 * regla de `MfaGuard` para los roles con MFA obligatorio. Clasifica al usuario como
 * personal (stream completo) o acudiente (stream filtrado por custodia).
 */
@Injectable()
export class WsHandshakeAuthenticator {
  private readonly mfaRule = new MfaGuard();

  constructor(private readonly tokenService: TokenService) {}

  async authenticate(
    credentials: HandshakeCredentials,
  ): Promise<StreamingPrincipal> {
    const token = extractToken(credentials);
    if (!token) {
      throw new WsHandshakeError(
        HANDSHAKE_ERROR_CODES.TOKEN_REQUIRED,
        "Token de acceso requerido en el handshake.",
      );
    }

    let user;
    try {
      user = await this.tokenService.verifyAccessToken(token);
    } catch {
      throw new WsHandshakeError(
        HANDSHAKE_ERROR_CODES.TOKEN_INVALID,
        "Token inválido o expirado.",
      );
    }

    if (!this.passesMfaRule(user)) {
      throw new WsHandshakeError(
        HANDSHAKE_ERROR_CODES.MFA_REQUIRED,
        "El rol requiere validación de segundo factor (MFA).",
      );
    }

    const kind = userHasAnyRole(user.roles, STAFF_STREAMING_ROLES)
      ? "STAFF"
      : userHasAnyRole(user.roles, GUARDIAN_STREAMING_ROLES)
        ? "GUARDIAN"
        : null;
    if (!kind) {
      throw new WsHandshakeError(
        HANDSHAKE_ERROR_CODES.ROLE_NOT_ALLOWED,
        "El rol no está autorizado para el seguimiento en vivo.",
      );
    }

    return {
      id_usuario: user.id_usuario,
      email: user.email,
      roles: user.roles,
      kind,
      expiresAtMs: readExpirationMs(token),
    };
  }

  private passesMfaRule(user: {
    roles: string[];
    mfa_autenticado?: boolean;
  }): boolean {
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
    try {
      return this.mfaRule.canActivate(context);
    } catch {
      return false;
    }
  }
}

function extractToken(credentials: HandshakeCredentials): string | null {
  const fromAuth = credentials.auth?.token;
  if (typeof fromAuth === "string" && fromAuth.trim()) {
    return stripBearer(fromAuth.trim());
  }
  const header = credentials.headers?.authorization;
  if (typeof header === "string" && header.trim()) {
    const [scheme, value] = header.trim().split(" ");
    return scheme?.toLowerCase() === "bearer" && value ? value : null;
  }
  return null;
}

function stripBearer(value: string): string {
  return value.toLowerCase().startsWith("bearer ")
    ? value.slice(7).trim()
    : value;
}

/** Lee `exp` del token ya verificado por firma (no se confía en él sin verificar antes). */
function readExpirationMs(token: string): number {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    ) as { exp?: unknown };
    return typeof payload.exp === "number"
      ? payload.exp * 1000
      : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
