import * as crypto from "crypto";
import { Pool } from "pg";
import { uuidv7 } from "@common/utils/uuidv7";
import {
  formatGpsPartitionName,
  TelemetryRecordToPersist,
} from "../domain/telemetry.types";
import { PostgresTelemetryRepository } from "./postgres-telemetry.repository";

const runPostgres =
  process.env.RUN_POSTGRES_TESTS === "true" ||
  process.env.RUN_POSTGIS_TESTS === "true";
const describeIfPostgres = runPostgres ? describe : describe.skip;

/**
 * Pruebas de integración reales contra PostgreSQL 16 + PostGIS 3.4 (Issue #12 — V005 + V019).
 * Ejecutar con RUN_POSTGRES_TESTS=true tras aplicar V001..V019.
 */
describeIfPostgres(
  "PostgresTelemetryRepository & V019 — Particionamiento Mensual, Batch UNNEST y Retención 180 días",
  () => {
    let pool: Pool;
    let repo: PostgresTelemetryRepository;

    const tag = crypto.randomBytes(3).toString("hex").toUpperCase();
    const aesDummy = `v1:${"a".repeat(24)}:${"b".repeat(32)}:${"c".repeat(16)}`;
    const sha256Hex = (value: string) =>
      crypto.createHash("sha256").update(value, "utf8").digest("hex");

    const testPlate = `W${tag.slice(0, 5)}`;
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
        password: process.env.DB_PASSWORD ?? "camino_seguro_pass",
      });
      repo = new PostgresTelemetryRepository(pool, false);

      const colRes = await pool.query<{ id_colegio: string }>(
        `INSERT INTO public.colegio (nombre, nit, direccion, telefono)
         VALUES ($1, $2, 'Pereira', '3000000000') RETURNING id_colegio`,
        [`Colegio Tel12 ${tag}`, `900-T12-${tag}`],
      );
      idColegio = colRes.rows[0].id_colegio;

      const empRes = await pool.query<{ id_empresa: string }>(
        `INSERT INTO public.empresa_transportadora (razon_social, nit, telefono, email_contacto)
         VALUES ($1, $2, '3000000001', $3) RETURNING id_empresa`,
        [`Trans Tel12 ${tag}`, `901-T12-${tag}`, `t12-${tag.toLowerCase()}@test.co`],
      );
      idEmpresa = empRes.rows[0].id_empresa;

      const vehRes = await pool.query<{ id_vehiculo: string }>(
        `INSERT INTO public.vehiculo (
           id_empresa, placa, capacidad_nominal, numero_movil,
           modelo, tarjeta_operacion, imei_gps_fijo, activo
         )
         VALUES ($1, $2, 24, $3, '2025', $4, $5, TRUE)
         RETURNING id_vehiculo`,
        [
          idEmpresa,
          testPlate,
          `M-${tag}`,
          `TO-T12-${tag}`,
          `IMEI-T12-${tag}`,
        ],
      );
      idVehiculo = vehRes.rows[0].id_vehiculo;

      const condUserRes = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test') RETURNING id_usuario`,
        [`cond-t12-${tag.toLowerCase()}@test.co`],
      );
      idConductorUsuario = condUserRes.rows[0].id_usuario;

      const condRes = await pool.query<{ id_conductor: string }>(
        `INSERT INTO public.conductor (
           id_usuario, id_empresa, nombres, apellidos, numero_licencia, vigencia_licencia, telefono
         )
         VALUES ($1, $2, 'Carlos', 'Driver', $3, CURRENT_DATE + INTERVAL '1 year', '3001111111')
         RETURNING id_conductor`,
        [idConductorUsuario, idEmpresa, `LIC-T12-${tag}`],
      );
      idConductor = condRes.rows[0].id_conductor;

      const monUserRes = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test') RETURNING id_usuario`,
        [`mon-t12-${tag.toLowerCase()}@test.co`],
      );
      idMonitoraUsuario = monUserRes.rows[0].id_usuario;

      const monRes = await pool.query<{ id_monitora: string }>(
        `INSERT INTO public.monitora (
           id_usuario, id_empresa, nombres, apellidos, documento_cifrado,
           documento_blind_index, telefono
         )
         VALUES ($1, $2, 'Laura', 'Monitora', $3, $4, '3002222222')
         RETURNING id_monitora`,
        [
          idMonitoraUsuario,
          idEmpresa,
          aesDummy,
          sha256Hex(`mon-t12-${tag}`),
        ],
      );
      idMonitora = monRes.rows[0].id_monitora;

      const rutaRes = await pool.query<{ id_ruta: string }>(
        `INSERT INTO public.ruta (
           id_colegio, id_empresa, codigo, nombre, jornada,
           polilinea_oficial, origen_nombre, destino_nombre
         )
         VALUES (
           $1, $2, $3, 'Ruta Telemetria 12', 'MANANA',
           ST_GeogFromText('SRID=4326;LINESTRING(-75.7000 4.8100, -75.6961 4.8133)'),
           'Centro', 'San Benito'
         )
         RETURNING id_ruta`,
        [idColegio, idEmpresa, `RT-T12-${tag}`],
      );
      idRuta = rutaRes.rows[0].id_ruta;

      const now = new Date();
      const startIso = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
      const endIso = new Date(now.getTime() + 50 * 60 * 1000).toISOString();
      const viajeRes = await pool.query<{ id_viaje: string }>(
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
          startIso,
          endIso,
        ],
      );
      idViaje = viajeRes.rows[0].id_viaje;
    });

    afterAll(async () => {
      try {
        await pool.query(
          `DELETE FROM public.registro_gps WHERE id_vehiculo = $1`,
          [idVehiculo],
        );
        await pool.query(`DELETE FROM public.viaje WHERE id_viaje = $1`, [
          idViaje,
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

    it("integra fn_crear_particion_gps_mensual, resuelve vehículo/viaje, inserta en lote en la partición del mes en curso y deduplica", async () => {
      const now = new Date();
      const expectedPartition = formatGpsPartitionName(now);

      const partitions = await repo.ensureMonthlyPartitions(now, 2);
      expect(partitions.map((p) => p.nombre_particion)).toContain(
        expectedPartition,
      );

      const context = await repo.resolveVehicleContext({ placa: testPlate });
      expect(context).not.toBeNull();
      expect(context?.id_vehiculo).toBe(idVehiculo);
      expect(context?.id_viaje).toBe(idViaje);

      const pointTs = new Date(now.getTime() - 5_000);
      const record: TelemetryRecordToPersist = {
        id_gps: uuidv7(),
        id_viaje: idViaje,
        id_vehiculo: idVehiculo,
        placa: testPlate,
        latitud: 4.8133,
        longitud: -75.6961,
        velocidad_kmh: 38.5,
        rumbo_grados: 112.4,
        precision_hdop: 1.5,
        precision_metros: 7.5,
        odometro_km: 12450.8,
        bateria_respaldo_activa: false,
        fecha_hora: pointTs,
        source: "MQTT",
        receivedAtMs: Date.now(),
      };

      const batch1 = await repo.insertBatch([record]);
      expect(batch1.inserted).toHaveLength(1);
      expect(batch1.duplicateCount).toBe(0);
      expect(batch1.inserted[0].partition_name).toBe(expectedPartition);

      // Re-inserción del mismo (id_vehiculo, fecha_hora) debe deduplicarse
      const batch2 = await repo.insertBatch([{ ...record, id_gps: uuidv7() }]);
      expect(batch2.inserted).toHaveLength(0);
      expect(batch2.duplicateCount).toBe(1);

      const recent = await repo.listRecentByVehicle(idVehiculo, 5);
      expect(recent.length).toBeGreaterThanOrEqual(1);
      expect(recent[0].partition_name).toBe(expectedPartition);
      expect(recent[0].precision_metros).toBeCloseTo(7.5, 1);
      expect(recent[0].odometro_km).toBeCloseTo(12450.8, 1);
    });

    it("rechaza a nivel DDL precision_metros > 30 mediante chk_registro_gps_precision_metros", async () => {
      await expect(
        pool.query(
          `INSERT INTO public.registro_gps (
             id_viaje, id_vehiculo, coordenada, velocidad_kmh, rumbo_grados,
             precision_hdop, precision_metros, odometro_km, fecha_hora
           )
           VALUES (
             $1, $2, ST_SetSRID(ST_MakePoint(-75.6961, 4.8133), 4326)::geography,
             30, 90, 8.0, 45.0, 12500, $3
           )`,
          [idViaje, idVehiculo, new Date().toISOString()],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("purga particiones vencidas (> 180 días) mediante fn_purgar_particiones_gps_vencidas sin tocar el mes actual", async () => {
      const oldMonth = new Date("2024-01-15T00:00:00.000Z");
      const created = await repo.ensureMonthlyPartitions(oldMonth, 0);
      expect(created[0].nombre_particion).toBe("registro_gps_2024_01");

      const purged = await repo.purgeExpiredPartitions(180, new Date());
      expect(purged.map((p) => p.nombre_particion)).toContain(
        "registro_gps_2024_01",
      );

      const check = await pool.query<{ exists: string | null }>(
        `SELECT to_regclass('public.registro_gps_2024_01')::text AS exists`,
      );
      expect(check.rows[0].exists).toBeNull();
    });

    it("prueba de carga real en PostgreSQL 16: inserta 1,000 puntos en lotes sin pérdida", async () => {
      const baseMs = Date.now() - 1_500_000;
      await repo.ensureMonthlyPartitions(new Date(baseMs), 1);

      const records: TelemetryRecordToPersist[] = [];
      for (let i = 0; i < 1000; i += 1) {
        records.push({
          id_gps: uuidv7(),
          id_viaje: idViaje,
          id_vehiculo: idVehiculo,
          placa: testPlate,
          latitud: 4.81 + i * 0.00001,
          longitud: -75.69 - i * 0.00001,
          velocidad_kmh: 30 + (i % 20),
          rumbo_grados: (i * 11) % 360,
          precision_hdop: 1.2,
          precision_metros: 6.0,
          odometro_km: 13000 + i * 0.05,
          bateria_respaldo_activa: false,
          fecha_hora: new Date(baseMs + i * 1_000),
          source: "MQTT",
          receivedAtMs: Date.now(),
        });
      }

      const startMs = Date.now();
      let totalInserted = 0;
      for (let offset = 0; offset < records.length; offset += 200) {
        const res = await repo.insertBatch(records.slice(offset, offset + 200));
        totalInserted += res.inserted.length;
      }
      const elapsedMs = Date.now() - startMs;

      expect(totalInserted).toBe(1000);
      expect(elapsedMs).toBeLessThan(5000);
    });
  },
);
