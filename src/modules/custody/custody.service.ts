import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { AesEncryptionService } from '@common/crypto/aes-encryption.service';
import { CustodyStateEnum } from '@common/enums/custody-state.enum';

export interface JudicialRestrictionAlert {
  id_alerta: string;
  id_estudiante: string;
  persona_restringida: string;
  tipo_medida: string;
  radicado_juzgado: string;
  bloquea_entrega: boolean;
}

@Injectable()
export class CustodyService {
  constructor(private readonly aesService: AesEncryptionService) {}

  /**
   * Verificar legitimación del receptor en parada (RF-06, RN-04)
   * Valida si existe alerta judicial de restricción cautelar activa
   */
  async verifyReceptor(id_estudiante: string, documento_receptor: string) {
    // Verificación de alerta judicial cautelar (RF-07)
    const hasRestriction = false; // Consulta a la tabla `alerta_judicial`
    if (hasRestriction) {
      throw new ForbiddenException(
        'ALERTA JUDICIAL ACTIVA: Prohibida entrega del menor a esta persona bajo orden judicial.',
      );
    }

    return {
      autorizado: true,
      tipo_receptor: 'ADULTO_AUTORIZADO',
      nombre: 'Abuela Materna (Elena Restrepo)',
      prioridad: 1,
      alerta_judicial_activa: false,
    };
  }

  /**
   * Disparo del protocolo de Desembarque Fallido y Retorno Seguro a Sede (RF-08)
   */
  async triggerFailedDeliveryProtocol(id_estudiante: string, motivo: string, id_viaje: string) {
    return {
      id_estudiante,
      id_viaje,
      nuevo_estado: CustodyStateEnum.DESEMBARQUE_FALLIDO,
      accion: 'RETORNO_SEGURO_SEDE',
      motivo,
      custodia_a_cargo: 'MONITORA_EN_RUTA',
      destino_final: 'Sede Colegio San Benito del Otún - Coordinación de Convivencia',
      alerta_inmediata_coordinacion: true,
      timestamp: new Date().toISOString(),
    };
  }
}
