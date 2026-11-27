import { Injectable } from "@nestjs/common";
import { AttendanceService } from "../../attendance/attendance.service";
import { DisembarkUseCase } from "../../attendance/disembark.use-case";
import { RegisterBoardingDto } from "../../attendance/dto/register-boarding.dto";
import { RegisterDisembarkDto } from "../../attendance/dto/register-disembark.dto";
import {
  IOfflineOperationHandler,
  OfflineHandlerContext,
  OfflineHandlerResult,
} from "../domain/offline-sync.ports";
import { validateWithDto } from "./validate-dto";

/** Abordaje QR diferido → `AttendanceService.registerBoarding` (Issue #8). */
@Injectable()
export class BoardingOfflineHandler implements IOfflineOperationHandler {
  readonly tipo = "ABORDAJE" as const;
  readonly entidad_afectada = "registro_de_asistencia";
  readonly camposSensibles = ["qr_token"] as const;

  constructor(private readonly attendance: AttendanceService) {}

  async execute(
    datos: Record<string, unknown>,
    context: OfflineHandlerContext,
  ): Promise<OfflineHandlerResult> {
    const { value: dto, errores } = await validateWithDto(
      RegisterBoardingDto,
      datos,
    );
    if (errores.length > 0) {
      return { kind: "INVALID", errores };
    }

    const response = await this.attendance.registerBoarding({
      id_viaje: dto.id_viaje,
      qr_token: dto.qr_token,
      coordenadas_gps: dto.coordenadas_gps,
      id_parada: dto.id_parada,
      metodo_validacion: dto.metodo_validacion,
      sincronizado_offline: true,
      idempotency_key: context.idempotency_key,
      registrado_por_usuario: context.user.id_usuario,
    });
    // DENEGADO_SOBRECUPO / ABORDAJE_PREVIO_EXISTE llegan como respuesta no fatal (aprobado=false).
    return {
      kind: "APPLIED",
      conflicto: !response.aprobado,
      codigo: response.codigo,
      resultado: response as unknown as Record<string, unknown>,
    };
  }
}

/** Descenso / entrega diferida → `DisembarkUseCase.executeDisembark` (Issue #9). */
@Injectable()
export class DisembarkOfflineHandler implements IOfflineOperationHandler {
  readonly tipo = "DESCENSO" as const;
  readonly entidad_afectada = "entrega";
  readonly camposSensibles = [
    "documento_receptor",
    "foto_evidencia_url",
  ] as const;

  constructor(private readonly disembark: DisembarkUseCase) {}

  async execute(
    datos: Record<string, unknown>,
    context: OfflineHandlerContext,
  ): Promise<OfflineHandlerResult> {
    const { value: dto, errores } = await validateWithDto(
      RegisterDisembarkDto,
      datos,
    );
    if (errores.length > 0) {
      return { kind: "INVALID", errores };
    }

    const response = await this.disembark.executeDisembark({
      id_viaje: dto.id_viaje,
      id_estudiante: dto.id_estudiante,
      resultado_entrega: dto.resultado_entrega,
      tipo_receptor: dto.tipo_receptor ?? null,
      documento_receptor: dto.documento_receptor ?? null,
      documento_blind_index: dto.documento_blind_index ?? null,
      id_receptor: dto.id_receptor ?? null,
      metodo_validacion: dto.metodo_validacion,
      coordenadas_gps: dto.coordenadas_gps,
      foto_evidencia_url: dto.foto_evidencia_url ?? null,
      observaciones_fallido: dto.observaciones_fallido ?? null,
      sincronizado_offline: true,
      idempotency_key: context.idempotency_key,
      registrado_por_usuario: context.user.id_usuario,
    });
    // DESEMBARQUE_FALLIDO_RETORNO (aprobado=false) es un protocolo aplicado, no un conflicto:
    // los rechazos del descenso llegan como excepciones HTTP 4xx.
    return {
      kind: "APPLIED",
      conflicto: false,
      codigo: response.codigo,
      resultado: response as unknown as Record<string, unknown>,
    };
  }
}
