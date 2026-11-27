import { FsmCustodyState } from "../../custody/domain/custody.types";
import {
  AttendanceCoordinates,
  BoardingValidationMethod,
} from "./attendance.types";

/**
 * Tipos oficiales de receptor acreditado para desembarque seguro (Issue #9: RF-09, RN-04).
 */
export enum ReceptorType {
  ACUDIENTE = "ACUDIENTE",
  ADULTO_AUTORIZADO = "ADULTO_AUTORIZADO",
  SEDE_EDUCATIVA = "SEDE_EDUCATIVA",
}

export type StoredEntregaReceptorType =
  | ReceptorType
  | "AUTORIZADO"
  | "RETORNO_SEDE_ESCOLAR";

export enum DisembarkOutcomeType {
  ENTREGADO_EXITOSO = "ENTREGADO_EXITOSO",
  DESEMBARQUE_FALLIDO_RETORNO = "DESEMBARQUE_FALLIDO_RETORNO",
}

export enum DisembarkResultCode {
  DESCENSO_EXITOSO = "DESCENSO_EXITOSO",
  DESEMBARQUE_FALLIDO_RETORNO = "DESEMBARQUE_FALLIDO_RETORNO",
  CUSTODIA_SEDE_FINALIZADA = "CUSTODIA_SEDE_FINALIZADA",
}

export const MAX_ACTIVE_AUTHORIZED_ADULTS = 3;

export interface StudentGuardianLink {
  id_acudiente: string;
  id_estudiante: string;
  nombres: string;
  apellidos: string;
  documento_blind_index: string;
  parentesco: string;
  es_tutor_principal: boolean;
  orden_notificacion: number;
}

export interface StudentAuthorizedAdultLink {
  id_autorizado: string;
  id_estudiante: string;
  nombres: string;
  apellidos: string;
  documento_blind_index: string;
  parentesco: string;
  prioridad_retiro: number;
  adulto_activo: boolean;
  autorizacion_activa: boolean;
  autorizado_hasta: Date | null;
  expediente_revocado: boolean;
}

export interface ActiveJudicialAlertRecord {
  id_alerta: string;
  id_estudiante: string;
  radicado_medida: string;
  individuo_blind_index: string;
  activa: boolean;
  eliminado_soft: boolean;
}

export interface SchoolCoordinatorRecord {
  id_coordinador: string;
  id_colegio: string;
  nombres: string;
  apellidos: string;
  cargo: string;
}

export interface StudentReceptorDirectory {
  id_estudiante: string;
  id_colegio: string | null;
  activo: boolean;
  acudientes: StudentGuardianLink[];
  autorizados: StudentAuthorizedAdultLink[];
  alertas_judiciales: ActiveJudicialAlertRecord[];
}

export interface ValidatedReceptorResult {
  autorizado: true;
  tipo_receptor: ReceptorType;
  id_acudiente: string | null;
  id_autorizado: string | null;
  documento_blind_index: string | null;
  nombre_receptor: string;
  parentesco: string | null;
  autorizados_activos_estudiante: number;
}

export interface ValidatedCoordinatorResult {
  id_coordinador: string;
  id_colegio: string;
  nombre_completo: string;
  cargo: string;
}

export interface AtomicDisembarkCommand {
  id_viaje: string;
  id_estudiante: string;
  resultado_entrega: DisembarkOutcomeType;
  tipo_receptor: ReceptorType | null;
  receptor_documento_blind_index: string | null;
  id_receptor: string | null;
  metodo_validacion: BoardingValidationMethod;
  coordenadas: AttendanceCoordinates;
  registrado_por_usuario: string | null;
  foto_evidencia_url: string | null;
  observaciones_fallido: string | null;
  idempotency_key: string | null;
  sincronizado_offline: boolean;
}

export interface AtomicDisembarkRecord {
  aprobado: boolean;
  codigo:
    | DisembarkResultCode.DESCENSO_EXITOSO
    | DisembarkResultCode.DESEMBARQUE_FALLIDO_RETORNO;
  mensaje: string;
  id_viaje: string;
  id_ruta: string;
  id_estudiante: string;
  id_entrega: string;
  id_asistencia: string | null;
  id_incidente: string | null;
  tipo_receptor: StoredEntregaReceptorType;
  id_acudiente_receptor: string | null;
  id_autorizado_receptor: string | null;
  estado_entrega: DisembarkOutcomeType;
  estado_custodia: FsmCustodyState;
  metodo_validacion: BoardingValidationMethod;
  total_a_bordo: number;
  capacidad_nominal: number;
  id_acudientes_notificados: string[];
  id_notificacion_principal: string | null;
  duplicado_por_idempotencia: boolean;
  fecha_hora: Date;
}

