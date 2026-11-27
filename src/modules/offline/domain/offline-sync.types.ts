/**
 * Tipos de la sincronización offline idempotente (Issue #16 — RF-06, RF-08, RNF-04, RNF-08).
 */

/** Operaciones de campo que la app de la monitora puede diferir sin señal. */
export type OfflineOperationType = "ABORDAJE" | "DESCENSO";

/** Estados de `sync_operation.estado_sync` (CHECK de V007). */
export type SyncOperationState =
  "PENDIENTE" | "PROCESADO" | "CONFLICTO" | "DESCARTADO";

/** Estado reportado al cliente por cada operación del lote. */
export type OfflineOperationOutcome =
  /** Aplicada por primera vez. */
  | "PROCESADO"
  /** El caso de uso la rechazó por regla de negocio (p. ej. sobrecupo, FSM). */
  | "CONFLICTO"
  /** Rechazada antes de aplicarse (desfase temporal o payload inválido). */
  | "DESCARTADO"
  /** Error transitorio del servidor: la app debe reintentarla. */
  | "ERROR_TRANSITORIO";

export interface OfflineOperationInput {
  readonly idempotency_key: string;
  readonly tipo: OfflineOperationType;
  /** Marca de tiempo local del dispositivo en el momento de la captura. */
  readonly fecha_cliente: string;
  readonly datos: Record<string, unknown>;
}

export interface OfflineSyncBatchInput {
  readonly id_dispositivo: string;
  readonly operaciones: readonly OfflineOperationInput[];
}

export interface RegisteredDevice {
  readonly id_dispositivo: string;
  readonly id_usuario: string;
  readonly activo: boolean;
}

export interface ClaimSyncOperationInput {
  readonly id_dispositivo: string;
  readonly idempotency_key: string;
  readonly entidad_afectada: string;
  readonly payload_json: Record<string, unknown>;
  readonly capturada_en_offline: Date;
}

export interface StoredSyncOperation {
  readonly id_sync: string;
  readonly id_dispositivo: string;
  readonly idempotency_key: string;
  readonly entidad_afectada: string;
  readonly estado_sync: SyncOperationState;
  readonly capturada_en_offline: Date;
  readonly procesada_en_servidor: Date;
  readonly resultado_json: Record<string, unknown> | null;
}

export type ClaimSyncOperationResult =
  | { readonly status: "CLAIMED"; readonly operation: StoredSyncOperation }
  | { readonly status: "EXISTING"; readonly operation: StoredSyncOperation };

export interface OfflineOperationReport {
  readonly idempotency_key: string;
  readonly tipo: OfflineOperationType;
  readonly estado: OfflineOperationOutcome;
  /** `true` si la operación ya había sido procesada en una sincronización anterior. */
  readonly duplicado: boolean;
  readonly codigo: string;
  /** Posición (1..n) en que se aplicó dentro del lote ordenado por `fecha_cliente`. */
  readonly orden_aplicacion: number;
  readonly fecha_cliente: string;
  readonly fecha_servidor: string;
  readonly id_sync: string | null;
  readonly resultado: Record<string, unknown> | null;
}

export interface OfflineSyncBatchReport {
  readonly id_dispositivo: string;
  readonly total: number;
  readonly procesadas: number;
  readonly duplicadas: number;
  readonly conflictos: number;
  readonly descartadas: number;
  readonly errores_transitorios: number;
  readonly operaciones: OfflineOperationReport[];
  readonly fecha_servidor: string;
}
