import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AesEncryptionService } from './aes-encryption.service';
import { BlindIndexService } from './blind-index.service';

describe('Servicios Criptográficos - Camino Seguro (Ley 1581)', () => {
  let aesService: AesEncryptionService;
  let blindIndexService: BlindIndexService;

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: string) => {
      if (key === 'CURRENT_KEY_VERSION') return 'v1';
      if (key === 'APP_ENCRYPTION_MASTER_KEY') return 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      if (key === 'APP_BLIND_INDEX_HMAC_KEY') return 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
      return defaultValue;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AesEncryptionService,
        BlindIndexService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    aesService = module.get<AesEncryptionService>(AesEncryptionService);
    blindIndexService = module.get<BlindIndexService>(BlindIndexService);
  });

  describe('AesEncryptionService (AES-256-GCM)', () => {
    it('debe cifrar y descifrar preservando la integridad del mensaje', () => {
      const plaintext = '1088123456'; // Documento de menor
      const encrypted = aesService.encrypt(plaintext);

      expect(encrypted).toBeDefined();
      // Debe cumplir con el formato: version:iv:tag:ciphertext
      const parts = encrypted.split(':');
      expect(parts.length).toBe(4);
      expect(parts[0]).toBe('v1');

      const decrypted = aesService.decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('debe cumplir con el regex del dominio PostgreSQL formato_cifrado_aes', () => {
      const postgresDomainRegex = /^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;
      const encrypted = aesService.encrypt('Mateo Gómez');
      expect(postgresDomainRegex.test(encrypted)).toBe(true);
    });
  });

  describe('BlindIndexService (HMAC-SHA256)', () => {
    it('debe generar un hash determinista de 64 caracteres en hexadecimal', () => {
      const doc = '1088123456';
      const hash1 = blindIndexService.generateIndex(doc);
      const hash2 = blindIndexService.generateIndex(doc);

      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(hash1)).toBe(true);
    });
  });
});
