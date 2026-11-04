import { Module } from '@nestjs/common';
import { CustodyService } from './custody.service';
import { CustodyController } from './custody.controller';

@Module({
  controllers: [CustodyController],
  providers: [CustodyService],
  exports: [CustodyService],
})
export class CustodyModule {}
