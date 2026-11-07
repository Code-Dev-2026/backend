import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { CustodyService } from './custody.service';
import { CustodyStateEnum } from '@common/enums/custody-state.enum';

describe('CustodyService (Sprint 2)', () => {
  let service: CustodyService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CustodyService],
    }).compile();

    service = module.get<CustodyService>(CustodyService);
  });

  it('debe estar definido el servicio de custodia', () => {
    expect(service).toBeDefined();
  });

  it('debe validar un receptor autorizado sin alertas judiciales', async () => {
    const result = await service.verifyReceptor('est-1', '1088123456');
    expect(result.autorizado).toBe(true);
    expect(result.alerta_judicial_activa).toBe(false);
  });

  it('debe arrojar ForbiddenException si hay alerta judicial activa (RF-07)', async () => {
    await expect(
      service.verifyReceptor('est-1', 'RESTRINGIDO_123'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('debe activar protocolo de desembarque fallido y retorno seguro (RF-08)', async () => {
    const result = await service.triggerFailedDeliveryProtocol(
      'est-1',
      'Receptor ausente en paradero',
      'trip-1',
    );

    expect(result.nuevo_estado).toBe(CustodyStateEnum.DESEMBARQUE_FALLIDO);
    expect(result.accion).toBe('RETORNO_SEGURO_SEDE');
    expect(result.alerta_inmediata_coordinacion).toBe(true);
  });
});
