/**
 * Matriz Oficial de Roles del Sistema Camino Seguro
 * Cumple con SRS RF-13 y migración V002 de base de datos.
 */
export enum RoleEnum {
  // Roles de Base de Datos (V002)
  COORDINADORA_CONVIVENCIA = "COORDINADORA_CONVIVENCIA", // Superadministrador institucional (MFA obligatorio)
  RECTORIA = "RECTORIA", // Máxima autoridad académica y convenios
  GERENCIA_TRANSPORTE = "GERENCIA_TRANSPORTE", // Dirección empresa transportadora
  JEFE_OPERACIONES = "JEFE_OPERACIONES", // Despacho logístico y programación
  ADMINISTRADOR_CARTERA = "ADMINISTRADOR_CARTERA", // Cobranza financiera aislada
  MONITORA = "MONITORA", // Supervisión en ruta y escaneo QR
  CONDUCTOR = "CONDUCTOR", // Operador vehicular
  ACUDIENTE = "ACUDIENTE", // Padre o tutor legal

  // Alias normalizados para compatibilidad con RBAC
  SUPER_ADMIN = "super_admin",
  SCHOOL_COORDINATOR = "school_coordinator",
  TRANSPORT_ADMIN = "transport_admin",
  MONITOR = "monitor",
  DRIVER = "driver",
  PARENT = "parent",
}

/**
 * Mapeador bidireccional entre nombres de base de datos y slugs normalizados
 */
export const ROLE_EQUIVALENCES: Record<string, string[]> = {
  [RoleEnum.SUPER_ADMIN]: [
    RoleEnum.COORDINADORA_CONVIVENCIA,
    RoleEnum.SUPER_ADMIN,
  ],
  [RoleEnum.SCHOOL_COORDINATOR]: [
    RoleEnum.COORDINADORA_CONVIVENCIA,
    RoleEnum.RECTORIA,
    RoleEnum.SCHOOL_COORDINATOR,
  ],
  [RoleEnum.TRANSPORT_ADMIN]: [
    RoleEnum.GERENCIA_TRANSPORTE,
    RoleEnum.JEFE_OPERACIONES,
    RoleEnum.TRANSPORT_ADMIN,
  ],
  [RoleEnum.MONITOR]: [RoleEnum.MONITORA, RoleEnum.MONITOR],
  [RoleEnum.DRIVER]: [RoleEnum.CONDUCTOR, RoleEnum.DRIVER],
  [RoleEnum.PARENT]: [RoleEnum.ACUDIENTE, RoleEnum.PARENT],
};
