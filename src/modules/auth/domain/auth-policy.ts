import { RoleEnum } from "@common/enums/role.enum";
import { UserRecord } from "./auth.models";

/**
 * Roles con segundo factor obligatorio (directivos y administrativos).
 * Debe mantenerse alineado con el MfaGuard de @common/guards.
 */
export const MFA_MANDATORY_ROLES: readonly string[] = [
  RoleEnum.COORDINADORA_CONVIVENCIA,
  RoleEnum.RECTORIA,
  RoleEnum.SUPER_ADMIN,
  RoleEnum.SCHOOL_COORDINATOR,
];

/** MFA es obligatorio por rol, o cuando el usuario lo tiene habilitado. */
export function requiresMfa(
  user: Pick<UserRecord, "roles" | "mfa_habilitado">,
): boolean {
  return (
    user.mfa_habilitado ||
    user.roles.some((role) => MFA_MANDATORY_ROLES.includes(role))
  );
}
