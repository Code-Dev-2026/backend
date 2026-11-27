export const JUDICIAL_BLOCKING_CODE = "ALERTA_JUDICIAL_BLOQUEANTE" as const;
export const JUDICIAL_EMERGENCY_NOTIFICATION_CODE =
  "ALERTA_JUDICIAL_ACTIVADA" as const;

export interface StoredJudicialAlert {
  id_alerta: string;
  id_estudiante: string;
  juzgado_emisor: string;
  radicado_medida: string;
  foto_individuo_cifrada: string;
  individuo_restringido_nombre_cifrado: string;
  individuo_restringido_documento_cifrado: string;
  individuo_blind_index: string;
  documento_restringido_hash: string;
  orden_judicial_resumen_cifrado: string;
  activa: boolean;
  fecha_registro: Date;
  registrado_por_rectoria: string;
  eliminado_soft: boolean;
  eliminado_en: Date | null;
  eliminado_por_coordinacion: string | null;
  autorizado_excepcion_por: string | null;
  hash_integridad_sha256: string;
}

export interface CreateJudicialAlertRecordInput {
  id_estudiante: string;
  juzgado_emisor: string;
  radicado_medida: string;
  foto_individuo_cifrada: string;
  individuo_restringido_nombre_cifrado: string;
  individuo_restringido_documento_cifrado: string;
  individuo_blind_index: string;
  orden_judicial_resumen_cifrado: string;
  registrado_por_rectoria: string;
  hash_integridad_sha256: string;
}

export interface DeactivateJudicialAlertRecordInput {
  id_alerta: string;
  eliminado_por_coordinacion: string | null;
  autorizado_excepcion_por: string | null;
}

export interface ActiveJudicialAlertMatch {
  bloqueada: true;
  id_alerta: string;
  id_estudiante: string;
  radicado_medida: string;
  juzgado_emisor: string;
  documento_restringido_hash: string;
  fecha_registro: Date;
}

export interface JudicialAlertDecryptedView {
  id_alerta: string;
  id_estudiante: string;
  juzgado_emisor: string;
  radicado_medida: string;
  individuo_restringido_nombre: string;
  individuo_restringido_documento_enmascarado: string;
  documento_restringido_hash: string;
  orden_judicial_resumen: string;
  foto_individuo_referencia: string;
  activa: boolean;
  eliminado_soft: boolean;
  fecha_registro: string;
  registrado_por_rectoria: string;
  eliminado_en: string | null;
  eliminado_por_coordinacion: string | null;
  autorizado_excepcion_por: string | null;
  hash_integridad_sha256: string;
}

export interface JudicialAlertVerificationResponse {
  bloqueada: boolean;
  codigo: typeof JUDICIAL_BLOCKING_CODE | "SIN_RESTRICCION_JUDICIAL";
  id_estudiante: string;
  documento_restringido_hash: string;
  id_alerta: string | null;
  radicado_medida: string | null;
  juzgado_emisor: string | null;
  fecha_registro: string | null;
  mensaje: string;
}

export interface RecordJudicialEmergencyIncidentInput {
  id_viaje: string;
  id_estudiante: string;
  id_alerta: string | null;
  documento_restringido_hash: string;
  radicado_medida: string | null;
  juzgado_emisor: string | null;
  latitud: number;
  longitud: number;
  registrado_por_usuario: string | null;
  descripcion?: string | null;
}

export interface RecordJudicialEmergencyIncidentResult {
  id_incidente: string;
  id_notificacion_principal: string | null;
  id_acudientes_notificados: string[];
  notificaciones_creadas: number;
  alerta_policia_infancia_registrada: boolean;
  fecha_hora: Date;
}

export class JudicialAlertNotFoundError extends Error {
  readonly code = "ALERTA_JUDICIAL_NO_ENCONTRADA";

  constructor(public readonly idAlerta: string) {
    super(`La alerta judicial '${idAlerta}' no existe.`);
    this.name = "JudicialAlertNotFoundError";
  }
}

export class DuplicateJudicialAlertRadicadoError extends Error {
  readonly code = "RADICADO_JUDICIAL_DUPLICADO";

  constructor(public readonly radicado: string) {
    super(
      `Ya existe una medida cautelar registrada con el radicado '${radicado}'.`,
    );
    this.name = "DuplicateJudicialAlertRadicadoError";
  }
}

export class InvalidJudicialAlertDocumentError extends Error {
  readonly code = "DOCUMENTO_RESTRINGIDO_INVALIDO";

  constructor(message: string) {
    super(message);
    this.name = "InvalidJudicialAlertDocumentError";
  }
}

export class JudicialAlertAlreadyDeactivatedError extends Error {
  readonly code = "ALERTA_JUDICIAL_YA_INACTIVA";

  constructor(public readonly idAlerta: string) {
    super(`La alerta judicial '${idAlerta}' ya se encuentra desactivada.`);
    this.name = "JudicialAlertAlreadyDeactivatedError";
  }
}

export class JudicialProtectionEngineError extends Error {
  readonly code = "MOTOR_JUDICIAL_NO_DISPONIBLE_BLOQUEO_SEGURO";

  constructor(
    public readonly idEstudiante: string,
    reason?: string,
  ) {
    super(
      `BLOQUEO SEGURO (RNF-01): No fue posible verificar alertas judiciales para el estudiante '${idEstudiante}'. La entrega queda bloqueada preventivamente${reason ? ` (${reason})` : ""}.`,
    );
    this.name = "JudicialProtectionEngineError";
  }
}
