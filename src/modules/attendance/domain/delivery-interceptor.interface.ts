import { Inject, Injectable, Optional } from "@nestjs/common";
import { JudicialProtectionEngineError } from "../../custody/judicial-alerts/domain/judicial-alert.types";
import { AttendanceCoordinates } from "./attendance.types";
import {
  AuthorizationExpiredError,
  AuthorizedAdultsLimitExceededError,
  IncompatibleTripDirectionError,
  JudicialAlertBlockedError,
  ReceptorInactiveOrRevokedError,
  ReceptorType,
  ReceptorUnauthorizedError,
  StudentNotFoundError,
} from "./disembark.types";

export const DELIVERY_INTERCEPTORS = Symbol("DELIVERY_INTERCEPTORS");

export interface DeliveryInterceptorContext {
  id_viaje: string;
  id_ruta: string;
  id_estudiante: string;
  tipo_receptor: ReceptorType;
  documento_receptor?: string | null;
  documento_blind_index?: string | null;
  id_receptor?: string | null;
  tipo_recorrido: "MANANA" | "TARDE";
  coordenadas_gps: AttendanceCoordinates;
  registrado_por_usuario: string | null;
  now?: Date;
}

/**
 * Contrato OCP (Open/Closed Principle) de la cadena de responsabilidad de validación
 * cautelar previa a la entrega de menores (Issue #10).
 *
 * Permite incorporar nuevas reglas cautelares o validadores preventivos sin modificar
 * el núcleo de desembarque (`DisembarkUseCase`).
 */
export interface DeliveryInterceptor {
  readonly name: string;
  readonly priority: number;
  intercept(context: DeliveryInterceptorContext): Promise<void>;
}

/**
 * Orquestador OCP y fail-safe de la cadena de `DeliveryInterceptor`.
 *
 * - Ejecuta los interceptores ordenados por `priority` ascendente (menor = mayor prioridad).
 * - Ante cualquier error técnico inesperado en un interceptor, falla de forma segura
 *   lanzando `JudicialProtectionEngineError` (jamás permite la entrega).
 */
@Injectable()
export class DeliveryInterceptorChain {
  private readonly interceptors: DeliveryInterceptor[];

  constructor(
    @Optional()
    @Inject(DELIVERY_INTERCEPTORS)
    interceptors?: DeliveryInterceptor[],
  ) {
    this.interceptors = [...(interceptors ?? [])].sort(
      (a, b) => a.priority - b.priority,
    );
  }

  registerInterceptor(interceptor: DeliveryInterceptor): void {
    this.interceptors.push(interceptor);
    this.interceptors.sort((a, b) => a.priority - b.priority);
  }

  listInterceptors(): readonly DeliveryInterceptor[] {
    return [...this.interceptors];
  }

  async execute(context: DeliveryInterceptorContext): Promise<void> {
    for (const interceptor of this.interceptors) {
      try {
        await interceptor.intercept(context);
      } catch (error) {
        if (this.isExpectedDomainDenial(error)) {
          throw error;
        }
        throw new JudicialProtectionEngineError(
          context.id_estudiante,
          `fallo en interceptor '${interceptor.name}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private isExpectedDomainDenial(error: unknown): boolean {
    return (
      error instanceof JudicialAlertBlockedError ||
      error instanceof JudicialProtectionEngineError ||
      error instanceof ReceptorUnauthorizedError ||
      error instanceof AuthorizationExpiredError ||
      error instanceof ReceptorInactiveOrRevokedError ||
      error instanceof AuthorizedAdultsLimitExceededError ||
      error instanceof IncompatibleTripDirectionError ||
      error instanceof StudentNotFoundError
    );
  }
}
