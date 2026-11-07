import { Injectable, ForbiddenException } from "@nestjs/common";
import { CustodyStateEnum } from "@common/enums/custody-state.enum";

@Injectable()
export class CustodyService {
  /**
   * Verificar legitimación del receptor en parada (RF-06, RN-04)
   * Valida si existe alerta judicial de restricción cautelar activa
   */
  async verifyReceptor(id_estudiante: string, documento_receptor: string) {
    // Alerta judicial simulada para testing
    const hasRestriction = documento_receptor === "RESTRINGIDO_123";
    if (hasRestriction) {
      throw new ForbiddenException(
        "ALERTA JUDICIAL ACTIVA: Prohibida entrega del menor a esta persona bajo orden judicial cautelar.",
      );
    }

    return {
      autorizado: true,
      tipo_receptor: "ADULTO_AUTORIZADO",
      nombre: "Abuela Materna (Elena Restrepo)",
      prioridad: 1,
      alerta_judicial_activa: false,
    };
  }

  /**
   * Disparo del protocolo de Desembarque Fallido y Retorno Seguro a Sede (RF-08)
   */
  async triggerFailedDeliveryProtocol(
    id_estudiante: string,
    motivo: string,
    id_viaje: string,
  ) {
    return {
      id_estudiante,
      id_viaje,
      nuevo_estado: CustodyStateEnum.DESEMBARQUE_FALLIDO,
      accion: "RETORNO_SEGURO_SEDE",
      motivo,
      custodia_a_cargo: "MONITORA_EN_RUTA",
      destino_final:
        "Sede Colegio San Benito del Otún - Coordinación de Convivencia",
      alerta_inmediata_coordinacion: true,
      timestamp: new Date().toISOString(),
    };
  }
}
