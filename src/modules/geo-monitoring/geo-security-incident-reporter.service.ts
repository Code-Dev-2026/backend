import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { IEventDispatcherPort } from "@common/ports/event-dispatcher.port";
import { AuditService } from "../audit/audit.service";
import { TELEMETRY_EVENT_DISPATCHER } from "../telemetry/domain/telemetry-ingest.port";
import {
  COORDINATION_ROUTE_SECURITY_ALERT_EVENT,
  GEO_SECURITY_INCIDENT_EVENT,
} from "./domain/geo-monitoring.constants";
import {
  AnomalyDetection,
  GpsSample,
  RouteSecurityAlertPayload,
  TripRouteGeometry,
} from "./domain/geo-monitoring.types";
import {
  GEO_SECURITY_ALERT_PORT,
  IGeoSecurityAlertPort,
} from "./domain/geo-security-alert.port";
import {
  IRouteGeometryRepository,
  ROUTE_GEOMETRY_REPOSITORY,
} from "./domain/route-geometry-repository.port";

export interface GeoIncidentReportOutcome {
  readonly id_incidente: string;
  readonly tipo_incidente: AnomalyDetection["tipo_incidente"];
  readonly alerta_coordinacion_emitida: boolean;
}

/**
 * Servicio SRP de emisión inmediata de incidentes de seguridad geoespacial (Issue #13).
 *
 * Orden: (1) persiste el `incidente` CRITICO, (2) lo encadena en la bitácora forense
 * SHA-256 (ASVS V1.14), (3) emite la alerta crítica a la sala de Coordinación y
 * (4) publica el evento de dominio `geo.security.incident`. Un fallo en (2)–(4) no
 * revierte el incidente ya registrado.
 */
@Injectable()
export class GeoSecurityIncidentReporter {
  private readonly logger = new Logger(GeoSecurityIncidentReporter.name);

  constructor(
    @Inject(ROUTE_GEOMETRY_REPOSITORY)
    private readonly repository: IRouteGeometryRepository,
    @Optional()
    @Inject(GEO_SECURITY_ALERT_PORT)
    private readonly alertPort?: IGeoSecurityAlertPort,
    @Optional()
    private readonly auditService?: AuditService,
    @Optional()
    @Inject(TELEMETRY_EVENT_DISPATCHER)
    private readonly eventDispatcher?: IEventDispatcherPort,
  ) {}

  async report(
    detection: AnomalyDetection,
    sample: GpsSample,
    route: TripRouteGeometry,
  ): Promise<GeoIncidentReportOutcome> {
    const recorded = await this.repository.recordIncident({
      id_viaje: sample.id_viaje,
      tipo_incidente: detection.tipo_incidente,
      severidad: detection.severidad,
      descripcion: detection.descripcion,
      coordenadas: detection.coordenadas,
    });

    if (this.auditService) {
      try {
        await this.auditService.logCriticalEvent({
          tipo_evento: detection.tipo_incidente,
          id_viaje: sample.id_viaje,
          payload: {
            id_incidente: recorded.id_incidente,
            id_ruta: route.id_ruta,
            codigo_ruta: route.codigo_ruta,
            id_vehiculo: sample.id_vehiculo,
            placa: sample.placa,
            id_gps: sample.id_gps,
            coordenadas: detection.coordenadas,
            metricas: detection.metricas,
            severidad: detection.severidad,
          },
        });
      } catch (err: unknown) {
        this.logger.error(
          `Fallo al auditar incidente ${recorded.id_incidente}: ${errorMessage(err)}`,
        );
      }
    }

    const payload: RouteSecurityAlertPayload = {
      evento: COORDINATION_ROUTE_SECURITY_ALERT_EVENT,
      tipo_incidente: detection.tipo_incidente,
      severidad: detection.severidad,
      id_incidente: recorded.id_incidente,
      id_viaje: sample.id_viaje,
      id_ruta: route.id_ruta,
      codigo_ruta: route.codigo_ruta,
      id_vehiculo: sample.id_vehiculo,
      placa: sample.placa,
      id_gps: sample.id_gps,
      coordenadas: detection.coordenadas,
      metricas: detection.metricas,
      mensaje: `ALERTA CRÍTICA ${detection.tipo_incidente}: ${detection.descripcion}`,
      fecha_hora: recorded.fecha_hora.toISOString(),
    };

    let alertaEmitida = false;
    if (this.alertPort) {
      try {
        alertaEmitida = await this.alertPort.emitRouteSecurityAlert(payload);
      } catch (err: unknown) {
        this.logger.error(
          `Fallo al emitir alerta a Coordinación (incidente ${recorded.id_incidente}): ${errorMessage(err)}`,
        );
      }
    }

    if (this.eventDispatcher) {
      try {
        await this.eventDispatcher.publish(
          GEO_SECURITY_INCIDENT_EVENT,
          payload,
        );
      } catch (err: unknown) {
        this.logger.error(
          `Fallo al publicar ${GEO_SECURITY_INCIDENT_EVENT}: ${errorMessage(err)}`,
        );
      }
    }

    this.logger.warn(
      `[RF-15 ${detection.tipo_incidente}] Viaje=${sample.id_viaje} Ruta=${route.codigo_ruta} Incidente=${recorded.id_incidente} AlertaCoordinacion=${alertaEmitida}`,
    );

    return {
      id_incidente: recorded.id_incidente,
      tipo_incidente: detection.tipo_incidente,
      alerta_coordinacion_emitida: alertaEmitida,
    };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
