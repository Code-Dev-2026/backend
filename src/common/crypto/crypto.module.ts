import { Module, Global } from "@nestjs/common";
import { AesEncryptionService } from "./aes-encryption.service";
import { BlindIndexService } from "./blind-index.service";
import { HashService } from "./hash.service";

@Global()
@Module({
  providers: [AesEncryptionService, BlindIndexService, HashService],
  exports: [AesEncryptionService, BlindIndexService, HashService],
})
export class CryptoModule {}
