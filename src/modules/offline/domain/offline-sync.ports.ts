import { AuthenticatedUser } from "@common/decorators/current-user.decorator";
import {
  ClaimSyncOperationInput,
  ClaimSyncOperationResult,
  OfflineOperationType,
  RegisteredDevice,
  StoredSyncOperation,
  SyncOperationState,
} from "./offline-sync.types";

export const SYNC_OPERATION_REPOSITORY = Symbol("SYNC_OPERATION_REPOSITORY");
export const DEVICE_REGISTRY = Symbol("DEVICE_REGISTRY");
export const OFFLINE_OPERATION_HANDLERS = Symbol("OFFLINE_OPERATION_HANDLERS");
export const OFFLINE_SYNC_CLOCK = Symbol("OFFLINE_SYNC_CLOCK");

export type OfflineSyncClock = () => number;

/** Mitigación de relojes desincronizados: desfase máximo aceptado respecto al servidor. */
export const MAX_CLIENT_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/** Tamaño máximo de un lote de sincronización. */
export const MAX_OPERATIONS_PER_BATCH = 100;

/** Registro de trazabilidad e idempotencia en `sync_operation` (DIP). */
export interface ISyncOperationRepository {
  /**
   * Reserva la operación en estado PENDIENTE. Si ya existe
   * `(id_dispositivo, idempotency_key)`, devuelve la fila existente sin insertar.
   */
  claim(input: ClaimSyncOperationInput): Promise<ClaimSyncOperationResult>;

  /** Registra el resultado final y la `procesada_en_servidor` real. */
  complete(
    idSync: string,
    estado: Exclude<SyncOperationState, "PENDIENTE">,
    resultado: Record<string, unknown>,
  ): Promise<StoredSyncOperation>;
}

/** Dispositivos móviles registrados (`dispositivo`, V002). */
export interface IDeviceRegistry {
  findDevice(idDispositivo: string): Promise<RegisteredDevice | null>;
}

export interface OfflineHandlerContext {
  readonly user: AuthenticatedUser;
  readonly id_dispositivo: string;
  /** Clave idempotente propagada al caso de uso (segunda barrera contra duplicados). */
  readonly idempotency_key: string;
}

export type OfflineHandlerResult =
  | {
      readonly kind: "APPLIED";
      /** `true` si el caso de uso rechazó la operación por regla de negocio. */
      readonly conflicto: boolean;
      readonly codigo: string;
      readonly resultado: Record<string, unknown>;
    }
  | {
      readonly kind: "INVALID";
      readonly errores: string[];
    };

/**
 * Adaptador de una operación offline hacia su caso de uso de dominio (SRP):
 * valida el payload con el DTO HTTP existente y delega la regla de negocio.
 */
export interface IOfflineOperationHandler {
  readonly tipo: OfflineOperationType;
  readonly entidad_afectada: string;
  /** Campos con datos personales que no se guardan en claro en `sync_operation`. */
  readonly camposSensibles: readonly string[];
  execute(
    datos: Record<string, unknown>,
    context: OfflineHandlerContext,
  ): Promise<OfflineHandlerResult>;
}
