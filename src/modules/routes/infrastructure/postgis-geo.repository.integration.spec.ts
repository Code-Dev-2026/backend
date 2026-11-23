import * as crypto from "crypto";
import { Pool } from "pg";
import {
  createCircularGeofencePolygon,
  SAN_BENITO_CENTER,
  SAN_BENITO_GEOFENCE_CODE,
} from "../domain/geo.types";
import {
  AssignmentCycle,
  CompositeStopRouteMismatchError,
  RouteShift,
  ZoneType,
} from "../domain/route.entity";
import { PostgisGeoRepository } from "./postgis-geo.repository";

const runPostgis = process.env.RUN_POSTGIS_TESTS === "true";
const describeIfPostgis = runPostgis ? describe : describe.skip;

/**
 * Pruebas de integración contra PostgreSQL 16 + PostGIS 3.4 real (Issue #6).
 * Se ejecutan activando RUN_POSTGIS_TESTS=true contra el contenedor local PostGIS.
 *
 * Verifica:
 * 1. Criterio de aceptación exacto: rechazo en BD por FK compuesta (id_ruta, id_parada).
 * 2. Consultas espaciales ST_DWithin / ST_Distance / ST_Contains con coordenadas reales de Pereira.
 * 3. Geocerca oficial de la sede Colegio San Benito del Otún (V013).
 * 4. Existencia de índices espaciales GiST directos sobre columnas geography.
 */
