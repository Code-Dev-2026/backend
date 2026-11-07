import { Injectable } from "@nestjs/common";

@Injectable()
export class BillingIsolationService {
  /**
   * Consulta el estado financiero de un acudiente (Estrictamente desacoplado de la operación escolar)
   * REGLA RN-05: Esta información jamás debe condicionar la prestación del servicio de ruta al estudiante.
   */
  async getStudentBillingStatus(id_estudiante: string) {
    return {
      id_estudiante,
      estado_cuenta: "AL_DIA",
      saldo_pendiente: 0,
      bloquea_servicio_ruta: false, // Invariante de negocio: NUNCA se bloquea la ruta por mora (RN-05)
      mensaje_aislamiento:
        "Operación desacoplada según esquema billing independiente.",
    };
  }
}