export interface DisembarkResponse {
  aprobado: boolean;
  codigo:
    | DisembarkResultCode.DESCENSO_EXITOSO
    | DisembarkResultCode.DESEMBARQUE_FALLIDO_RETORNO;
  mensaje: string;
  id_viaje: string;
  id_ruta: string;
  id_estudiante: string;
  id_entrega: string;
  id_asistencia: string | null;
  id_incidente: string | null;
  tipo_receptor: StoredEntregaReceptorType;
  id_acudiente_receptor: string | null;
  id_autorizado_receptor: string | null;
  estado_entrega: DisembarkOutcomeType;
  estado_custodia: FsmCustodyState;
  metodo_validacion: BoardingValidationMethod;
  total_a_bordo: number;
  capacidad_nominal: number;
  cupos_disponibles: number;
  duplicado_por_idempotencia: boolean;
  evento_realtime_emitido: string | null;
  alerta_coordinacion_emitida: boolean;
  notificaciones_acudientes_encoladas: number;
  id_notificacion_principal: string | null;
  latencia_ms: number;
  fecha_hora: string;
}

export interface FinalizeSchoolCustodyCommand {
  id_viaje: string;
  id_estudiante: string;
  recibido_por_coordinador: string;
  coordenadas: AttendanceCoordinates;
  registrado_por_usuario: string | null;
  observaciones: string | null;
  idempotency_key: string | null;
}

export interface FinalizeSchoolCustodyRecord {
  finalizado: boolean;
  codigo: DisembarkResultCode.CUSTODIA_SEDE_FINALIZADA;
  mensaje: string;
  id_viaje: string;
  id_ruta: string;
  id_estudiante: string;
  id_entrega: string;
  id_acta: string;
  id_asistencia: string;
  recibido_por_coordinador: string;
  firma_digital_hash: string;
  estado_custodia: FsmCustodyState;
  total_a_bordo: number;
  capacidad_nominal: number;
  id_acudientes_notificados: string[];
  id_notificacion_principal: string | null;
  fecha_recepcion: Date;
}

export interface FinalizeSchoolCustodyResponse {
  finalizado: boolean;
  codigo: DisembarkResultCode.CUSTODIA_SEDE_FINALIZADA;
  mensaje: string;
  id_viaje: string;
  id_ruta: string;
  id_estudiante: string;
  id_entrega: string;
  id_acta: string;
  id_asistencia: string;
  recibido_por_coordinador: string;
  firma_digital_hash: string;
  estado_custodia: FsmCustodyState;
  total_a_bordo: number;
  capacidad_nominal: number;
  cupos_disponibles: number;
  evento_realtime_emitido: string | null;
  notificaciones_acudientes_encoladas: number;
  id_notificacion_principal: string | null;
  latencia_ms: number;
  fecha_recepcion: string;
}

export interface DeliveryRecord {
  id_entrega: string;
  id_viaje: string;
  id_estudiante: string;
  intento_secuencia: number;
  tipo_receptor: StoredEntregaReceptorType;
  id_acudiente: string | null;
  id_autorizado: string | null;
  estado_entrega: DisembarkOutcomeType;
  foto_evidencia_url: string | null;
  coordenadas: AttendanceCoordinates;
  observaciones_fallido: string | null;
  idempotency_key: string | null;
  fecha_hora: Date;
}

export interface CustodyActaRecord {
  id_acta: string;
  id_entrega: string;
  id_estudiante: string;
  recibido_por_coordinador: string;
  fecha_recepcion: Date;
  firma_digital_hash: string;
  observaciones: string | null;
}

export interface StudentDisembarkedEventPayload {
  evento: "student:disembarked";
  id_viaje: string;
  id_ruta: string;
  id_estudiante: string;
  id_entrega: string;
  id_asistencia: string;
  tipo_receptor: StoredEntregaReceptorType;
  estado_custodia: FsmCustodyState;
  total_a_bordo: number;
  capacidad_nominal: number;
  registrado_por_usuario: string | null;
  coordenadas: AttendanceCoordinates;
  fecha_hora: string;
}

