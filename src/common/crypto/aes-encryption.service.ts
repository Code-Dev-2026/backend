import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * Servicio de Cifrado Atómico AES-256-GCM
 * Formato unificado en reposo: key_version:iv_b64:tag_b64:ciphertext_b64
 * Cumple con Ley 1581 (Habeas Data Menores) y el dominio formato_cifrado_aes de PostgreSQL (Migración V001).
 */
@Injectable()
export class AesEncryptionService {
  private readonly algorithm = 'aes-256-gcm';
  private readonly keyVersion: string;
  private readonly masterKey: Buffer;

  constructor(private readonly configService: ConfigService) {
    this.keyVersion = this.configService.get<string>('CURRENT_KEY_VERSION', 'v1');
    const masterKeyBase64 = this.configService.get<string>('APP_ENCRYPTION_MASTER_KEY');

    if (!masterKeyBase64) {
      throw new InternalServerErrorException('APP_ENCRYPTION_MASTER_KEY no está configurada.');
    }

    const keyBuffer = Buffer.from(masterKeyBase64, 'base64');
    if (keyBuffer.length !== 32) {
      // Ajuste si la clave provista de prueba no tiene exactamente 32 bytes
      this.masterKey = crypto.createHash('sha256').update(keyBuffer).digest();
    } else {
      this.masterKey = keyBuffer;
    }
  }

  /**
   * Cifra un texto plano y produce el formato: key_version:iv:tag:ciphertext
   */
  encrypt(plaintext: string): string {
    if (!plaintext) {
      return '';
    }

    try {
      const iv = crypto.randomBytes(12); // 96 bits recomendado para GCM
      const cipher = crypto.createCipheriv(this.algorithm, this.masterKey, iv);

      let encrypted = cipher.update(plaintext, 'utf8', 'base64');
      encrypted += cipher.final('base64');
      const tag = cipher.getAuthTag().toString('base64');

      return `${this.keyVersion}:${iv.toString('base64')}:${tag}:${encrypted}`;
    } catch (error) {
      throw new InternalServerErrorException(`Fallo en el proceso de cifrado: ${(error as Error).message}`);
    }
  }

  /**
   * Descifra un string con formato key_version:iv:tag:ciphertext
   */
  decrypt(formattedCiphertext: string): string {
    if (!formattedCiphertext) {
      return '';
    }

    const parts = formattedCiphertext.split(':');
    if (parts.length !== 4) {
      throw new InternalServerErrorException('Formato de texto cifrado no válido. Se esperaba version:iv:tag:ciphertext');
    }

    const [version, ivBase64, tagBase64, ciphertextBase64] = parts;

    try {
      const iv = Buffer.from(ivBase64, 'base64');
      const tag = Buffer.from(tagBase64, 'base64');
      const decipher = crypto.createDecipheriv(this.algorithm, this.masterKey, iv);
      decipher.setAuthTag(tag);

      let decrypted = decipher.update(ciphertextBase64, 'base64', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      throw new InternalServerErrorException(`Fallo en el proceso de descifrado o verificación de integridad: ${(error as Error).message}`);
    }
  }
}