describeIfPostgis(
  "PostgisGeoRepository (Integración PostgreSQL 16 + PostGIS 3.4)",
  () => {
    let pool: Pool;
    let repository: PostgisGeoRepository;
    const tag = crypto.randomBytes(4).toString("hex");

    let idColegio: string;
    let idEmpresa: string;
    let idEstudiante: string;
    const createdRouteIds: string[] = [];
    const createdZoneIds: string[] = [];

    beforeAll(async () => {
      pool = new Pool({
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? "5432"),
        database: process.env.DB_NAME ?? "camino_seguro_db",
        user: process.env.DB_USER ?? "app_user",
        password: process.env.DB_PASSWORD ?? "",
      });
      repository = new PostgisGeoRepository(pool, false);

      // Fixtures mínimos en BD real (colegio, empresa_transportadora, estudiante)
      const col = await pool.query<{ id_colegio: string }>(
        `INSERT INTO public.colegio (nombre, nit, direccion, telefono)
         VALUES ($1, $2, $3, $4)
         RETURNING id_colegio`,
        [
          `Colegio Test Geo ${tag}`,
          `900${tag}-1`,
          "Carrera 7 No. 24-50, Pereira",
          "3134567",
        ],
      );
      idColegio = col.rows[0].id_colegio;

      const emp = await pool.query<{ id_empresa: string }>(
        `INSERT INTO public.empresa_transportadora (razon_social, nit, telefono, email_contacto)
         VALUES ($1, $2, $3, $4)
         RETURNING id_empresa`,
        [
          `Transportes Test Geo ${tag}`,
          `901${tag}-2`,
          "3245678",
          `geo-${tag}@test.co`,
        ],
      );
      idEmpresa = emp.rows[0].id_empresa;

      const aesDummy = `v1:${"a".repeat(24)}:${"b".repeat(32)}:${"c".repeat(16)}`;
      const hash1 = crypto
        .createHash("sha256")
        .update(`doc-${tag}`)
        .digest("hex");
      const hash2 = crypto
        .createHash("sha256")
        .update(`qr-${tag}`)
        .digest("hex");

      const est = await pool.query<{ id_estudiante: string }>(
        `INSERT INTO public.estudiante (
           id_colegio, codigo_institucional, documento_cifrado,
           documento_blind_index, nombres_cifrado, apellidos_cifrado,
           fecha_nacimiento_cifrada, grado, qr_token_hash, domicilio_punto
         )
         VALUES (
           $1, $2, $3, $4, $3, $3, $3, '5A', $5,
           ST_SetSRID(ST_MakePoint(-75.6961, 4.8133), 4326)::geography
         )
         RETURNING id_estudiante`,
        [idColegio, `EST-GEO-${tag}`, aesDummy, hash1, hash2],
      );
      idEstudiante = est.rows[0].id_estudiante;
    });

    afterAll(async () => {
      try {
        if (idEstudiante) {
          await pool.query(
            `DELETE FROM public.asignacion_ruta WHERE id_estudiante = $1`,
            [idEstudiante],
          );
          await pool.query(
            `DELETE FROM public.estudiante WHERE id_estudiante = $1`,
            [idEstudiante],
          );
        }
        for (const idRuta of createdRouteIds) {
          await pool.query(`DELETE FROM public.ruta WHERE id_ruta = $1`, [
            idRuta,
          ]);
        }
        for (const idZona of createdZoneIds) {
          await pool.query(
            `DELETE FROM public.zona_geografica WHERE id_zona = $1`,
            [idZona],
          );
        }
        if (idEmpresa) {
          await pool.query(
            `DELETE FROM public.empresa_transportadora WHERE id_empresa = $1`,
            [idEmpresa],
          );
        }
        if (idColegio) {
          await pool.query(`DELETE FROM public.colegio WHERE id_colegio = $1`, [
            idColegio,
          ]);
        }
      } finally {
        await pool.end();
      }
    });

    it("Criterio de Aceptación #6: PostgreSQL rechaza asignar parada de R-02 a estudiante en R-01 por FK compuesta (id_ruta, id_parada)", async () => {
      const ruta1 = await repository.createRoute({
        id_colegio: idColegio,
        id_empresa: idEmpresa,
        codigo: `R01-${tag}`,
        nombre: "Ruta R-01 Pereira Centro",
        jornada: RouteShift.MANANA,
        polilinea_oficial: {
          type: "LineString",
          coordinates: [
            [-75.6961, 4.8133],
            [-75.6946, 4.8143],
          ],
        },
        origen_nombre: "Parque Los Álamos",
        destino_nombre: "Colegio San Benito del Otún",
      });
      createdRouteIds.push(ruta1.id_ruta);

      const ruta2 = await repository.createRoute({
        id_colegio: idColegio,
        id_empresa: idEmpresa,
        codigo: `R02-${tag}`,
        nombre: "Ruta R-02 Cerritos",
        jornada: RouteShift.MANANA,
        polilinea_oficial: {
          type: "LineString",
          coordinates: [
            [-75.7395, 4.8127],
            [-75.6946, 4.8143],
          ],
        },
        origen_nombre: "Aeropuerto Matecaña",
        destino_nombre: "Colegio San Benito del Otún",
      });
      createdRouteIds.push(ruta2.id_ruta);

      const paradaR1 = await repository.createStop(ruta1.id_ruta, {
        nombre: "Parque Los Álamos",
        orden_secuencia: 1,
        punto_geografico: { type: "Point", coordinates: [-75.6961, 4.8133] },
        horario_estimado: "06:25:00",
        radio_geocerca: createCircularGeofencePolygon(4.8133, -75.6961, 100),
      });

      const paradaR2 = await repository.createStop(ruta2.id_ruta, {
        nombre: "Aeropuerto Matecaña",
        orden_secuencia: 1,
        punto_geografico: { type: "Point", coordinates: [-75.7395, 4.8127] },
        horario_estimado: "06:10:00",
        radio_geocerca: createCircularGeofencePolygon(4.8127, -75.7395, 100),
      });

      // Intento inválido: parada de subida pertenece a R-02 en asignación de R-01
      await expect(
        repository.createAssignment({
          id_estudiante: idEstudiante,
          id_ruta: ruta1.id_ruta,
          id_parada_subida: paradaR2.id_parada,
          id_parada_bajada: paradaR1.id_parada,
          ciclo_horario: AssignmentCycle.IDA,
        }),
      ).rejects.toThrow(CompositeStopRouteMismatchError);

      // Intento inválido: parada de bajada pertenece a R-02 en asignación de R-01
      await expect(
        repository.createAssignment({
          id_estudiante: idEstudiante,
          id_ruta: ruta1.id_ruta,
          id_parada_subida: paradaR1.id_parada,
          id_parada_bajada: paradaR2.id_parada,
          ciclo_horario: AssignmentCycle.IDA,
        }),
      ).rejects.toThrow(CompositeStopRouteMismatchError);

      // Intento válido: ambas paradas pertenecen a R-01
      const valid = await repository.createAssignment({
        id_estudiante: idEstudiante,
        id_ruta: ruta1.id_ruta,
        id_parada_subida: paradaR1.id_parada,
        id_parada_bajada: paradaR1.id_parada,
        ciclo_horario: AssignmentCycle.IDA,
      });
      expect(valid.id_ruta).toBe(ruta1.id_ruta);
      expect(valid.activa).toBe(true);
    });

    it("calcula proximidad real en Pereira con ST_Distance, ST_DWithin y ST_Contains usando índices GiST", async () => {
      // Distancia esferoidal WGS84 real: Parque Los Álamos -> Sede San Benito (~200 m)
      const distShort = await repository.calculateDistanceBetweenPoints(
        { latitud: 4.8133, longitud: -75.6961 },
        SAN_BENITO_CENTER,
      );
      expect(distShort).toBeGreaterThan(180);
      expect(distShort).toBeLessThan(220);

      // Distancia esferoidal WGS84 real: San Benito -> Aeropuerto Matecaña (~4985 m)
      const distAirport = await repository.calculateDistanceBetweenPoints(
        SAN_BENITO_CENTER,
        { latitud: 4.8127, longitud: -75.7395 },
      );
      expect(distAirport).toBeGreaterThan(4800);
      expect(distAirport).toBeLessThan(5200);

      // ST_DWithin con radio 350m desde Parque Los Álamos encuentra solo paradas cercanas
      const nearby = await repository.findStopsWithinRadius(
        4.8133,
        -75.6961,
        350,
        createdRouteIds[0],
      );
      expect(nearby).toHaveLength(1);
      expect(nearby[0].distancia_metros).toBeLessThanOrEqual(5);

      // Geocerca oficial de sede Colegio San Benito del Otún sembrada en V013
      const insideSchool = await repository.isPointInsideSchoolGeofence(
        SAN_BENITO_CENTER.latitud,
        SAN_BENITO_CENTER.longitud,
        SAN_BENITO_GEOFENCE_CODE,
      );
      expect(insideSchool.zona).not.toBeNull();
      expect(insideSchool.dentro).toBe(true);

      const outsideSchool = await repository.isPointInsideSchoolGeofence(
        4.8127,
        -75.7395,
        SAN_BENITO_GEOFENCE_CODE,
      );
      expect(outsideSchool.dentro).toBe(false);

      // Crear zona de sombra celular personalizada y verificar ST_Contains
      const shadowZone = await repository.createZone({
        codigo: `SOMBRA-TEST-${tag}`,
        nombre: "Sombra Celular Test La Virginia",
        tipo_zona: ZoneType.SOMBRA_CELULAR,
        poligono: createCircularGeofencePolygon(4.8995, -75.8825, 300),
      });
      createdZoneIds.push(shadowZone.id_zona);

      const containing = await repository.findContainingZones(
        4.8995,
        -75.8825,
        ZoneType.SOMBRA_CELULAR,
      );
      expect(containing.some((z) => z.id_zona === shadowZone.id_zona)).toBe(
        true,
      );
    });

    it("verifica que existen los índices GiST directos en ruta, parada y zona_geografica", async () => {
      const { rows } = await pool.query<{ indexname: string }>(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname IN (
             'idx_ruta_polilinea',
             'idx_parada_punto',
             'idx_parada_geocerca',
             'idx_zona_poligono'
           )`,
      );
      expect(rows.map((r) => r.indexname).sort()).toEqual([
        "idx_parada_geocerca",
        "idx_parada_punto",
        "idx_ruta_polilinea",
        "idx_zona_poligono",
      ]);
    });
  },
);