export interface FailedDeliveryAlertEventPayload {
  evento: "coordination:failed_delivery_alert";
  codigo: DisembarkResultCode.DESEMBARQUE_FALLIDO_RETORNO;
  severidad: "CRITICO";
  id_incidente: string;
  id_entrega: string;
  id_viaje: string;
  id_ruta: string;
  id_estudiante: string;
  estado_custodia: FsmCustodyState;
  total_a_bordo: number;
  capacidad_nominal: number;
  observaciones: string;
  registrado_por_usuario: string | null;
  coordenadas: AttendanceCoordinates;
  fecha_hora: string;
}

export interface UnauthorizedReceptorAlertEventPayload {
  evento: "coordination:unauthorized_receptor_alert";
  codigo: string;
  severidad: "CRITICO" | "ADVERTENCIA";
  id_incidente: string;
  id_viaje: string;
  id_estudiante: string;
  tipo_receptor_intentado: string;
  mensaje: string;
  registrado_por_usuario: string | null;
  coordenadas: AttendanceCoordinates;
  fecha_hora: string;
}

export interface JudicialAlertEventPayload {
  evento: "coordination:judicial_alert";
  codigo: "ALERTA_JUDICIAL_BLOQUEANTE";
  tipo_notificacion: "ALERTA_JUDICIAL_ACTIVADA";
  severidad: "CRITICO";
  id_alerta: string | null;
  id_incidente: string;
  id_viaje: string;
  id_ruta: string | null;
  id_estudiante: string;
  radicado_medida: string | null;
  juzgado_emisor: string | null;
  menor_permanece_a_bordo: true;
  notificaciones_sms_emergencia: number;
  alerta_policia_infancia_enviada: boolean;
  registrado_por_usuario: string | null;
  coordenadas: AttendanceCoordinates;
  mensaje: string;
  fecha_hora: string;
}

export interface SchoolCustodyFinalizedEventPayload {
  evento: "custody:school_return_completed";
  id_viaje: string;
  id_ruta: string;
  id_estudiante: string;
  id_entrega: string;
  id_acta: string;
  recibido_por_coordinador: string;
  firma_digital_hash: string;
  estado_custodia: FsmCustodyState;
  total_a_bordo: number;
  capacidad_nominal: number;
  fecha_recepcion: string;
}

// ============================================================================
// ERRORES DE DOMINIO FAIL-SAFE (Issue #9 / OWASP ASVS V4.1)
// ============================================================================

export class StudentNotFoundError extends Error {
  readonly code = "ESTUDIANTE_NO_ENCONTRADO";

  constructor(public readonly idEstudiante: string) {
    super(`El estudiante '${idEstudiante}' no existe o se encuentra inactivo.`);
    this.name = "StudentNotFoundError";
  }
}

export class StudentNotOnBoardError extends Error {
  readonly code = "ESTUDIANTE_NO_A_BORDO";

  constructor(
    public readonly idEstudiante: string,
    public readonly idViaje: string,
    public readonly currentState: string,
  ) {
    super(
      `El estudiante '${idEstudiante}' no se encuentra A_BORDO_VEHICULO en el viaje '${idViaje}' (estado actual: '${currentState}').`,
    );
    this.name = "StudentNotOnBoardError";
  }
}

export class StudentNotInSchoolReturnError extends Error {
  readonly code = "ESTUDIANTE_NO_EN_RETORNO_SEDE";

  constructor(
    public readonly idEstudiante: string,
    public readonly idViaje: string,
    public readonly currentState: string,
  ) {
    super(
      `El estudiante '${idEstudiante}' debe encontrarse en estado RETORNO_SEDE_POR_FALLA_ENTREGA para cerrar custodia en sede (actual: '${currentState}').`,
    );
    this.name = "StudentNotInSchoolReturnError";
  }
}

export class IncompatibleTripDirectionError extends Error {
  readonly code = "RECORRIDO_INCOMPATIBLE_DESCENSO";

  constructor(message: string) {
    super(message);
    this.name = "IncompatibleTripDirectionError";
  }
}

export interface JudicialAlertBlockDetails {
  idAlerta?: string | null;
  idIncidente?: string | null;
  juzgadoEmisor?: string | null;
  smsEmergenciaDespachados?: number;
  alertaPoliciaEnviada?: boolean;
  alreadyLogged?: boolean;
}

export class JudicialAlertBlockedError extends Error {
  readonly code = "ALERTA_JUDICIAL_BLOQUEANTE";
  readonly idAlerta: string | null;
  readonly idIncidente: string | null;
  readonly juzgadoEmisor: string | null;
  readonly smsEmergenciaDespachados: number;
  readonly alertaPoliciaEnviada: boolean;
  readonly alreadyLogged: boolean;

