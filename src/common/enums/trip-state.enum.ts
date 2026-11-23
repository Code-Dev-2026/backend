/**
 * Estados del Ciclo de Vida del Viaje de Ruta Escolar
 * Cumple con SRS RF-02, RF-03, RF-07 y Migraciones V005 / V014.
 */
export enum TripStateEnum {
  PROGRAMADO = "PROGRAMADO",
  EN_CURSO = "EN_CURSO",
  FINALIZADO = "FINALIZADO",
  COMPLETADO = "COMPLETADO",
  CANCELADO = "CANCELADO",
  CONTINGENCIA = "CONTINGENCIA",
}
