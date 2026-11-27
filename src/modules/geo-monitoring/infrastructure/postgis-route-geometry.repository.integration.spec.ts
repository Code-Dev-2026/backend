import * as crypto from "crypto";
import { Pool } from "pg";
import { AuditService } from "../../audit/audit.service";
import { InMemoryEventDispatcher } from "../../telemetry/infrastructure/in-memory-event-dispatcher";
import {
  createCircularGeofencePolygon,
  GeoJsonPosition,
} from "../../routes/domain/geo.types";
import { RouteSecurityAlertPayload } from "../domain/geo-monitoring.types";
import { distancePointToPolylineMeters } from "../domain/polyline-distance";
import { GeoDeviationAnalyzer } from "../geo-deviation-analyzer.service";
import { GeoSecurityIncidentReporter } from "../geo-security-incident-reporter.service";
import { ProlongedStopDetector } from "../rules/prolonged-stop.detector";
import { RouteDeviationDetector } from "../rules/route-deviation.detector";
import {
  DEVIATED_ROUTE_SEQUENCE,
  metersNorthToLatitude,
  ROUTE_LATITUDE,
  STOP_LONGITUDE,
  STOP_RADIUS_METERS,
  toSamples,
  toTelemetryEvent,
} from "../__fixtures__/recorded-gps-sequences";
import { PostgisRouteGeometryRepository } from "./postgis-route-geometry.repository";

const runPostgis =
  process.env.RUN_POSTGIS_TESTS === "true" ||
  process.env.RUN_POSTGRES_TESTS === "true";
const describeIfPostgis = runPostgis ? describe : describe.skip;

/** Trazado recto con vértices colineales intermedios para verificar `ST_Simplify`. */
const R01_DENSE_POLYLINE: GeoJsonPosition[] = Array.from(
  { length: 21 },
  (_, i) => [-75.7 + i * 0.001, ROUTE_LATITUDE] as GeoJsonPosition,
);

const toWkt = (coords: readonly GeoJsonPosition[]) =>
  coords.map(([lng, lat]) => `${lng} ${lat}`).join(", ");

/**
 * Pruebas de integración contra PostgreSQL 16 + PostGIS 3.4 real (Issue #13).
 * Ejecutar con RUN_POSTGIS_TESTS=true tras aplicar V001..V019.
 *
 * Verifica `ST_Simplify` de la polilínea cacheada, `ST_DWithin`/`ST_Distance`
 * geodésicos contra la polilínea oficial, la inserción en `incidente` y el
 * criterio de aceptación de extremo a extremo con el adaptador PostGIS.
 */
