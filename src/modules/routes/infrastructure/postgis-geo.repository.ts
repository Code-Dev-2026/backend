import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolConfig } from "pg";
import {
  GeoJsonLineString,
  GeoJsonPoint,
  GeoJsonPolygon,
  GeographicCoordinates,
  SAN_BENITO_GEOFENCE_CODE,
} from "../domain/geo.types";
import { IGeoProximityQueries } from "../domain/geo-proximity.port";
import {
  CreateRouteAssignmentInput,
  CreateRouteInput,
  CreateStopInput,
  CreateZoneInput,
  IRouteAssignmentRepository,
  IRouteRepository,
  IZoneRepository,
  ListRoutesFilter,
  UpdateRouteInput,
  UpdateZoneInput,
} from "../domain/route-definition.port";
import {
  AssignmentCycle,
  CompositeStopRouteMismatchError,
  DuplicateActiveAssignmentError,
  DuplicateRouteCodeError,
  DuplicateStopSequenceError,
  DuplicateZoneCodeError,
  ForeignKeyReferenceError,
  GeofenceZoneRecord,
  NearbyStopResult,
  RouteAssignmentRecord,
  RouteRecord,
  RouteShift,
  StopRecord,
  ZoneType,
} from "../domain/route.entity";

interface PgErrorLike {
  code?: string;
  constraint?: string;
}

interface RouteRow {
  id_ruta: string;
  id_colegio: string;
  id_empresa: string;
  codigo: string;
  nombre: string;
  jornada: RouteShift;
  polilinea_oficial: GeoJsonLineString;
  origen_nombre: string;
  destino_nombre: string;
  activa: boolean;
  creado_en: Date;
}

interface StopRow {
  id_parada: string;
  id_ruta: string;
  nombre: string;
  orden_secuencia: number;
  punto_geografico: GeoJsonPoint;
  horario_estimado: string;
  radio_geocerca: GeoJsonPolygon;
  latitud: number;
  longitud: number;
  distancia_metros?: number;
}

interface ZoneRow {
  id_zona: string;
  codigo: string | null;
  id_colegio: string | null;
  nombre: string;
  tipo_zona: ZoneType;
  poligono: GeoJsonPolygon;
  descripcion: string | null;
  activa: boolean;
  creado_en: Date;
}

interface AssignmentRow {
  id_asignacion: string;
  id_estudiante: string;
  id_ruta: string;
  id_parada_subida: string;
  id_parada_bajada: string;
  ciclo_horario: AssignmentCycle;
  activa: boolean;
  fecha_asignacion: Date;
}

/**
 * Adaptador PostgreSQL 16 + PostGIS 3.4 para el módulo geoespacial (Issue #6).
 *
 * Principios clave:
 * - Consultas 100% parametrizadas ($1, $2, ...) sin interpolación SQL.
 * - Uso directo de columnas nativas `geography(..., 4326)` en cláusulas WHERE
 *   (`ST_DWithin`) para garantizar aprovechamiento de índices espaciales GiST (RNF-05).
 * - Delega la integridad referencial compuesta `(id_ruta, id_parada)` a PostgreSQL
 *   y traduce los SQLSTATE 23503 / 23505 a errores de dominio explícitos.
 */
