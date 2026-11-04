import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * Servicio de Indexación Ciega (Blind Indexing)
 * Emplea HMAC-SHA256 con clave secreta independiente para permitir búsquedas
 * exactas de documentos de identidad sin descifrar la base de datos ni vulnerar la Ley 1581.
 */
@Injectable()
export class BlindIndexService {
  private readonly hmacKey: Buffer;

  constructor(private readonly configService: ConfigService) {
    const rawHmacKey = this.configService.get<string>('APP_BLIND_INDEX_HMAC_KEY');
    if (!rawHmacKey) {
      throw new InternalServerErrorException('APP_BLIND_INDEX_HMAC_KEY no está configurada.');
    }

    const keyBuffer = Buffer.from(rawHmacKey, 'base64');
    if (keyBuffer.length !== 32) {
      this.hmacKey = crypto.createHash('sha256').update(keyBuffer).digest();
    } else {
      this.hmacKey = keyBuffer;
    }
  }

  /**
   * Genera el hash de búsqueda indexable (64 caracteres hexadecimales)
   */
  generateIndex(plaintextValue: string): string {
    if (!plaintextValue) {
      return '';
    }

    // Normalización: sin espacios, todo en mayúsculas para consistencia de búsqueda
    const normalized = plaintextValue.trim().toUpperCase();
    return crypto.createHmac('sha256', this.hmacKey).update(normalized).digest('hex');
  }
}