  constructor(
    public readonly idEstudiante: string,
    public readonly radicado?: string,
    details?: JudicialAlertBlockDetails,
  ) {
    super(
      `ALERTA_JUDICIAL_BLOQUEANTE: Prohibida la entrega del menor '${idEstudiante}' a esta persona bajo medida cautelar judicial${radicado ? ` (radicado ${radicado})` : ""}. El menor permanece a bordo bajo custodia.`,
    );
    this.name = "JudicialAlertBlockedError";
    this.idAlerta = details?.idAlerta ?? null;
    this.idIncidente = details?.idIncidente ?? null;
    this.juzgadoEmisor = details?.juzgadoEmisor ?? null;
    this.smsEmergenciaDespachados = details?.smsEmergenciaDespachados ?? 0;
    this.alertaPoliciaEnviada = details?.alertaPoliciaEnviada ?? false;
    this.alreadyLogged = details?.alreadyLogged ?? false;
  }
}

export class ReceptorUnauthorizedError extends Error {
  readonly code = "RECEPTOR_NO_AUTORIZADO";

  constructor(
    public readonly idEstudiante: string,
    message?: string,
  ) {
    super(
      message ??
        `Receptor no autorizado: la persona no está acreditada para retirar al estudiante '${idEstudiante}'.`,
    );
    this.name = "ReceptorUnauthorizedError";
  }
}

export class AuthorizationExpiredError extends Error {
  readonly code = "AUTORIZACION_VENCIDA";

  constructor(
    public readonly idEstudiante: string,
    public readonly expiredAt: Date,
  ) {
    super(
      `Autorización vencida: el permiso de retiro para el estudiante '${idEstudiante}' expiró el ${expiredAt.toISOString()}.`,
    );
    this.name = "AuthorizationExpiredError";
  }
}

export class ReceptorInactiveOrRevokedError extends Error {
  readonly code = "RECEPTOR_INACTIVO_O_REVOCADO";

  constructor(public readonly idEstudiante: string) {
    super(
      `Receptor inactivo o revocado: la autorización para retirar al estudiante '${idEstudiante}' no se encuentra vigente.`,
    );
    this.name = "ReceptorInactiveOrRevokedError";
  }
}

export class AuthorizedAdultsLimitExceededError extends Error {
  readonly code = "LIMITE_AUTORIZADOS_EXCEDIDO";

  constructor(
    public readonly idEstudiante: string,
    public readonly activeCount: number,
  ) {
    super(
      `Violación RN-04: el estudiante '${idEstudiante}' registra ${activeCount} adultos autorizados activos (máximo permitido: ${MAX_ACTIVE_AUTHORIZED_ADULTS}). Entrega bloqueada de forma segura hasta revisión de Coordinación.`,
    );
    this.name = "AuthorizedAdultsLimitExceededError";
  }
}

export class CoordinatorUnauthorizedError extends Error {
  readonly code = "COORDINADOR_NO_AUTORIZADO";

  constructor(
    public readonly idCoordinador: string,
    public readonly idEstudiante: string,
  ) {
    super(
      `El coordinador '${idCoordinador}' no está autorizado para recibir formalmente al estudiante '${idEstudiante}' en la sede escolar.`,
    );
    this.name = "CoordinatorUnauthorizedError";
  }
}

export class FailedDeliveryRecordNotFoundError extends Error {
  readonly code = "ENTREGA_FALLIDA_NO_ENCONTRADA";

  constructor(
    public readonly idViaje: string,
    public readonly idEstudiante: string,
  ) {
    super(
      `No existe registro previo de DESEMBARQUE_FALLIDO_RETORNO para el estudiante '${idEstudiante}' en el viaje '${idViaje}'.`,
    );
    this.name = "FailedDeliveryRecordNotFoundError";
  }
}

export class SchoolCustodyAlreadyFinalizedError extends Error {
  readonly code = "ACTA_CUSTODIA_EXISTENTE";

  constructor(public readonly idEntrega: string) {
    super(
      `Ya existe un acta de custodia en sede certificada para la entrega '${idEntrega}'.`,
    );
    this.name = "SchoolCustodyAlreadyFinalizedError";
  }
}

export class DuplicateDisembarkError extends Error {
  readonly code = "DESCENSO_PREVIO_EXISTE";

  constructor(
    public readonly idViaje: string,
    public readonly idEstudiante: string,
  ) {
    super(
      `El estudiante '${idEstudiante}' ya registra descenso previo en el viaje '${idViaje}'.`,
    );
    this.name = "DuplicateDisembarkError";
  }
}
