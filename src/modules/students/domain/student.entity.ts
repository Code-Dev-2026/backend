import { ICryptoVaultPort } from "@common/ports/crypto-vault.port";
import { uuidv7 } from "@common/utils/uuidv7";

/**
 * Registro persistido del estudiante (tabla `estudiante`, V003 + V011).
 * Los datos personales SOLO existen aquí como texto cifrado AES-256-GCM
 * (key_version:iv:tag:ciphertext). La búsqueda por documento usa
 * `documento_blind_index` (HMAC-SHA256), nunca el documento en claro.
 */
export interface StudentRecord {
  id_estudiante: string;
  id_colegio: string;
  codigo_institucional: string;
  nombre_completo_enc: string;
  documento_identidad_enc: string;
  documento_blind_index: string;
  direccion_enc: string;
  condiciones_medicas_enc: string | null;
  grado: string;
  activo: boolean;
  creado_en: Date;
}

/** Datos en claro que llegan al dar de alta un estudiante. */
export interface NewStudentData {
  id_colegio: string;
  codigo_institucional: string;
  nombre_completo: string;
  documento_identidad: string;
  direccion: string;
  condiciones_medicas?: string | null;
  grado: string;
}

/** Expediente descifrado: solo vive en memoria durante la respuesta. */
export interface StudentExpediente {
  id_estudiante: string;
  id_colegio: string;
  codigo_institucional: string;
  nombre_completo: string;
  documento_identidad: string;
  direccion: string;
  condiciones_medicas: string | null;
  grado: string;
  activo: boolean;
  creado_en: string;
}

/** Vista de listado: sin documento, dirección ni datos médicos. */
export interface StudentSummary {
  id_estudiante: string;
  codigo_institucional: string;
  nombre_completo: string;
  grado: string;
  activo: boolean;
}

/**
 * Normaliza el documento antes de calcular el índice ciego para que
 * "1.088.123.456", "1088 123 456" y "1088123456" coincidan.
 */
export function normalizeDocument(documento: string): string {
  return documento.toUpperCase().replace(/[\s.\-]/g, "");
}

export const Student = {
  /** Cifra los datos personales y calcula el índice ciego. */
  create(data: NewStudentData, vault: ICryptoVaultPort): StudentRecord {
    const documento = normalizeDocument(data.documento_identidad);
    const condiciones = data.condiciones_medicas?.trim();

    return {
      id_estudiante: uuidv7(),
      id_colegio: data.id_colegio,
      codigo_institucional: data.codigo_institucional.trim(),
      nombre_completo_enc: vault.encrypt(data.nombre_completo.trim()),
      documento_identidad_enc: vault.encrypt(documento),
      documento_blind_index: Student.blindIndex(documento, vault),
      direccion_enc: vault.encrypt(data.direccion.trim()),
      condiciones_medicas_enc: condiciones ? vault.encrypt(condiciones) : null,
      grado: data.grado.trim(),
      activo: true,
      creado_en: new Date(),
    };
  },

  blindIndex(documento: string, vault: ICryptoVaultPort): string {
    return vault.generateBlindIndex(normalizeDocument(documento));
  },

  /** Descifra el expediente completo en memoria. */
  toExpediente(
    record: StudentRecord,
    vault: ICryptoVaultPort,
  ): StudentExpediente {
    return {
      id_estudiante: record.id_estudiante,
      id_colegio: record.id_colegio,
      codigo_institucional: record.codigo_institucional,
      nombre_completo: vault.decrypt(record.nombre_completo_enc),
      documento_identidad: vault.decrypt(record.documento_identidad_enc),
      direccion: vault.decrypt(record.direccion_enc),
      condiciones_medicas: record.condiciones_medicas_enc
        ? vault.decrypt(record.condiciones_medicas_enc)
        : null,
      grado: record.grado,
      activo: record.activo,
      creado_en: record.creado_en.toISOString(),
    };
  },

  toSummary(record: StudentRecord, vault: ICryptoVaultPort): StudentSummary {
    return {
      id_estudiante: record.id_estudiante,
      codigo_institucional: record.codigo_institucional,
      nombre_completo: vault.decrypt(record.nombre_completo_enc),
      grado: record.grado,
      activo: record.activo,
    };
  },
};
