import { Module, Global } from "@nestjs/common";
import { AesEncryptionService } from "./aes-encryption.service";
import { BlindIndexService } from "./blind-index.service";
import { CryptoVaultService } from "./crypto-vault.service";
import { HashService } from "./hash.service";

@Global()
@Module({
  providers: [
    AesEncryptionService,
    BlindIndexService,
    HashService,
    CryptoVaultService,
  ],
  exports: [
    AesEncryptionService,
    BlindIndexService,
    HashService,
    CryptoVaultService,
  ],
})
export class CryptoModule {}
