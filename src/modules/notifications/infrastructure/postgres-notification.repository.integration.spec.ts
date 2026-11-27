import * as crypto from "crypto";
import { Pool } from "pg";
import { NotificationChannelRegistry } from "../notification-channel.registry";
import { NotificationDispatcherService } from "../notification-dispatcher.service";
import { DispatchNotificationCommand } from "../domain/notification-dispatch.types";
import { PostgresNotificationRecipientDirectory } from "./notification-recipient.directory";
import { PostgresNotificationRepository } from "./postgres-notification.repository";

const runPostgres =
  process.env.RUN_POSTGRES_TESTS === "true" ||
  process.env.RUN_POSTGIS_TESTS === "true";
const describeIfPostgres = runPostgres ? describe : describe.skip;

/**
 * Integración real contra PostgreSQL 16 (Issue #15): persistencia transaccional en
 * `notificacion` clasificada por `tipo_notificacion` (V007).
 * Ejecutar con RUN_POSTGRES_TESTS=true tras aplicar V001..V019.
 */
describeIfPostgres(
  "PostgresNotificationRepository + directorio (Integración PostgreSQL 16 — Issue #15)",
  () => {
    let pool: Pool;
    let repository: PostgresNotificationRepository;
    let directory: PostgresNotificationRecipientDirectory;

    const tag = crypto.randomBytes(3).toString("hex").toUpperCase();
    const aesDummy = `v1:${"a".repeat(24)}:${"b".repeat(32)}:${"c".repeat(16)}`;
    const sha256 = (v: string) =>
      crypto.createHash("sha256").update(v, "utf8").digest("hex");

    let idColegio: string;
    let idEstudiante: string;
    const users: string[] = [];
    const guardians: Record<
      "titular" | "secundario" | "bloqueado" | "ajeno",
      string
    > = {
      titular: "",
      secundario: "",
      bloqueado: "",
      ajeno: "",
    };

    const insertGuardian = async (
      key: keyof typeof guardians,
      estado: string,
    ) => {
      const u = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash, estado)
         VALUES ($1, 'hash_test', $2) RETURNING id_usuario`,
        [`nt15-${key}-${tag.toLowerCase()}@test.co`, estado],
      );
      users.push(u.rows[0].id_usuario);
      const a = await pool.query<{ id_acudiente: string }>(
        `INSERT INTO public.acudiente (
           id_usuario, nombres, apellidos, documento_cifrado, documento_blind_index,
           telefono_principal_cifrado, telefono_emergencia_cifrado, direccion_cifrada
         )
         VALUES ($1, 'Acudiente', $2, $3, $4, $3, $3, $3) RETURNING id_acudiente`,
        [u.rows[0].id_usuario, key, aesDummy, sha256(`nt15-${key}-${tag}`)],
      );
      guardians[key] = a.rows[0].id_acudiente;
    };

    const link = (idAcudiente: string, principal: boolean, orden: number) =>
      pool.query(
        `INSERT INTO public.estudiante_acudiente (
           id_estudiante, id_acudiente, parentesco, es_tutor_principal, orden_notificacion
         )
         VALUES ($1, $2, 'MADRE', $3, $4)`,
        [idEstudiante, idAcudiente, principal, orden],
      );

    const command = (
      key: string,
      overrides: Partial<DispatchNotificationCommand> = {},
    ): DispatchNotificationCommand => ({
      idempotency_key: `${key}-${tag}`,
      codigo_tipo: "ABORDAJE_EXITOSO",
      id_acudiente: guardians.titular,
      id_estudiante: idEstudiante,
      id_viaje: null,
      titulo: "Abordaje confirmado",
      mensaje: "El estudiante ha subido al vehículo escolar.",
      payload: { estado_custodia: "A_BORDO_VEHICULO" },
      ocurrido_en: new Date(),
      ...overrides,
    });

    beforeAll(async () => {
      pool = new Pool({
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? 5432),
        database: process.env.DB_NAME ?? "camino_seguro_db",
        user: process.env.DB_USER ?? "app_user",
        password: process.env.DB_PASSWORD ?? "",
      });
      repository = new PostgresNotificationRepository(pool, false);
      directory = new PostgresNotificationRecipientDirectory(pool, false);

      idColegio = (
        await pool.query<{ id_colegio: string }>(
          `INSERT INTO public.colegio (nombre, nit, direccion, telefono)
           VALUES ($1, $2, 'Pereira', '3000000000') RETURNING id_colegio`,
          [`Colegio NT15 ${tag}`, `900-NT15-${tag}`],
        )
      ).rows[0].id_colegio;
      idEstudiante = (
        await pool.query<{ id_estudiante: string }>(
          `INSERT INTO public.estudiante (
             id_colegio, codigo_institucional, documento_cifrado, documento_blind_index,
             nombres_cifrado, apellidos_cifrado, fecha_nacimiento_cifrada, grado,
             qr_token_hash, domicilio_punto
           )
           VALUES ($1, $2, $3, $4, $3, $3, $3, '5A', $5,
                   ST_SetSRID(ST_MakePoint(-75.6961, 4.8133), 4326)::geography)
           RETURNING id_estudiante`,
          [
            idColegio,
            `EST-NT15-${tag}`,
            aesDummy,
            sha256(`doc-nt15-${tag}`),
            sha256(`qr-nt15-${tag}`),
          ],
        )
      ).rows[0].id_estudiante;

      await insertGuardian("titular", "ACTIVO");
      await insertGuardian("secundario", "ACTIVO");
      await insertGuardian("bloqueado", "BLOQUEADO");
      await insertGuardian("ajeno", "ACTIVO");
      await link(guardians.secundario, false, 2);
      await link(guardians.titular, true, 1);
      await link(guardians.bloqueado, false, 3);
    });

    afterAll(async () => {
      try {
        await pool.query(
          `DELETE FROM public.notificacion WHERE id_estudiante = $1`,
          [idEstudiante],
        );
        await pool.query(
          `DELETE FROM public.estudiante_acudiente WHERE id_estudiante = $1`,
          [idEstudiante],
        );
        await pool.query(
          `DELETE FROM public.estudiante WHERE id_estudiante = $1`,
          [idEstudiante],
        );
        await pool.query(
          `DELETE FROM public.acudiente WHERE id_acudiente = ANY($1::uuid[])`,
          [Object.values(guardians)],
        );
        await pool.query(
          `DELETE FROM public.usuario WHERE id_usuario = ANY($1::uuid[])`,
          [users],
        );
        await pool.query(`DELETE FROM public.colegio WHERE id_colegio = $1`, [
          idColegio,
        ]);
      } finally {
        await pool.end();
      }
    });

    it("inserta la fila PENDIENTE clasificada por tipo_notificacion y su canal por defecto", async () => {
      const result = await repository.upsertPending(
        command("incidente", {
          codigo_tipo: "INCIDENTE_ENTREGA",
          titulo: "Alerta crítica",
        }),
      );
      expect(result.created).toBe(true);
      expect(result.notification).toMatchObject({
        codigo_tipo: "INCIDENTE_ENTREGA",
        canal: "SMS",
        estado_envio: "PENDIENTE",
        intentos_realizados: 0,
        max_intentos: 3,
        payload_adicional: { estado_custodia: "A_BORDO_VEHICULO" },
      });
    });

    it("es idempotente por idempotency_key: reutiliza la fila existente", async () => {
      const first = await repository.upsertPending(command("idem"));
      const second = await repository.upsertPending(
        command("idem", {
          id_notificacion: "018e38d9-3f00-7200-a000-00000000ffff",
        }),
      );
      expect(second.created).toBe(false);
      expect(second.notification.id_notificacion).toBe(
        first.notification.id_notificacion,
      );
      const count = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM public.notificacion WHERE idempotency_key = $1`,
        [`idem-${tag}`],
      );
      expect(count.rows[0].n).toBe("1");
    });

    it("registra intentos y marca despachada_en / entregada_en", async () => {
      const { notification } = await repository.upsertPending(
        command("attempts"),
      );
      const retry = await repository.recordAttempt(
        notification.id_notificacion,
        {
          estado_envio: "REINTENTO",
          ultimo_error: "ws:NO_RECIPIENT",
        },
      );
      expect(retry).toMatchObject({
        estado_envio: "REINTENTO",
        intentos_realizados: 1,
        despachada_en: null,
      });
      const done = await repository.recordAttempt(
        notification.id_notificacion,
        {
          estado_envio: "ENTREGADA",
          ultimo_error: null,
        },
      );
      expect(done.intentos_realizados).toBe(2);
      expect(done.despachada_en).toBeInstanceOf(Date);
      expect(done.entregada_en).toBeInstanceOf(Date);
    });

    it("la BD impide notificar a un acudiente sin vínculo con el menor (FK estudiante_acudiente)", async () => {
      await expect(
        repository.upsertPending(
          command("ajeno", { id_acudiente: guardians.ajeno }),
        ),
      ).rejects.toThrow(/fk_notif_estudiante_acudiente/);
    });

    it("el directorio devuelve los acudientes ACTIVO en orden de notificación", async () => {
      await expect(
        directory.listGuardianIdsOfStudent(idEstudiante),
      ).resolves.toEqual([guardians.titular, guardians.secundario]);
      await expect(
        directory.listGuardianIdsOfStudent("no-uuid"),
      ).resolves.toEqual([]);
    });

    it("despachador + repositorio PostgreSQL: ENTREGADA con un canal que confirma", async () => {
      const registry = new NotificationChannelRegistry();
      registry.register({
        name: "ws",
        deliver: async () => ({ channel: "ws", status: "DELIVERED" }),
      });
      const dispatcher = new NotificationDispatcherService(
        repository,
        registry,
      );

      const outcome = await dispatcher.enqueue(command("dispatch"));
      expect(outcome).toMatchObject({ status: "ENTREGADA", intentos: 1 });
      const row = await repository.findById(outcome.id_notificacion!);
      expect(row?.estado_envio).toBe("ENTREGADA");
    });
  },
);