@Injectable()
export class PostgisGeoRepository
  implements
    IRouteRepository,
    IZoneRepository,
    IRouteAssignmentRepository,
    IGeoProximityQueries,
    OnModuleDestroy
{
  private readonly ownsPool: boolean;

  constructor(
    private readonly pool: Pool,
    ownsPool = false,
  ) {
    this.ownsPool = ownsPool;
  }

  static fromConfig(config: PoolConfig): PostgisGeoRepository {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool: PgPool } = require("pg") as typeof import("pg");
    return new PostgisGeoRepository(new PgPool(config), true);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  // --------------------------------------------------------------------------
  // RUTAS ESCOLARES (`public.ruta`)
  // --------------------------------------------------------------------------

  async createRoute(input: CreateRouteInput): Promise<RouteRecord> {
    try {
      const { rows } = await this.pool.query<RouteRow>(
        `INSERT INTO public.ruta (
           id_colegio,
           id_empresa,
           codigo,
           nombre,
           jornada,
           polilinea_oficial,
           origen_nombre,
           destino_nombre,
           activa
         )
         VALUES ($1, $2, $3, $4, $5, ST_SetSRID(ST_GeomFromGeoJSON($6), 4326)::geography, $7, $8, $9)
         RETURNING
           id_ruta,
           id_colegio,
           id_empresa,
           codigo,
           nombre,
           jornada,
           ST_AsGeoJSON(polilinea_oficial)::json AS polilinea_oficial,
           origen_nombre,
           destino_nombre,
           activa,
           creado_en`,
        [
          input.id_colegio,
          input.id_empresa,
          input.codigo.trim(),
          input.nombre.trim(),
          input.jornada,
          JSON.stringify(input.polilinea_oficial),
          input.origen_nombre.trim(),
          input.destino_nombre.trim(),
          input.activa ?? true,
        ],
      );
      return this.mapRoute(rows[0]);
    } catch (error) {
      this.rethrowPgError(error, { codigo: input.codigo });
    }
  }

  async findRouteById(idRuta: string): Promise<RouteRecord | null> {
    const { rows } = await this.pool.query<RouteRow>(
      `SELECT
         id_ruta,
         id_colegio,
         id_empresa,
         codigo,
         nombre,
         jornada,
         ST_AsGeoJSON(polilinea_oficial)::json AS polilinea_oficial,
         origen_nombre,
         destino_nombre,
         activa,
         creado_en
       FROM public.ruta
       WHERE id_ruta = $1`,
      [idRuta],
    );
    return rows[0] ? this.mapRoute(rows[0]) : null;
  }

  async listRoutes(filter?: ListRoutesFilter): Promise<RouteRecord[]> {
    const { rows } = await this.pool.query<RouteRow>(
      `SELECT
         id_ruta,
         id_colegio,
         id_empresa,
         codigo,
         nombre,
         jornada,
         ST_AsGeoJSON(polilinea_oficial)::json AS polilinea_oficial,
         origen_nombre,
         destino_nombre,
         activa,
         creado_en
       FROM public.ruta
       WHERE ($1::uuid IS NULL OR id_colegio = $1::uuid)
         AND ($2::boolean IS NULL OR activa = $2::boolean)
       ORDER BY codigo ASC`,
      [filter?.id_colegio ?? null, filter?.activa ?? null],
    );
    return rows.map((row) => this.mapRoute(row));
  }

  async updateRoute(
    idRuta: string,
    input: UpdateRouteInput,
  ): Promise<RouteRecord | null> {
    const { rows } = await this.pool.query<RouteRow>(
      `UPDATE public.ruta
       SET
         nombre = COALESCE($2, nombre),
         jornada = COALESCE($3, jornada),
         polilinea_oficial = CASE
           WHEN $4::text IS NOT NULL THEN ST_SetSRID(ST_GeomFromGeoJSON($4::text), 4326)::geography
           ELSE polilinea_oficial
         END,
         origen_nombre = COALESCE($5, origen_nombre),
         destino_nombre = COALESCE($6, destino_nombre),
         activa = COALESCE($7, activa)
       WHERE id_ruta = $1
       RETURNING
         id_ruta,
         id_colegio,
         id_empresa,
         codigo,
         nombre,
         jornada,
         ST_AsGeoJSON(polilinea_oficial)::json AS polilinea_oficial,
         origen_nombre,
         destino_nombre,
         activa,
         creado_en`,
      [
        idRuta,
        input.nombre?.trim() ?? null,
        input.jornada ?? null,
        input.polilinea_oficial
          ? JSON.stringify(input.polilinea_oficial)
          : null,
        input.origen_nombre?.trim() ?? null,
        input.destino_nombre?.trim() ?? null,
        input.activa ?? null,
      ],
    );
    return rows[0] ? this.mapRoute(rows[0]) : null;
  }

  async deleteRoute(idRuta: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `DELETE FROM public.ruta WHERE id_ruta = $1`,
        [idRuta],
      );
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      this.rethrowPgError(error);
    }
  }

  // --------------------------------------------------------------------------
  // PARADAS OFICIALES (`public.parada`)
  // --------------------------------------------------------------------------

  async createStop(
    idRuta: string,
    input: Required<
      Pick<
        CreateStopInput,
        | "nombre"
        | "orden_secuencia"
        | "punto_geografico"
        | "horario_estimado"
        | "radio_geocerca"
      >
    >,
  ): Promise<StopRecord> {
    try {
      const { rows } = await this.pool.query<StopRow>(
        `INSERT INTO public.parada (
           id_ruta,
           nombre,
           orden_secuencia,
           punto_geografico,
           horario_estimado,
           radio_geocerca
         )
         VALUES (
           $1,
           $2,
           $3,
           ST_SetSRID(ST_GeomFromGeoJSON($4), 4326)::geography,
           $5::time,
           ST_SetSRID(ST_GeomFromGeoJSON($6), 4326)::geography
         )
         RETURNING
           id_parada,
           id_ruta,
           nombre,
           orden_secuencia,
           ST_AsGeoJSON(punto_geografico)::json AS punto_geografico,
           horario_estimado::text AS horario_estimado,
           ST_AsGeoJSON(radio_geocerca)::json AS radio_geocerca,
           ST_Y(punto_geografico::geometry)::double precision AS latitud,
           ST_X(punto_geografico::geometry)::double precision AS longitud`,
        [
          idRuta,
          input.nombre.trim(),
          input.orden_secuencia,
          JSON.stringify(input.punto_geografico),
          input.horario_estimado,
          JSON.stringify(input.radio_geocerca),
        ],
      );
      return this.mapStop(rows[0]);
    } catch (error) {
      this.rethrowPgError(error, {
        id_ruta: idRuta,
        orden_secuencia: input.orden_secuencia,
      });
    }
  }

  async findStopById(idParada: string): Promise<StopRecord | null> {
    const { rows } = await this.pool.query<StopRow>(
      `SELECT
         id_parada,
         id_ruta,
         nombre,
         orden_secuencia,
         ST_AsGeoJSON(punto_geografico)::json AS punto_geografico,
         horario_estimado::text AS horario_estimado,
         ST_AsGeoJSON(radio_geocerca)::json AS radio_geocerca,
         ST_Y(punto_geografico::geometry)::double precision AS latitud,
         ST_X(punto_geografico::geometry)::double precision AS longitud
       FROM public.parada
       WHERE id_parada = $1`,
      [idParada],
    );
    return rows[0] ? this.mapStop(rows[0]) : null;
  }

  async listStopsByRoute(idRuta: string): Promise<StopRecord[]> {
    const { rows } = await this.pool.query<StopRow>(
      `SELECT
         id_parada,
         id_ruta,
         nombre,
         orden_secuencia,
         ST_AsGeoJSON(punto_geografico)::json AS punto_geografico,
         horario_estimado::text AS horario_estimado,
         ST_AsGeoJSON(radio_geocerca)::json AS radio_geocerca,
         ST_Y(punto_geografico::geometry)::double precision AS latitud,
         ST_X(punto_geografico::geometry)::double precision AS longitud
       FROM public.parada
       WHERE id_ruta = $1
       ORDER BY orden_secuencia ASC`,
      [idRuta],
    );
    return rows.map((row) => this.mapStop(row));
  }

  async updateStop(
    idRuta: string,
    idParada: string,
    input: Partial<
      Pick<
        StopRecord,
        | "nombre"
        | "orden_secuencia"
        | "punto_geografico"
        | "horario_estimado"
        | "radio_geocerca"
      >
    >,
  ): Promise<StopRecord | null> {
    try {
      const { rows } = await this.pool.query<StopRow>(
        `UPDATE public.parada
         SET
           nombre = COALESCE($3, nombre),
           orden_secuencia = COALESCE($4, orden_secuencia),
           punto_geografico = CASE
             WHEN $5::text IS NOT NULL THEN ST_SetSRID(ST_GeomFromGeoJSON($5::text), 4326)::geography
             ELSE punto_geografico
           END,
           horario_estimado = COALESCE($6::time, horario_estimado),
           radio_geocerca = CASE
             WHEN $7::text IS NOT NULL THEN ST_SetSRID(ST_GeomFromGeoJSON($7::text), 4326)::geography
             ELSE radio_geocerca
           END
         WHERE id_ruta = $1 AND id_parada = $2
         RETURNING
           id_parada,
           id_ruta,
           nombre,
           orden_secuencia,
           ST_AsGeoJSON(punto_geografico)::json AS punto_geografico,
           horario_estimado::text AS horario_estimado,
           ST_AsGeoJSON(radio_geocerca)::json AS radio_geocerca,
           ST_Y(punto_geografico::geometry)::double precision AS latitud,
           ST_X(punto_geografico::geometry)::double precision AS longitud`,
        [
          idRuta,
          idParada,
          input.nombre?.trim() ?? null,
          input.orden_secuencia ?? null,
          input.punto_geografico
            ? JSON.stringify(input.punto_geografico)
            : null,
          input.horario_estimado ?? null,
          input.radio_geocerca ? JSON.stringify(input.radio_geocerca) : null,
        ],
      );
      return rows[0] ? this.mapStop(rows[0]) : null;
    } catch (error) {
      this.rethrowPgError(error, {
        id_ruta: idRuta,
        orden_secuencia: input.orden_secuencia,
      });
    }
  }

  async deleteStop(idRuta: string, idParada: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `DELETE FROM public.parada WHERE id_ruta = $1 AND id_parada = $2`,
        [idRuta, idParada],
      );
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      this.rethrowPgError(error);
    }
  }

  // --------------------------------------------------------------------------
  // ZONAS GEOGRÁFICAS Y GEOCERCAS (`public.zona_geografica`)
  // --------------------------------------------------------------------------

  async createZone(input: CreateZoneInput): Promise<GeofenceZoneRecord> {
    try {
      const { rows } = await this.pool.query<ZoneRow>(
        `INSERT INTO public.zona_geografica (
           codigo,
           id_colegio,
           nombre,
           tipo_zona,
           poligono,
           descripcion,
           activa
         )
         VALUES ($1, $2, $3, $4, ST_SetSRID(ST_GeomFromGeoJSON($5), 4326)::geography, $6, $7)
         RETURNING
           id_zona,
           codigo,
           id_colegio,
           nombre,
           tipo_zona,
           ST_AsGeoJSON(poligono)::json AS poligono,
           descripcion,
           activa,
           creado_en`,
        [
          input.codigo?.trim() ?? null,
          input.id_colegio ?? null,
          input.nombre.trim(),
          input.tipo_zona,
          JSON.stringify(input.poligono),
          input.descripcion?.trim() ?? null,
          input.activa ?? true,
        ],
      );
      return this.mapZone(rows[0]);
    } catch (error) {
      this.rethrowPgError(error, { codigo: input.codigo ?? undefined });
    }
  }

  async findZoneById(idZona: string): Promise<GeofenceZoneRecord | null> {
    const { rows } = await this.pool.query<ZoneRow>(
      `SELECT
         id_zona,
         codigo,
         id_colegio,
         nombre,
         tipo_zona,
         ST_AsGeoJSON(poligono)::json AS poligono,
         descripcion,
         activa,
         creado_en
       FROM public.zona_geografica
       WHERE id_zona = $1`,
      [idZona],
    );
    return rows[0] ? this.mapZone(rows[0]) : null;
  }

  async findZoneByCode(codigo: string): Promise<GeofenceZoneRecord | null> {
    const { rows } = await this.pool.query<ZoneRow>(
      `SELECT
         id_zona,
         codigo,
         id_colegio,
         nombre,
         tipo_zona,
         ST_AsGeoJSON(poligono)::json AS poligono,
         descripcion,
         activa,
         creado_en
       FROM public.zona_geografica
       WHERE codigo = $1`,
      [codigo],
    );
    return rows[0] ? this.mapZone(rows[0]) : null;
  }

  async listZones(filter?: {
    tipo_zona?: ZoneType;
    activa?: boolean;
  }): Promise<GeofenceZoneRecord[]> {
    const { rows } = await this.pool.query<ZoneRow>(
      `SELECT
         id_zona,
         codigo,
         id_colegio,
         nombre,
         tipo_zona,
         ST_AsGeoJSON(poligono)::json AS poligono,
         descripcion,
         activa,
         creado_en
       FROM public.zona_geografica
       WHERE ($1::varchar IS NULL OR tipo_zona = $1::varchar)
         AND ($2::boolean IS NULL OR activa = $2::boolean)
       ORDER BY nombre ASC`,
      [filter?.tipo_zona ?? null, filter?.activa ?? null],
    );
    return rows.map((row) => this.mapZone(row));
  }

  async updateZone(
    idZona: string,
    input: UpdateZoneInput,
  ): Promise<GeofenceZoneRecord | null> {
    const { rows } = await this.pool.query<ZoneRow>(
      `UPDATE public.zona_geografica
       SET
         nombre = COALESCE($2, nombre),
         tipo_zona = COALESCE($3, tipo_zona),
         poligono = CASE
           WHEN $4::text IS NOT NULL THEN ST_SetSRID(ST_GeomFromGeoJSON($4::text), 4326)::geography
           ELSE poligono
         END,
         descripcion = COALESCE($5, descripcion),
         activa = COALESCE($6, activa)
       WHERE id_zona = $1
       RETURNING
         id_zona,
         codigo,
         id_colegio,
         nombre,
         tipo_zona,
         ST_AsGeoJSON(poligono)::json AS poligono,
         descripcion,
         activa,
         creado_en`,
      [
        idZona,
        input.nombre?.trim() ?? null,
        input.tipo_zona ?? null,
        input.poligono ? JSON.stringify(input.poligono) : null,
        input.descripcion?.trim() ?? null,
        input.activa ?? null,
      ],
    );
    return rows[0] ? this.mapZone(rows[0]) : null;
  }

  async deleteZone(idZona: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM public.zona_geografica WHERE id_zona = $1`,
      [idZona],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // --------------------------------------------------------------------------
  // ASIGNACIÓN DE ESTUDIANTE A RUTA (`public.asignacion_ruta`)
  // --------------------------------------------------------------------------

  async createAssignment(
    input: CreateRouteAssignmentInput,
  ): Promise<RouteAssignmentRecord> {
    try {
      const { rows } = await this.pool.query<AssignmentRow>(
        `INSERT INTO public.asignacion_ruta (
           id_estudiante,
           id_ruta,
           id_parada_subida,
           id_parada_bajada,
           ciclo_horario,
           activa
         )
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING
           id_asignacion,
           id_estudiante,
           id_ruta,
           id_parada_subida,
           id_parada_bajada,
           ciclo_horario,
           activa,
           fecha_asignacion`,
        [
          input.id_estudiante,
          input.id_ruta,
          input.id_parada_subida,
          input.id_parada_bajada,
          input.ciclo_horario,
        ],
      );
      return this.mapAssignment(rows[0]);
    } catch (error) {
      this.rethrowPgError(error, {
        id_estudiante: input.id_estudiante,
        id_ruta: input.id_ruta,
        id_parada_subida: input.id_parada_subida,
        id_parada_bajada: input.id_parada_bajada,
        ciclo_horario: input.ciclo_horario,
      });
    }
  }

  async findAssignmentById(
    idAsignacion: string,
  ): Promise<RouteAssignmentRecord | null> {
    const { rows } = await this.pool.query<AssignmentRow>(
      `SELECT
         id_asignacion,
         id_estudiante,
         id_ruta,
         id_parada_subida,
         id_parada_bajada,
         ciclo_horario,
         activa,
         fecha_asignacion
       FROM public.asignacion_ruta
       WHERE id_asignacion = $1`,
      [idAsignacion],
    );
    return rows[0] ? this.mapAssignment(rows[0]) : null;
  }

  async listAssignmentsByRoute(
    idRuta: string,
    soloActivas = true,
  ): Promise<RouteAssignmentRecord[]> {
    const { rows } = await this.pool.query<AssignmentRow>(
      `SELECT
         id_asignacion,
         id_estudiante,
         id_ruta,
         id_parada_subida,
         id_parada_bajada,
         ciclo_horario,
         activa,
         fecha_asignacion
       FROM public.asignacion_ruta
       WHERE id_ruta = $1
         AND ($2::boolean = FALSE OR activa = TRUE)
       ORDER BY fecha_asignacion DESC`,
      [idRuta, soloActivas],
    );
    return rows.map((row) => this.mapAssignment(row));
  }

  async listAssignmentsByStudent(
    idEstudiante: string,
    soloActivas = true,
  ): Promise<RouteAssignmentRecord[]> {
    const { rows } = await this.pool.query<AssignmentRow>(
      `SELECT
         id_asignacion,
         id_estudiante,
         id_ruta,
         id_parada_subida,
         id_parada_bajada,
         ciclo_horario,
         activa,
         fecha_asignacion
       FROM public.asignacion_ruta
       WHERE id_estudiante = $1
         AND ($2::boolean = FALSE OR activa = TRUE)
       ORDER BY fecha_asignacion DESC`,
      [idEstudiante, soloActivas],
    );
    return rows.map((row) => this.mapAssignment(row));
  }

  async deactivateAssignment(idAsignacion: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE public.asignacion_ruta
       SET activa = FALSE
       WHERE id_asignacion = $1 AND activa = TRUE`,
      [idAsignacion],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // --------------------------------------------------------------------------
  // CONSULTAS ESPACIALES GiST (IGeoProximityQueries - RNF-05)
  // --------------------------------------------------------------------------

  async findStopsWithinRadius(
    latitud: number,
    longitud: number,
    radioMetros: number,
    idRuta?: string,
  ): Promise<NearbyStopResult[]> {
    const { rows } = await this.pool.query<StopRow>(
      `SELECT
         id_parada,
         id_ruta,
         nombre,
         orden_secuencia,
         ST_AsGeoJSON(punto_geografico)::json AS punto_geografico,
         horario_estimado::text AS horario_estimado,
         ST_AsGeoJSON(radio_geocerca)::json AS radio_geocerca,
         ST_Y(punto_geografico::geometry)::double precision AS latitud,
         ST_X(punto_geografico::geometry)::double precision AS longitud,
         ROUND(
           ST_Distance(
             punto_geografico,
             ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
           )::numeric,
           2
         )::double precision AS distancia_metros
       FROM public.parada
       WHERE ST_DWithin(
         punto_geografico,
         ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
         $3
       )
         AND ($4::uuid IS NULL OR id_ruta = $4::uuid)
       ORDER BY distancia_metros ASC, orden_secuencia ASC`,
      [longitud, latitud, radioMetros, idRuta ?? null],
    );

    return rows.map((row) => ({
      ...this.mapStop(row),
      distancia_metros: Number(row.distancia_metros ?? 0),
    }));
  }

  async calculateDistanceBetweenPoints(
    origen: GeographicCoordinates,
    destino: GeographicCoordinates,
  ): Promise<number> {
    const { rows } = await this.pool.query<{ distancia_metros: number }>(
      `SELECT ROUND(
         ST_Distance(
           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
           ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography
         )::numeric,
         2
       )::double precision AS distancia_metros`,
      [origen.longitud, origen.latitud, destino.longitud, destino.latitud],
    );
    return Number(rows[0].distancia_metros);
  }

  async calculateDistanceToStop(
    idParada: string,
    latitud: number,
    longitud: number,
  ): Promise<number | null> {
    const { rows } = await this.pool.query<{ distancia_metros: number }>(
      `SELECT ROUND(
         ST_Distance(
           punto_geografico,
           ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography
         )::numeric,
         2
       )::double precision AS distancia_metros
       FROM public.parada
       WHERE id_parada = $1`,
      [idParada, longitud, latitud],
    );
    return rows[0] ? Number(rows[0].distancia_metros) : null;
  }

  async isPointInsideStopGeofence(
    idParada: string,
    latitud: number,
    longitud: number,
  ): Promise<boolean | null> {
    const { rows } = await this.pool.query<{ dentro: boolean }>(
      `SELECT (
         ST_DWithin(
           radio_geocerca,
           ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
           0
         )
         AND ST_Contains(
           radio_geocerca::geometry,
           ST_SetSRID(ST_MakePoint($2, $3), 4326)
         )
       ) AS dentro
       FROM public.parada
       WHERE id_parada = $1`,
      [idParada, longitud, latitud],
    );
    return rows[0] ? Boolean(rows[0].dentro) : null;
  }

  async isPointInsideZone(
    idZona: string,
    latitud: number,
    longitud: number,
  ): Promise<boolean | null> {
    const { rows } = await this.pool.query<{ dentro: boolean }>(
      `SELECT (
         ST_DWithin(
           poligono,
           ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
           0
         )
         AND ST_Contains(
           poligono::geometry,
           ST_SetSRID(ST_MakePoint($2, $3), 4326)
         )
       ) AS dentro
       FROM public.zona_geografica
       WHERE id_zona = $1`,
      [idZona, longitud, latitud],
    );
    return rows[0] ? Boolean(rows[0].dentro) : null;
  }

  async findContainingZones(
    latitud: number,
    longitud: number,
    tipoZona?: ZoneType,
  ): Promise<GeofenceZoneRecord[]> {
    const { rows } = await this.pool.query<ZoneRow>(
      `SELECT
         id_zona,
         codigo,
         id_colegio,
         nombre,
         tipo_zona,
         ST_AsGeoJSON(poligono)::json AS poligono,
         descripcion,
         activa,
         creado_en
       FROM public.zona_geografica
       WHERE activa = TRUE
         AND ($3::varchar IS NULL OR tipo_zona = $3::varchar)
         AND ST_DWithin(
           poligono,
           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
           0
         )
         AND ST_Contains(
           poligono::geometry,
           ST_SetSRID(ST_MakePoint($1, $2), 4326)
         )
       ORDER BY nombre ASC`,
      [longitud, latitud, tipoZona ?? null],
    );
    return rows.map((row) => this.mapZone(row));
  }

  async isPointInsideSchoolGeofence(
    latitud: number,
    longitud: number,
    codigo: string = SAN_BENITO_GEOFENCE_CODE,
  ): Promise<{ dentro: boolean; zona: GeofenceZoneRecord | null }> {
    const zona = await this.findZoneByCode(codigo);
    if (!zona || !zona.activa) {
      return { dentro: false, zona };
    }
    const dentro =
      (await this.isPointInsideZone(zona.id_zona, latitud, longitud)) ?? false;
    return { dentro, zona };
  }

  // --------------------------------------------------------------------------
  // MAPPERS Y TRADUCCIÓN DE ERRORES POSTGRESQL
  // --------------------------------------------------------------------------

  private mapRoute(row: RouteRow): RouteRecord {
    return {
      id_ruta: row.id_ruta,
      id_colegio: row.id_colegio,
      id_empresa: row.id_empresa,
      codigo: row.codigo,
      nombre: row.nombre,
      jornada: row.jornada,
      polilinea_oficial: row.polilinea_oficial,
      origen_nombre: row.origen_nombre,
      destino_nombre: row.destino_nombre,
      activa: row.activa,
      creado_en: new Date(row.creado_en),
    };
  }

  private mapStop(row: StopRow): StopRecord {
    return {
      id_parada: row.id_parada,
      id_ruta: row.id_ruta,
      nombre: row.nombre,
      orden_secuencia: Number(row.orden_secuencia),
      punto_geografico: row.punto_geografico,
      horario_estimado: row.horario_estimado,
      radio_geocerca: row.radio_geocerca,
      latitud: Number(row.latitud),
      longitud: Number(row.longitud),
    };
  }

  private mapZone(row: ZoneRow): GeofenceZoneRecord {
    return {
      id_zona: row.id_zona,
      codigo: row.codigo ?? null,
      id_colegio: row.id_colegio ?? null,
      nombre: row.nombre,
      tipo_zona: row.tipo_zona,
      poligono: row.poligono,
      descripcion: row.descripcion ?? null,
      activa: row.activa,
      creado_en: new Date(row.creado_en),
    };
  }

  private mapAssignment(row: AssignmentRow): RouteAssignmentRecord {
    return {
      id_asignacion: row.id_asignacion,
      id_estudiante: row.id_estudiante,
      id_ruta: row.id_ruta,
      id_parada_subida: row.id_parada_subida,
      id_parada_bajada: row.id_parada_bajada,
      ciclo_horario: row.ciclo_horario,
      activa: row.activa,
      fecha_asignacion: new Date(row.fecha_asignacion),
    };
  }

  private rethrowPgError(
    error: unknown,
    context?: {
      codigo?: string;
      id_ruta?: string;
      orden_secuencia?: number;
      id_estudiante?: string;
      id_parada_subida?: string;
      id_parada_bajada?: string;
      ciclo_horario?: AssignmentCycle;
    },
  ): never {
    const pgErr = error as PgErrorLike | undefined;
    if (pgErr?.code === "23503") {
      if (pgErr.constraint === "fk_asignacion_subida_compuesta") {
        throw new CompositeStopRouteMismatchError(
          "fk_asignacion_subida_compuesta",
          context?.id_ruta ?? "",
          context?.id_parada_subida ?? "",
        );
      }
      if (pgErr.constraint === "fk_asignacion_bajada_compuesta") {
        throw new CompositeStopRouteMismatchError(
          "fk_asignacion_bajada_compuesta",
          context?.id_ruta ?? "",
          context?.id_parada_bajada ?? "",
        );
      }
      throw new ForeignKeyReferenceError(pgErr.constraint ?? "foreign_key");
    }

    if (pgErr?.code === "23505") {
      if (pgErr.constraint === "ruta_codigo_key") {
        throw new DuplicateRouteCodeError(context?.codigo ?? "");
      }
      if (pgErr.constraint === "uq_parada_ruta_secuencia") {
        throw new DuplicateStopSequenceError(
          context?.id_ruta ?? "",
          context?.orden_secuencia ?? 0,
        );
      }
      if (pgErr.constraint === "uq_estudiante_asignacion_franja") {
        throw new DuplicateActiveAssignmentError(
          context?.id_estudiante ?? "",
          context?.ciclo_horario ?? AssignmentCycle.AMBOS,
        );
      }
      if (pgErr.constraint === "uq_zona_geografica_codigo") {
        throw new DuplicateZoneCodeError(context?.codigo ?? "");
      }
    }

    throw error;
  }
}
