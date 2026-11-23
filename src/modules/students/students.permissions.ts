import { ForbiddenException } from "@nestjs/common";
import { AuthenticatedUser } from "@common/decorators/current-user.decorator";
import { RoleEnum, userHasAnyRole } from "@common/enums/role.enum";

/** Roles administrativos autorizados a ver y cargar expedientes (con MFA). */
export const EXPEDIENTE_ROLES: readonly string[] = [
  RoleEnum.ADMIN, // coordinadora de convivencia / superadministración
  RoleEnum.RECTORIA,
];

/**
 * Defensa en profundidad (además de RolesGuard y MfaGuard): ningún dato de
 * un menor se descifra ni se escribe sin rol administrativo y MFA.
 */
export function assertExpedienteAccess(
  actor: AuthenticatedUser | undefined,
): AuthenticatedUser {
  if (!actor || !userHasAnyRole(actor.roles ?? [], EXPEDIENTE_ROLES)) {
    throw new ForbiddenException(
      "Acceso denegado: los expedientes requieren un rol administrativo.",
    );
  }
  if (!actor.mfa_autenticado) {
    throw new ForbiddenException(
      "Acceso denegado: los expedientes requieren verificación de doble factor.",
    );
  }
  return actor;
}
