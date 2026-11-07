export interface StudentBillingStatus {
  id_estudiante: string;
  hasOverdueBalance: boolean;
  canBoardBus: boolean; // Siempre true: RN-05 Inmunidad Operativa del menor frente a mora
}

/**
 * Puerto de Dominio: Segregación Financiera e Inmunidad Operativa (RN-05)
 */
export interface IBillingIsolationPort {
  getStudentOperationalStatus(
    id_estudiante: string,
  ): Promise<StudentBillingStatus>;
}
