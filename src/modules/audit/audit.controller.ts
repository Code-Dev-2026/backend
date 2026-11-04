import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuditService, AuditEventPayload } from './audit.service';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { RoleEnum } from '@common/enums/role.enum';

@ApiTags('Bitácora Forense e Inmutable (Forensic Audit Trail)')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Post('event')
  @HttpCode(HttpStatus.CREATED)
  @Roles(RoleEnum.SUPER_ADMIN, RoleEnum.COORDINADORA_CONVIVENCIA, RoleEnum.RECTORIA)
  @ApiOperation({ summary: 'Registrar evento crítico en el libro mayor inmutable encadenado con SHA-256 (RNF-08)' })
  async logEvent(@Body() payload: AuditEventPayload) {
    return this.auditService.logCriticalEvent(payload);
  }
}
