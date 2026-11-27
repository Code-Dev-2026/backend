import * as crypto from "crypto";
import { Pool } from "pg";
import { AuthenticatedUser } from "@common/decorators/current-user.decorator";
import { IOfflineOperationHandler } from "../domain/offline-sync.ports";
import { OfflineSyncProcessor } from "../offline-sync.processor";
import {
  PostgresDeviceRegistry,
  PostgresSyncOperationRepository,
} from "./postgres-offline-sync.repositories";

const runPostgres =
  process.env.RUN_POSTGRES_TESTS === "true" ||
  process.env.RUN_POSTGIS_TESTS === "true";
const describeIfPostgres = runPostgres ? describe : describe.skip;

/**
 * Integración real contra PostgreSQL 16 (Issue #16): deduplicación garantizada por
 * `UNIQUE (id_dispositivo, idempotency_key)` en `sync_operation` (V007).
 * Ejecutar con RUN_POSTGRES_TESTS=true tras aplicar V001..V019.
 */
describeIfPostgres(
  "PostgresSyncOperationRepository + PostgresDeviceRegistry (Integración PostgreSQL 16 — Issue #16)",
  () => {
    let pool: Pool;
    let secondPool: Pool;
    let repository: PostgresSyncOperationRepository;
    let devices: PostgresDeviceRegistry;

    const tag = crypto.randomBytes(3).toString("hex").toLowerCase();
    let idUsuario: string;
    let idDispositivo: string;
    let idDispositivoInactivo: string;

    const poolConfig = () => ({
      host: process.env.DB_HOST ?? "localhost",
      port: Number(process.env.DB_PORT ?? 5432),
      database: process.env.DB_NAME ?? "camino_seguro_db",
      user: process.env.DB_USER ?? "app_user",
      password: process.env.DB_PASSWORD ?? "",
    });

    const claimInput = (key: string) => ({
      id_dispositivo: idDispositivo,
      idempotency_key: `${key}-${tag}`,
      entidad_afectada: "registro_de_asistencia",
      payload_json: { tipo: "ABORDAJE", datos: { qr_token: "[REDACTADO]" } },
      capturada_en_offline: new Date(Date.now() - 60_000),
    });

    beforeAll(async () => {
      pool = new Pool(poolConfig());
      secondPool = new Pool(poolConfig());
      repository = new PostgresSyncOperationRepository(pool, false);
      devices = new PostgresDeviceRegistry(pool, false);

      idUsuario = (
        await pool.query<{ id_usuario: string }>(
          `INSERT INTO public.usuario (email, password_hash)
           VALUES ($1, 'hash_test') RETURNING id_usuario`,
          [`monitora-off16-${tag}@test.co`],
        )
      ).rows[0].id_usuario;
      const insertDevice = async (suffix: string, activo: boolean) =>
        (
          await pool.query<{ id_dispositivo: string }>(
            `INSERT INTO public.dispositivo (id_usuario, token_fcm, sistema_operativo, modelo_hardware, activo)
             VALUES ($1, $2, 'ANDROID', 'Tablet monitora', $3) RETURNING id_dispositivo`,
            [idUsuario, `fcm-off16-${tag}-${suffix}`, activo],
          )
        ).rows[0].id_dispositivo;
      idDispositivo = await insertDevice("a", true);
      idDispositivoInactivo = await insertDevice("b", false);
    });

    afterAll(async () => {
      try {
        await pool.query(
          `DELETE FROM public.sync_operation WHERE id_dispositivo = ANY($1::uuid[])`,
          [[idDispositivo, idDispositivoInactivo]],
        );
        await pool.query(
          `DELETE FROM public.dispositivo WHERE id_usuario = $1`,
          [idUsuario],
        );
        await pool.query(`DELETE FROM public.usuario WHERE id_usuario = $1`, [
          idUsuario,
        ]);
      } finally {
        await pool.end();
        await secondPool.end();
      }
    });

    it("reserva la operación en PENDIENTE y devuelve la fila existente al repetir la clave", async () => {
      const first = await repository.claim(claimInput("claim"));
      const second = await repository.claim(claimInput("claim"));

      expect(first.status).toBe("CLAIMED");
      expect(first.operation).toMatchObject({
        estado_sync: "PENDIENTE",
        resultado_json: null,
      });
      expect(second.status).toBe("EXISTING");
      expect(second.operation.id_sync).toBe(first.operation.id_sync);
    });

    it("registra el resultado final y actualiza procesada_en_servidor", async () => {
      const { operation } = await repository.claim(claimInput("complete"));
      const done = await repository.complete(operation.id_sync, "PROCESADO", {
        codigo: "ABORDAJE_EXITOSO",
      });
      expect(done).toMatchObject({
        estado_sync: "PROCESADO",
        resultado_json: { codigo: "ABORDAJE_EXITOSO" },
      });
      expect(done.procesada_en_servidor.getTime()).toBeGreaterThanOrEqual(
        operation.procesada_en_servidor.getTime(),
      );
    });

    it("el UNIQUE de la BD deduplica retransmisiones simultáneas desde dos instancias del backend", async () => {
      const otherInstance = new PostgresSyncOperationRepository(
        secondPool,
        false,
      );
      const results = await Promise.all([
        repository.claim(claimInput("race")),
        otherInstance.claim(claimInput("race")),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([
        "CLAIMED",
        "EXISTING",
      ]);
      const count = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM public.sync_operation
          WHERE id_dispositivo = $1 AND idempotency_key = $2`,
        [idDispositivo, `race-${tag}`],
      );
      expect(count.rows[0].n).toBe("1");
    });

    it("resuelve el dispositivo con su dueño y estado", async () => {
      await expect(devices.findDevice(idDispositivo)).resolves.toEqual({
        id_dispositivo: idDispositivo,
        id_usuario: idUsuario,
        activo: true,
      });
      await expect(
        devices.findDevice(idDispositivoInactivo),
      ).resolves.toMatchObject({ activo: false });
      await expect(devices.findDevice("no-uuid")).resolves.toBeNull();
    });

    it("procesador + PostgreSQL: 5 operaciones enviadas dos veces → 5 filas y 5 ejecuciones", async () => {
      let executions = 0;
      const handler: IOfflineOperationHandler = {
        tipo: "ABORDAJE",
        entidad_afectada: "registro_de_asistencia",
        camposSensibles: ["qr_token"],
        execute: async () => {
          executions += 1;
          return {
            kind: "APPLIED",
            conflicto: false,
            codigo: "ABORDAJE_EXITOSO",
            resultado: {},
          };
        },
      };
      const processor = new OfflineSyncProcessor(repository, devices, [
        handler,
      ]);
      const user: AuthenticatedUser = {
        id_usuario: idUsuario,
        email: "m@test.co",
        roles: ["MONITORA"],
      };
      const batch = {
        id_dispositivo: idDispositivo,
        operaciones: [1, 2, 3, 4, 5].map((n) => ({
          idempotency_key: `accept-${n}-${tag}`,
          tipo: "ABORDAJE" as const,
          fecha_cliente: new Date(Date.now() - (10 - n) * 60_000).toISOString(),
          datos: { qr_token: `QR-${n}` },
        })),
      };

      const first = await processor.processBatch(user, batch);
      const second = await processor.processBatch(user, batch);

      expect(first).toMatchObject({ procesadas: 5, duplicadas: 0 });
      expect(second).toMatchObject({ procesadas: 0, duplicadas: 5 });
      expect(executions).toBe(5);
      const rows = await pool.query<{
        estado_sync: string;
        payload_json: { datos: { qr_token: string } };
      }>(
        `SELECT estado_sync, payload_json FROM public.sync_operation
          WHERE id_dispositivo = $1 AND idempotency_key LIKE 'accept-%'`,
        [idDispositivo],
      );
      expect(rows.rows).toHaveLength(5);
      expect(rows.rows.every((r) => r.estado_sync === "PROCESADO")).toBe(true);
      expect(
        rows.rows.every((r) => r.payload_json.datos.qr_token === "[REDACTADO]"),
      ).toBe(true);
    });
  },
);
