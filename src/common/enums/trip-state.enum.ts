/**
 * Estados del Ciclo de Vida del Viaje de Ruta Escolar
 * Cumple con SRS RF-02, RF-03 y Migración V005.
 */
export enum TripStateEnum {
  PROGRAMADO = 'PROGRAMADO',
  EN_CURSO = 'EN_CURSO',
  COMPLETADO = 'COMPLETADO',
  CANCELADO = 'CANCELADO',
  CONTINGENCIA = 'CONTINGENCIA',
}
