import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolConfig } from "pg";
import {
  GeoJsonLineString,
  GeoJsonPolygon,
  GeographicCoordinates,
  isValidGeoJsonLineString,
  isValidGeoJsonPolygon,
} from "../../routes/domain/geo.types";
import { POLYLINE_SIMPLIFY_TOLERANCE_DEGREES } from "../domain/geo-monitoring.constants";
import {
  RecordedGeoIncident,
  RecordGeoIncidentInput,
  RouteDistanceMeasurement,
  StopGeofence,
  TripRouteGeometry,
} from "../domain/geo-monitoring.types";
import { IRouteGeometryRepository } from "../domain/route-geometry-repository.port";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TripRouteRow {
  id_viaje: string;
  id_ruta: string;
  codigo: string;
  polilinea: GeoJsonLineString | null;
}

interface StopRow {
  id_parada: string;
  nombre: string;
  geocerca: GeoJsonPolygon | null;
}

interface DistanceRow {
  distancia_metros: string | number;
  dentro_umbral: boolean;
}

interface IncidentRow {
  id_incidente: string;
  fecha_hora: Date;
}

/**
 * Adaptador PostgreSQL 16 + PostGIS 3.4 del motor de desvíos (Issue #13).
 *
 * - `ST_Simplify` reduce la polilínea oficial antes de cachearla en memoria.
 * - `ST_DWithin` + `ST_Distance` sobre `geography` confirman el desvío contra la
 *   polilínea completa (índice GiST `idx_ruta_polilinea`, V004).
 * - Inserta el `incidente` con su coordenada `GEOGRAPHY(Point, 4326)`.
 */
@Injectable()
export class PostgisRouteGeometryRepository
  implements IRouteGeometryRepository, OnModuleDestroy
{
  constructor(
    private readonly pool: Pool,
    private readonly ownsPool = false,
  ) {}

  static fromConfig(config: PoolConfig): PostgisRouteGeometryRepository {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool: PgPool } = require("pg") as typeof import("pg");
    return new PostgisRouteGeometryRepository(new PgPool(config), true);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async loadTripRouteGeometry(
    idViaje: string,
  ): Promise<TripRouteGeometry | null> {
    if (!UUID_PATTERN.test(idViaje)) {
      return null;
    }

    const routeRes = await this.pool.query<TripRouteRow>(
      `SELECT v.id_viaje,
              r.id_ruta,
              r.codigo,
              ST_AsGeoJSON(
                ST_Simplify(r.polilinea_oficial::geometry, $2::double precision, true)
              )::json AS polilinea
         FROM public.viaje v
         JOIN public.ruta r ON r.id_ruta = v.id_ruta
        WHERE v.id_viaje = $1::uuid`,
      [idViaje, POLYLINE_SIMPLIFY_TOLERANCE_DEGREES],
    );
    const row = routeRes.rows[0];
    if (!row) {
      return null;
    }

    const stopsRes = await this.pool.query<StopRow>(
      `SELECT p.id_parada,
              p.nombre,
              ST_AsGeoJSON(p.radio_geocerca::geometry)::json AS geocerca
         FROM public.parada p
        WHERE p.id_ruta = $1::uuid
        ORDER BY p.orden_secuencia`,
      [row.id_ruta],
    );

    const paradas: StopGeofence[] = stopsRes.rows
      .filter((s) => isValidGeoJsonPolygon(s.geocerca))
      .map((s) => ({
        id_parada: s.id_parada,
        nombre: s.nombre,
        geocerca: s.geocerca as GeoJsonPolygon,
      }));

    return {
      id_viaje: row.id_viaje,
      id_ruta: row.id_ruta,
      codigo_ruta: row.codigo,
      polilinea_simplificada: isValidGeoJsonLineString(row.polilinea)
        ? row.polilinea.coordinates
        : [],
      paradas,
    };
  }

  async measureDistanceToRoute(
    idRuta: string,
    punto: GeographicCoordinates,
    umbralMetros: number,
  ): Promise<RouteDistanceMeasurement | null> {
    if (!UUID_PATTERN.test(idRuta)) {
      return null;
    }

    const res = await this.pool.query<DistanceRow>(
      `SELECT ST_Distance(r.polilinea_oficial, p.punto) AS distancia_metros,
              ST_DWithin(r.polilinea_oficial, p.punto, $4::double precision) AS dentro_umbral
         FROM public.ruta r
        CROSS JOIN (
              SELECT ST_SetSRID(
                       ST_MakePoint($3::double precision, $2::double precision),
                       4326
                     )::geography AS punto
             ) p
        WHERE r.id_ruta = $1::uuid`,
      [idRuta, punto.latitud, punto.longitud, umbralMetros],
    );
    const row = res.rows[0];
    if (!row) {
      return null;
    }
    return {
      distancia_metros: Number(row.distancia_metros),
      dentro_umbral: row.dentro_umbral,
    };
  }

  async recordIncident(
    input: RecordGeoIncidentInput,
  ): Promise<RecordedGeoIncident> {
    const res = await this.pool.query<IncidentRow>(
      `INSERT INTO public.incidente (
         id_viaje, tipo_incidente, severidad, descripcion, coordenada
       )
       VALUES (
         $1::uuid, $2, $3, $4,
         ST_SetSRID(ST_MakePoint($6::double precision, $5::double precision), 4326)::geography
       )
       RETURNING id_incidente, fecha_hora`,
      [
        input.id_viaje,
        input.tipo_incidente,
        input.severidad,
        input.descripcion,
        input.coordenadas.latitud,
        input.coordenadas.longitud,
      ],
    );
    return {
      id_incidente: res.rows[0].id_incidente,
      fecha_hora: res.rows[0].fecha_hora,
    };
  }
}
