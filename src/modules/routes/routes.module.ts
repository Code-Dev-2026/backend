import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GEO_PROXIMITY_QUERIES } from "./domain/geo-proximity.port";
import {
  ROUTE_ASSIGNMENT_REPOSITORY,
  ROUTE_DEFINITION_SERVICE,
  ROUTE_REPOSITORY,
  ZONE_REPOSITORY,
} from "./domain/route-definition.port";
import { GeoZonesController } from "./geo-zones.controller";
import { GeoZonesService } from "./geo-zones.service";
import { InMemoryGeoRepository } from "./infrastructure/in-memory-geo.repository";
import { PostgisGeoRepository } from "./infrastructure/postgis-geo.repository";
import { RouteAssignmentService } from "./route-assignment.service";
import { RoutesController } from "./routes.controller";
import { RoutesService } from "./routes.service";

const GEO_REPOSITORY_ADAPTER = Symbol("GEO_REPOSITORY_ADAPTER");

@Module({
  controllers: [RoutesController, GeoZonesController],
  providers: [
    {
      provide: GEO_REPOSITORY_ADAPTER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const usePostgis = config.get<string>("GEO_USE_POSTGIS") === "true";
        if (usePostgis) {
          return PostgisGeoRepository.fromConfig({
            host: config.get<string>("DB_HOST", "localhost"),
            port: config.get<number>("DB_PORT", 5432),
            database: config.get<string>("DB_NAME", "camino_seguro_db"),
            user: config.get<string>("DB_USER", "app_user"),
            password: config.get<string>("DB_PASSWORD", "camino_seguro_pass"),
          });
        }
        return new InMemoryGeoRepository();
      },
    },
    { provide: ROUTE_REPOSITORY, useExisting: GEO_REPOSITORY_ADAPTER },
    { provide: ZONE_REPOSITORY, useExisting: GEO_REPOSITORY_ADAPTER },
    {
      provide: ROUTE_ASSIGNMENT_REPOSITORY,
      useExisting: GEO_REPOSITORY_ADAPTER,
    },
    { provide: GEO_PROXIMITY_QUERIES, useExisting: GEO_REPOSITORY_ADAPTER },
    RoutesService,
    { provide: ROUTE_DEFINITION_SERVICE, useExisting: RoutesService },
    RouteAssignmentService,
    GeoZonesService,
  ],
  exports: [
    RoutesService,
    RouteAssignmentService,
    GeoZonesService,
    ROUTE_DEFINITION_SERVICE,
    GEO_PROXIMITY_QUERIES,
  ],
})
export class RoutesModule {}