describeIfPostgis(
  "PostgisRouteGeometryRepository (Integración PostgreSQL 16 + PostGIS 3.4 — Issue #13)",
  () => {
    let pool: Pool;
    let repository: PostgisRouteGeometryRepository;

    const tag = crypto.randomBytes(3).toString("hex").toUpperCase();
    const aesDummy = `v1:${"a".repeat(24)}:${"b".repeat(32)}:${"c".repeat(16)}`;
    const sha256Hex = (value: string) =>
      crypto.createHash("sha256").update(value, "utf8").digest("hex");

    let idColegio: string;
    let idEmpresa: string;
    let idVehiculo: string;
    let idConductorUsuario: string;
    let idConductor: string;
    let idMonitoraUsuario: string;
    let idMonitora: string;
    let idRuta: string;
    let idViaje: string;

    beforeAll(async () => {
      pool = new Pool({
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? 5432),
        database: process.env.DB_NAME ?? "camino_seguro_db",
        user: process.env.DB_USER ?? "app_user",
        password: process.env.DB_PASSWORD ?? "",
      });
      repository = new PostgisRouteGeometryRepository(pool, false);

      idColegio = (
        await pool.query<{ id_colegio: string }>(
          `INSERT INTO public.colegio (nombre, nit, direccion, telefono)
           VALUES ($1, $2, 'Pereira', '3000000000') RETURNING id_colegio`,
          [`Colegio Geo13 ${tag}`, `900-G13-${tag}`],
        )
      ).rows[0].id_colegio;

      idEmpresa = (
        await pool.query<{ id_empresa: string }>(
          `INSERT INTO public.empresa_transportadora (razon_social, nit, telefono, email_contacto)
           VALUES ($1, $2, '3000000001', $3) RETURNING id_empresa`,
          [
            `Trans Geo13 ${tag}`,
            `901-G13-${tag}`,
            `g13-${tag.toLowerCase()}@test.co`,
          ],
        )
      ).rows[0].id_empresa;

      idVehiculo = (
        await pool.query<{ id_vehiculo: string }>(
          `INSERT INTO public.vehiculo (
             id_empresa, placa, capacidad_nominal, numero_movil,
             modelo, tarjeta_operacion, imei_gps_fijo, activo
           )
           VALUES ($1, $2, 24, $3, '2025', $4, $5, TRUE)
           RETURNING id_vehiculo`,
          [
            idEmpresa,
            `G${tag.slice(0, 5)}`,
            `M-${tag}`,
            `TO-G13-${tag}`,
            `IMEI-G13-${tag}`,
          ],
        )
      ).rows[0].id_vehiculo;

      idConductorUsuario = (
        await pool.query<{ id_usuario: string }>(
          `INSERT INTO public.usuario (email, password_hash)
           VALUES ($1, 'hash_test') RETURNING id_usuario`,
          [`cond-g13-${tag.toLowerCase()}@test.co`],
        )
      ).rows[0].id_usuario;

      idConductor = (
        await pool.query<{ id_conductor: string }>(
          `INSERT INTO public.conductor (
             id_usuario, id_empresa, nombres, apellidos, numero_licencia, vigencia_licencia, telefono
           )
           VALUES ($1, $2, 'Carlos', 'Driver', $3, CURRENT_DATE + INTERVAL '1 year', '3001111111')
           RETURNING id_conductor`,
          [idConductorUsuario, idEmpresa, `LIC-G13-${tag}`],
        )
      ).rows[0].id_conductor;

      idMonitoraUsuario = (
        await pool.query<{ id_usuario: string }>(
          `INSERT INTO public.usuario (email, password_hash)
           VALUES ($1, 'hash_test') RETURNING id_usuario`,
          [`mon-g13-${tag.toLowerCase()}@test.co`],
        )
      ).rows[0].id_usuario;

      idMonitora = (
        await pool.query<{ id_monitora: string }>(
          `INSERT INTO public.monitora (
             id_usuario, id_empresa, nombres, apellidos, documento_cifrado,
             documento_blind_index, telefono
           )
           VALUES ($1, $2, 'Laura', 'Monitora', $3, $4, '3002222222')
           RETURNING id_monitora`,
          [idMonitoraUsuario, idEmpresa, aesDummy, sha256Hex(`mon-g13-${tag}`)],
        )
      ).rows[0].id_monitora;

      idRuta = (
        await pool.query<{ id_ruta: string }>(
          `INSERT INTO public.ruta (
             id_colegio, id_empresa, codigo, nombre, jornada,
             polilinea_oficial, origen_nombre, destino_nombre
           )
           VALUES (
             $1, $2, $3, 'Ruta Desvios 13', 'MANANA',
             ST_GeogFromText($4), 'Centro', 'San Benito'
           )
           RETURNING id_ruta`,
          [
            idColegio,
            idEmpresa,
            `R-01-${tag}`,
            `SRID=4326;LINESTRING(${toWkt(R01_DENSE_POLYLINE)})`,
          ],
        )
      ).rows[0].id_ruta;

      const geofence = createCircularGeofencePolygon(
        ROUTE_LATITUDE,
        STOP_LONGITUDE,
        STOP_RADIUS_METERS,
      );
      await pool.query(
        `INSERT INTO public.parada (
           id_ruta, nombre, orden_secuencia, punto_geografico, horario_estimado, radio_geocerca
         )
         VALUES (
           $1, 'Parada Intermedia R-01', 1,
           ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
           '06:30',
           ST_SetSRID(ST_GeomFromGeoJSON($4), 4326)::geography
         )`,
        [idRuta, STOP_LONGITUDE, ROUTE_LATITUDE, JSON.stringify(geofence)],
      );

      const now = new Date();
      idViaje = (
        await pool.query<{ id_viaje: string }>(
          `INSERT INTO public.viaje (
             id_ruta, id_vehiculo, id_conductor, id_monitora, fecha,
             hora_inicio_programada, hora_fin_programada, estado
           )
           VALUES ($1, $2, $3, $4, $5::date, $6::timestamptz, $7::timestamptz, 'EN_CURSO')
           RETURNING id_viaje`,
          [
            idRuta,
            idVehiculo,
            idConductor,
            idMonitora,
            now.toISOString().slice(0, 10),
            new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
            new Date(now.getTime() + 50 * 60 * 1000).toISOString(),
          ],
        )
      ).rows[0].id_viaje;
    });

    afterAll(async () => {
      try {
        await pool.query(`DELETE FROM public.incidente WHERE id_viaje = $1`, [
          idViaje,
        ]);
        await pool.query(`DELETE FROM public.viaje WHERE id_viaje = $1`, [
          idViaje,
        ]);
        await pool.query(`DELETE FROM public.parada WHERE id_ruta = $1`, [
          idRuta,
        ]);
        await pool.query(`DELETE FROM public.ruta WHERE id_ruta = $1`, [
          idRuta,
        ]);
        await pool.query(`DELETE FROM public.monitora WHERE id_monitora = $1`, [
          idMonitora,
        ]);
        await pool.query(`DELETE FROM public.usuario WHERE id_usuario = $1`, [
          idMonitoraUsuario,
        ]);
        await pool.query(
          `DELETE FROM public.conductor WHERE id_conductor = $1`,
          [idConductor],
        );
        await pool.query(`DELETE FROM public.usuario WHERE id_usuario = $1`, [
          idConductorUsuario,
        ]);
        await pool.query(`DELETE FROM public.vehiculo WHERE id_vehiculo = $1`, [
          idVehiculo,
        ]);
        await pool.query(
          `DELETE FROM public.empresa_transportadora WHERE id_empresa = $1`,
          [idEmpresa],
        );
        await pool.query(`DELETE FROM public.colegio WHERE id_colegio = $1`, [
          idColegio,
        ]);
      } finally {
        await pool.end();
      }
    });

    it("carga la polilínea simplificada (ST_Simplify) y las geocercas de parada del viaje", async () => {
      const geometry = await repository.loadTripRouteGeometry(idViaje);

      expect(geometry).not.toBeNull();
      expect(geometry!.id_ruta).toBe(idRuta);
      expect(geometry!.codigo_ruta).toBe(`R-01-${tag}`);
      // 21 vértices colineales → 2 extremos tras ST_Simplify.
      expect(geometry!.polilinea_simplificada).toHaveLength(2);
      expect(geometry!.paradas).toHaveLength(1);
      expect(geometry!.paradas[0].geocerca.type).toBe("Polygon");
    });

    it("devuelve null para viajes inexistentes o identificadores no UUID", async () => {
      await expect(
        repository.loadTripRouteGeometry(
          "018e38d9-3f00-7200-a000-00000000ffff",
        ),
      ).resolves.toBeNull();
      await expect(
        repository.loadTripRouteGeometry("1; DROP TABLE ruta"),
      ).resolves.toBeNull();
      await expect(
        repository.measureDistanceToRoute(
          "no-uuid",
          { latitud: 4.81, longitud: -75.69 },
          300,
        ),
      ).resolves.toBeNull();
    });

    it.each([
      [100, true],
      [350, false],
    ])(
      "ST_DWithin/ST_Distance geodésicos: punto a %d m → dentro_umbral=%s",
      async (offset, inside) => {
        const punto = {
          latitud: metersNorthToLatitude(offset),
          longitud: -75.6925,
        };
        const measurement = await repository.measureDistanceToRoute(
          idRuta,
          punto,
          300,
        );

        expect(measurement).not.toBeNull();
        expect(measurement!.dentro_umbral).toBe(inside);
        // La proyección local en memoria coincide con el cálculo geodésico (< 1 %).
        const local = distancePointToPolylineMeters(punto, R01_DENSE_POLYLINE);
        expect(Math.abs(measurement!.distancia_metros - local)).toBeLessThan(
          offset * 0.01,
        );
      },
    );

    it("registra el incidente CRITICO con coordenada geography en `incidente`", async () => {
      const recorded = await repository.recordIncident({
        id_viaje: idViaje,
        tipo_incidente: "DETENCION_PROLONGADA",
        severidad: "CRITICO",
        descripcion: "Prueba de integración Issue #13",
        coordenadas: { latitud: 4.8101, longitud: -75.6975 },
      });

      const row = (
        await pool.query<{
          tipo_incidente: string;
          severidad: string;
          lat: number;
          lng: number;
        }>(
          `SELECT tipo_incidente, severidad,
                  ST_Y(coordenada::geometry) AS lat, ST_X(coordenada::geometry) AS lng
             FROM public.incidente WHERE id_incidente = $1`,
          [recorded.id_incidente],
        )
      ).rows[0];
      expect(row).toMatchObject({
        tipo_incidente: "DETENCION_PROLONGADA",
        severidad: "CRITICO",
      });
      expect(row.lat).toBeCloseTo(4.8101, 6);
      expect(row.lng).toBeCloseTo(-75.6975, 6);
    });

    it("criterio de aceptación de extremo a extremo: vía alterna a 350 m → incidente DESVIO_RUTA_SIGNIFICATIVO + alerta", async () => {
      const dispatcher = new InMemoryEventDispatcher();
      const alerts: RouteSecurityAlertPayload[] = [];
      const reporter = new GeoSecurityIncidentReporter(
        repository,
        { emitRouteSecurityAlert: async (p) => (alerts.push(p), true) },
        { logCriticalEvent: async () => undefined } as unknown as AuditService,
        dispatcher,
      );
      const analyzer = new GeoDeviationAnalyzer(
        dispatcher,
        repository,
        [new RouteDeviationDetector(repository), new ProlongedStopDetector()],
        reporter,
      );

      const results = [];
      for (const sample of toSamples(DEVIATED_ROUTE_SEQUENCE, idViaje)) {
        results.push(
          await analyzer.processTelemetryEvent(toTelemetryEvent(sample)),
        );
      }

      const incidentIds = results.flatMap((r) => r.incidentes);
      expect(incidentIds).toHaveLength(1);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].tipo_incidente).toBe("DESVIO_RUTA_SIGNIFICATIVO");

      const stored = (
        await pool.query<{ tipo_incidente: string }>(
          `SELECT tipo_incidente FROM public.incidente WHERE id_incidente = $1`,
          [incidentIds[0]],
        )
      ).rows[0];
      expect(stored.tipo_incidente).toBe("DESVIO_RUTA_SIGNIFICATIVO");

      // DoD: evaluación por coordenada < 100 ms, incluida la confirmación ST_DWithin.
      expect(Math.max(...results.map((r) => r.evaluation_ms))).toBeLessThan(
        100,
      );
    });
  },
);
