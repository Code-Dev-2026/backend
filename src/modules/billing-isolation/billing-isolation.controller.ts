import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { BillingIsolationService } from './billing-isolation.service';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { RoleEnum } from '@common/enums/role.enum';
import { ParseUUIDv7Pipe } from '@common/pipes/parse-uuidv7.pipe';

@ApiTags('Cartera y Facturación Desacoplada (Billing Isolation)')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('billing')
export class BillingIsolationController {
  constructor(private readonly billingService: BillingIsolationService) {}

  @Get('student-status/:id')
  @Roles(RoleEnum.ADMINISTRADOR_CARTERA, RoleEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Consultar estado contable (Inaccesible para monitoras/choferes; jamás bloquea la ruta escolar)',
  })
  async getStatus(@Param('id', ParseUUIDv7Pipe) id: string) {
    return this.billingService.getStudentBillingStatus(id);
  }
}
