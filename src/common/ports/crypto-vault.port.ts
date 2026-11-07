/**
 * Puerto de Dominio: Criptovault de Datos Sensibles (Ley 1581 / ADR-002)
 */
export interface ICryptoVaultPort {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
  generateBlindIndex(plaintext: string): string;
}
