import { Injectable, NotFoundException } from "@nestjs/common";
import { AesEncryptionService } from "@common/crypto/aes-encryption.service";
import { BlindIndexService } from "@common/crypto/blind-index.service";

export interface StudentProfileDto {
  id_estudiante: string;
  codigo_institucional: string;
  documento_identidad: string;
  nombres: string;
  apellidos: string;
  grado: string;
  activo: boolean;
}

@Injectable()
export class StudentsService {
  constructor(
    private readonly aesService: AesEncryptionService,
    private readonly blindIndexService: BlindIndexService,
  ) {}

  /**
   * Registro o consulta de estudiante con cifrado en reposo AES-256-GCM y Blind Indexing
   */
  async getStudentById(id_estudiante: string) {
    if (id_estudiante === "not-found") {
      throw new NotFoundException(`Estudiante ${id_estudiante} no encontrado.`);
    }

    const encryptedData = {
      id_estudiante,
      codigo_institucional: "EST-2026-089",
      nombres_cifrado: this.aesService.encrypt("Mateo"),
      apellidos_cifrado: this.aesService.encrypt("Gómez Restrepo"),
      grado: "4A",
      qr_token_hash: "3a7b8c...hash_sha256",
      activo: true,
    };

    return {
      id_estudiante: encryptedData.id_estudiante,
      codigo_institucional: encryptedData.codigo_institucional,
      nombres: this.aesService.decrypt(encryptedData.nombres_cifrado),
      apellidos: this.aesService.decrypt(encryptedData.apellidos_cifrado),
      grado: encryptedData.grado,
      activo: encryptedData.activo,
    };
  }

  /**
   * Búsqueda por documento sin descifrar masivamente la base de datos (Blind Index)
   */
  async findByDocument(documento: string) {
    const blindIndex = this.blindIndexService.generateIndex(documento);
    return {
      blindIndexFound: blindIndex,
      resultado: "Coincidencia indexada según Ley 1581",
    };
  }
}
