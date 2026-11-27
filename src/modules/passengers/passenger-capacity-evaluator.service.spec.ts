import { TripStateEnum } from "@common/enums/trip-state.enum";
import { OccasionalRejectionReason } from "./domain/occasional-passenger.types";
import {
  MINIMUM_LEAD_TIME_HOURS,
  PassengerCapacityEvaluator,
} from "./passenger-capacity-evaluator.service";

describe("PassengerCapacityEvaluator (SRP — Issue #11)", () => {
  let evaluator: PassengerCapacityEvaluator;

  const tripId = "018e38d9-3f00-7200-a500-000000000001";
  const routeId = "018e38d9-3f00-7200-a500-000000000002";
  const departure0630 = new Date("2026-11-30T06:30:00.000-05:00");

  beforeEach(() => {
    evaluator = new PassengerCapacityEvaluator();
  });

  describe("calculateVacancyBalance", () => {
    it("calcula 1 vacante neta cuando asignados=15, inasistencias=1, ocasionales=0 y capacidad=15", () => {
      const balance = evaluator.calculateVacancyBalance({
        id_viaje: tripId,
        id_ruta: routeId,
        estado_viaje: TripStateEnum.PROGRAMADO,
        hora_inicio_programada: departure0630,
        capacidad_nominal: 15,
        estudiantes_asignados: 15,
        inasistencias_reportadas: 1,
        ocasionales_activos: 0,
      });

      expect(balance.ocupacion_proyectada).toBe(14);
      expect(balance.inasistencias_disponibles).toBe(1);
      expect(balance.cupo_nominal_disponible).toBe(1);
      expect(balance.vacantes_netas).toBe(1);
    });

    it("retorna 0 vacantes netas si existen asientos nominales libres pero 0 inasistencias reportadas (RN-03)", () => {
      const balance = evaluator.calculateVacancyBalance({
        id_viaje: tripId,
        id_ruta: routeId,
        estado_viaje: TripStateEnum.PROGRAMADO,
        hora_inicio_programada: departure0630,
        capacidad_nominal: 15,
        estudiantes_asignados: 10,
        inasistencias_reportadas: 0,
        ocasionales_activos: 0,
      });

      expect(balance.cupo_nominal_disponible).toBe(5);
      expect(balance.inasistencias_disponibles).toBe(0);
      expect(balance.vacantes_netas).toBe(0);
    });

    it("impide sobrecupo cuando (asignados - inasistencias) + ocasionales >= capacidad nominal", () => {
      const balance = evaluator.calculateVacancyBalance({
        id_viaje: tripId,
        id_ruta: routeId,
        estado_viaje: TripStateEnum.PROGRAMADO,
        hora_inicio_programada: departure0630,
        capacidad_nominal: 15,
        estudiantes_asignados: 16,
        inasistencias_reportadas: 1,
        ocasionales_activos: 0,
      });

      expect(balance.ocupacion_proyectada).toBe(15);
      expect(balance.cupo_nominal_disponible).toBe(0);
      expect(balance.inasistencias_disponibles).toBe(1);
      expect(balance.vacantes_netas).toBe(0);
    });

    it("descuenta los pasajeros ocasionales ya radicados o aprobados del balance de vacantes", () => {
      const balance = evaluator.calculateVacancyBalance({
        id_viaje: tripId,
        id_ruta: routeId,
        estado_viaje: TripStateEnum.PROGRAMADO,
        hora_inicio_programada: departure0630,
        capacidad_nominal: 15,
        estudiantes_asignados: 15,
        inasistencias_reportadas: 2,
        ocasionales_activos: 1,
      });

      expect(balance.ocupacion_proyectada).toBe(14);
      expect(balance.inasistencias_disponibles).toBe(1);
      expect(balance.cupo_nominal_disponible).toBe(1);
      expect(balance.vacantes_netas).toBe(1);
    });

    it("lanza RangeError ante contadores inválidos o capacidad <= 0", () => {
      expect(() =>
        evaluator.calculateVacancyBalance({
          id_viaje: tripId,
          id_ruta: routeId,
          estado_viaje: TripStateEnum.PROGRAMADO,
          hora_inicio_programada: departure0630,
          capacidad_nominal: 0,
          estudiantes_asignados: 0,
          inasistencias_reportadas: 0,
          ocasionales_activos: 0,
        }),
      ).toThrow(RangeError);

      expect(() =>
        evaluator.calculateVacancyBalance({
          id_viaje: tripId,
          id_ruta: routeId,
          estado_viaje: TripStateEnum.PROGRAMADO,
          hora_inicio_programada: departure0630,
          capacidad_nominal: 15,
          estudiantes_asignados: -1,
          inasistencias_reportadas: 0,
          ocasionales_activos: 0,
        }),
      ).toThrow(RangeError);
    });
  });

  describe("evaluateLeadTime", () => {
    it("acepta exactamente 2 horas de antelación (04:30:00 para salida 06:30:00)", () => {
      const result = evaluator.evaluateLeadTime(
        departure0630,
        new Date("2026-11-30T04:30:00.000-05:00"),
      );

      expect(result.cumple_antelacion).toBe(true);
      expect(result.horas_antelacion).toBe(MINIMUM_LEAD_TIME_HOURS);
      expect(result.minutos_antelacion).toBe(120);
    });

    it("rechaza 1 hora 59 minutos 59 segundos de antelación (04:30:01 para salida 06:30:00)", () => {
      const result = evaluator.evaluateLeadTime(
        departure0630,
        new Date("2026-11-30T04:30:01.000-05:00"),
      );

      expect(result.cumple_antelacion).toBe(false);
      expect(result.horas_antelacion).toBeLessThan(MINIMUM_LEAD_TIME_HOURS);
    });

    it("rechaza solicitud a las 05:00 AM para salida 06:30 AM (1.5 horas)", () => {
      const result = evaluator.evaluateLeadTime(
        departure0630,
        new Date("2026-11-30T05:00:00.000-05:00"),
      );

      expect(result.cumple_antelacion).toBe(false);
      expect(result.minutos_antelacion).toBe(90);
      expect(result.horas_antelacion).toBe(1.5);
    });
  });

  describe("evaluateBookingEligibility (Criterio de Aceptación #11)", () => {
    it("reporta simultáneamente ANTELACION_INSUFICIENTE y SIN_VACANTE_POR_INASISTENCIA para 05:00 AM sin inasistencias (salida 06:30 AM)", () => {
      const balance = evaluator.calculateVacancyBalance({
        id_viaje: tripId,
        id_ruta: routeId,
        estado_viaje: TripStateEnum.PROGRAMADO,
        hora_inicio_programada: departure0630,
        capacidad_nominal: 15,
        estudiantes_asignados: 15,
        inasistencias_reportadas: 0,
        ocasionales_activos: 0,
      });

      const evaluation = evaluator.evaluateBookingEligibility({
        balance,
        solicitadoEn: new Date("2026-11-30T05:00:00.000-05:00"),
        hasUnallocatedAbsence: false,
      });

      expect(evaluation.elegible).toBe(false);
      expect(evaluation.motivos_rechazo).toContain(
        OccasionalRejectionReason.ANTELACION_INSUFICIENTE,
      );
      expect(evaluation.motivos_rechazo).toContain(
        OccasionalRejectionReason.SIN_VACANTE_POR_INASISTENCIA,
      );
      expect(evaluation.motivos_rechazo).toContain(
        OccasionalRejectionReason.CAPACIDAD_NOMINAL_AGOTADA,
      );
    });
  });
});
