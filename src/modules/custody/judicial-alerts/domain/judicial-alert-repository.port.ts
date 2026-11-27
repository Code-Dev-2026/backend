import {
  ActiveJudicialAlertMatch,
  CreateJudicialAlertRecordInput,
  DeactivateJudicialAlertRecordInput,
  RecordJudicialEmergencyIncidentInput,
  RecordJudicialEmergencyIncidentResult,
  StoredJudicialAlert,
} from "./judicial-alert.types";

export const JUDICIAL_ALERT_REPOSITORY = Symbol("JUDICIAL_ALERT_REPOSITORY");

/**
 * Puerto hexagonal de persistencia segura para `alerta_judicial` (Issue #10: RF-02, RF-09, RNF-01).
 */
export interface IJudicialAlertRepository {
  create(input: CreateJudicialAlertRecordInput): Promise<StoredJudicialAlert>;

  findById(idAlerta: string): Promise<StoredJudicialAlert | null>;

  listByStudent(
    idEstudiante: string,
    includeInactive?: boolean,
  ): Promise<StoredJudicialAlert[]>;

  findActiveMatchByBlindIndex(
    idEstudiante: string,
    documentoRestringidoHash: string,
  ): Promise<ActiveJudicialAlertMatch | null>;

  deactivateSoft(
    input: DeactivateJudicialAlertRecordInput,
  ): Promise<StoredJudicialAlert>;

  /**
   * Persiste atómicamente en BD (cuando aplica) el incidente `ALERTA_JUDICIAL_DETECTADA`
   * y las notificaciones `ALERTA_JUDICIAL_ACTIVADA` en `notificacion` excluyendo al individuo restringido.
   */
  recordJudicialBlockIncidentAndNotifications?(
    input: RecordJudicialEmergencyIncidentInput,
  ): Promise<RecordJudicialEmergencyIncidentResult>;
}
