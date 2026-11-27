import * as crypto from "crypto";
import { Pool } from "pg";
import { PostgresGuardianLinkRepository } from "./postgres-guardian-link.repository";

const runPostgres =
  process.env.RUN_POSTGRES_TESTS === "true" ||
  process.env.RUN_POSTGIS_TESTS === "true";
const describeIfPostgres = runPostgres ? describe : describe.skip;

/**
 * Pruebas de integración reales contra PostgreSQL 16 (Issue #14 — RNF-02).
 * Ejecutar con RUN_POSTGRES_TESTS=true tras aplicar V001..V019.
 *
 * Verifica la resolución `usuario` ⋈ `acudiente` ⋈ `estudiante_acudiente` que
 * determina el parentesco del socket con los estudiantes del viaje.
 */
describeIfPostgres(
  "PostgresGuardianLinkRepository (Integración PostgreSQL 16 — Issue #14)",
  () => {
    let pool: Pool;
    let repository: PostgresGuardianLinkRepository;

    const tag = crypto.randomBytes(3).toString("hex").toUpperCase();
    const aesDummy = `v1:${"a".repeat(24)}:${"b".repeat(32)}:${"c".repeat(16)}`;
    const sha256 = (value: string) =>
      crypto.createHash("sha256").update(value, "utf8").digest("hex");

    let idColegio: string;
    const userIds: Record<"activo" | "inactivo" | "otro", string> = {
      activo: "",
      inactivo: "",
      otro: "",
    };
    const acudienteIds: Record<"activo" | "inactivo" | "otro", string> = {
      activo: "",
      inactivo: "",
      otro: "",
    };
    let idEstudiante1: string;
    let idEstudiante2: string;

    const insertGuardian = async (
      key: "activo" | "inactivo" | "otro",
      estado: string,
    ) => {
      const user = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash, estado)
         VALUES ($1, 'hash_test', $2) RETURNING id_usuario`,
        [`acu-${key}-rt14-${tag.toLowerCase()}@test.co`, estado],
      );
      userIds[key] = user.rows[0].id_usuario;
      const acud = await pool.query<{ id_acudiente: string }>(
        `INSERT INTO public.acudiente (
           id_usuario, nombres, apellidos, documento_cifrado, documento_blind_index,
           telefono_principal_cifrado, telefono_emergencia_cifrado, direccion_cifrada
         )
         VALUES ($1, 'Acudiente', $2, $3, $4, $3, $3, $3)
         RETURNING id_acudiente`,
        [userIds[key], key, aesDummy, sha256(`acu-rt14-${key}-${tag}`)],
      );
      acudienteIds[key] = acud.rows[0].id_acudiente;
    };

    const insertStudent = async (suffix: string) =>
      (
        await pool.query<{ id_estudiante: string }>(
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
          [
            idColegio,
            `EST-RT14-${tag}-${suffix}`,
            aesDummy,
            sha256(`doc-est-rt14-${tag}-${suffix}`),
            sha256(`qr-rt14-${tag}-${suffix}`),
          ],
        )
      ).rows[0].id_estudiante;

    const link = (idEstudiante: string, idAcudiente: string) =>
      pool.query(
        `INSERT INTO public.estudiante_acudiente (
           id_estudiante, id_acudiente, parentesco, es_tutor_principal, orden_notificacion
         )
         VALUES ($1, $2, 'MADRE', TRUE, 1)`,
        [idEstudiante, idAcudiente],
      );

    beforeAll(async () => {
      pool = new Pool({
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? 5432),
        database: process.env.DB_NAME ?? "camino_seguro_db",
        user: process.env.DB_USER ?? "app_user",
        password: process.env.DB_PASSWORD ?? "",
      });
      repository = new PostgresGuardianLinkRepository(pool, false);

      idColegio = (
        await pool.query<{ id_colegio: string }>(
          `INSERT INTO public.colegio (nombre, nit, direccion, telefono)
           VALUES ($1, $2, 'Pereira', '3000000000') RETURNING id_colegio`,
          [`Colegio RT14 ${tag}`, `900-RT14-${tag}`],
        )
      ).rows[0].id_colegio;

      await insertGuardian("activo", "ACTIVO");
      await insertGuardian("inactivo", "BLOQUEADO");
      await insertGuardian("otro", "ACTIVO");
      idEstudiante1 = await insertStudent("1");
      idEstudiante2 = await insertStudent("2");

      await link(idEstudiante1, acudienteIds.activo);
      await link(idEstudiante1, acudienteIds.inactivo);
      await link(idEstudiante2, acudienteIds.otro);
    });

    afterAll(async () => {
      try {
        await pool.query(
          `DELETE FROM public.estudiante_acudiente WHERE id_estudiante = ANY($1::uuid[])`,
          [[idEstudiante1, idEstudiante2]],
        );
        await pool.query(
          `DELETE FROM public.estudiante WHERE id_estudiante = ANY($1::uuid[])`,
          [[idEstudiante1, idEstudiante2]],
        );
        await pool.query(
          `DELETE FROM public.acudiente WHERE id_acudiente = ANY($1::uuid[])`,
          [Object.values(acudienteIds)],
        );
        await pool.query(
          `DELETE FROM public.usuario WHERE id_usuario = ANY($1::uuid[])`,
          [Object.values(userIds)],
        );
        await pool.query(`DELETE FROM public.colegio WHERE id_colegio = $1`, [
          idColegio,
        ]);
      } finally {
        await pool.end();
      }
    });

    it("resuelve el id_usuario del JWT de cada acudiente ACTIVO vinculado al estudiante", async () => {
      const links = await repository.listGuardianLinksForStudents([
        idEstudiante1,
      ]);
      expect(links).toEqual([
        {
          id_usuario: userIds.activo,
          id_acudiente: acudienteIds.activo,
          id_estudiante: idEstudiante1,
        },
      ]);
    });

    it("excluye cuentas no ACTIVO y no mezcla familias de otros estudiantes", async () => {
      const links = await repository.listGuardianLinksForStudents([
        idEstudiante1,
        idEstudiante2,
      ]);
      const users = links.map((l) => l.id_usuario).sort();
      expect(users).toEqual([userIds.activo, userIds.otro].sort());
      expect(users).not.toContain(userIds.inactivo);
      expect(
        links.find((l) => l.id_usuario === userIds.otro)?.id_estudiante,
      ).toBe(idEstudiante2);
    });

    it("ignora identificadores no UUID y listas vacías sin consultar la BD", async () => {
      await expect(
        repository.listGuardianLinksForStudents([]),
      ).resolves.toEqual([]);
      await expect(
        repository.listGuardianLinksForStudents(["1; DROP TABLE acudiente"]),
      ).resolves.toEqual([]);
    });
  },
);
