import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AttendanceModule } from "../attendance/attendance.module";
import { AuditModule } from "../audit/audit.module";
import { TelemetryModule } from "../telemetry/telemetry.module";
import { GEO_SECURITY_ALERT_PORT } from "./domain/geo-security-alert.port";
import { ROUTE_GEOMETRY_REPOSITORY } from "./domain/route-geometry-repository.port";
import { TELEMETRY_ANOMALY_RULES } from "./domain/telemetry-anomaly-rule.interface";
import {
  GEO_MONITORING_CLOCK,
  GeoDeviationAnalyzer,
} from "./geo-deviation-analyzer.service";
import { GeoSecurityIncidentReporter } from "./geo-security-incident-reporter.service";
import { CoordinationGeoAlertAdapter } from "./infrastructure/coordination-geo-alert.adapter";
import { InMemoryRouteGeometryRepository } from "./infrastructure/in-memory-route-geometry.repository";
import { PostgisRouteGeometryRepository } from "./infrastructure/postgis-route-geometry.repository";
import { ProlongedStopDetector } from "./rules/prolonged-stop.detector";
import { RouteDeviationDetector } from "./rules/route-deviation.detector";

/**
 * Motor de detección de desvíos de ruta (> 300 m) y paradas prolongadas en streaming (Issue #13).
 * Consume `telemetry.gps.recorded` (Issue #12) y la geometría de rutas/paradas (Issue #6).
 */
@Module({
  imports: [TelemetryModule, AttendanceModule, AuditModule],
  providers: [
    {
      provide: GEO_MONITORING_CLOCK,
      useValue: () => Date.now(),
    },
    {
      provide: ROUTE_GEOMETRY_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        if (config.get<string>("GEO_USE_POSTGIS") === "true") {
          return PostgisRouteGeometryRepository.fromConfig({
            host: config.get<string>("DB_HOST", "localhost"),
            port: config.get<number>("DB_PORT", 5432),
            database: config.get<string>("DB_NAME", "camino_seguro_db"),
            user: config.get<string>("DB_USER", "app_user"),
            password: config.get<string>("DB_PASSWORD"),
          });
        }
        return new InMemoryRouteGeometryRepository();
      },
    },
    RouteDeviationDetector,
    ProlongedStopDetector,
    {
      provide: TELEMETRY_ANOMALY_RULES,
      inject: [RouteDeviationDetector, ProlongedStopDetector],
      useFactory: (
        deviation: RouteDeviationDetector,
        prolongedStop: ProlongedStopDetector,
      ) => [deviation, prolongedStop],
    },
    CoordinationGeoAlertAdapter,
    {
      provide: GEO_SECURITY_ALERT_PORT,
      useExisting: CoordinationGeoAlertAdapter,
    },
    GeoSecurityIncidentReporter,
    GeoDeviationAnalyzer,
  ],
  exports: [GeoDeviationAnalyzer, TELEMETRY_ANOMALY_RULES],
})
export class GeoMonitoringModule {}
