import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { CustodyStateEnum } from "@common/enums/custody-state.enum";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import { CustodyService } from "./custody.service";
import { CustodyTransitionValidatorService } from "./custody-transition-validator.service";
import { CUSTODY_REPOSITORY } from "./domain/custody-repository.port";
import {
  CUSTODY_GENESIS_HASH,
  FsmCustodyState,
  TripDirection,
  WormImmutabilityViolationError,
} from "./domain/custody.types";
import { InMemoryCustodyRepository } from "./infrastructure/in-memory-custody.repository";
import { MorningCustodyInitJob } from "./morning-custody-init.job";

describe("CustodyService (Sprint 2 - Issue #7 FSM, WORM y Job Matutino)", () => {
  let service: CustodyService;
  let repository: InMemoryCustodyRepository;
  let morningJob: MorningCustodyInitJob;

  const tripMorningId = "018e38d9-3f00-7200-a000-000000000101";
  const tripAfternoonId = "018e38d9-3f00-7200-a000-000000000102";
  const studentId = "018e38d9-3f00-7200-a000-000000000201";
  const student2Id = "018e38d9-3f00-7200-a000-000000000202";
  const monitoraId = "018e38d9-3f00-7200-a000-000000000301";
  const routeMorningId = "018e38d9-3f00-7200-a000-000000000401";
  const routeAfternoonId = "018e38d9-3f00-7200-a000-000000000402";

  beforeEach(async () => {
    repository = new InMemoryCustodyRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: CUSTODY_REPOSITORY, useValue: repository },
        CustodyTransitionValidatorService,
        MorningCustodyInitJob,
        CustodyService,
      ],
    }).compile();

    service = module.get<CustodyService>(CustodyService);
    morningJob = module.get<MorningCustodyInitJob>(MorningCustodyInitJob);
  });

  // --------------------------------------------------------------------------
  // Pruebas heredadas de compatibilidad (Sprint 2)
  // --------------------------------------------------------------------------

  it("debe estar definido el servicio de custodia", () => {
    expect(service).toBeDefined();
  });

  it("debe validar un receptor autorizado sin alertas judiciales", async () => {
    const result = await service.verifyReceptor("est-1", "1088123456");
    expect(result.autorizado).toBe(true);
    expect(result.alerta_judicial_activa).toBe(false);
  });

  it("debe arrojar ForbiddenException si hay alerta judicial activa (RF-07)", async () => {
    await expect(
      service.verifyReceptor("est-1", "RESTRINGIDO_123"),
    ).rejects.toThrow(ForbiddenException);
  });

  it("debe activar protocolo de desembarque fallido y retorno seguro (RF-08)", async () => {
    const result = await service.triggerFailedDeliveryProtocol(
      "est-1",
      "Receptor ausente en paradero",
      "trip-1",
    );

    expect(result.nuevo_estado).toBe(CustodyStateEnum.DESEMBARQUE_FALLIDO);
    expect(result.accion).toBe("RETORNO_SEGURO_SEDE");
    expect(result.alerta_inmediata_coordinacion).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Issue #7: Criterio de Aceptación, FSM, WORM SHA-256, Cierre y Job Matutino
  // --------------------------------------------------------------------------

  it("Criterio de Aceptación #7: desde NO_INICIADO rechaza salto directo a ENTREGADO_ACUDIENTE sin alterar BD ni historial WORM", async () => {
    await service.enrollStudentInTrip(tripAfternoonId, studentId);

    await expect(
      service.executeTransition({
        id_viaje: tripAfternoonId,
        id_estudiante: studentId,
        estado_destino: FsmCustodyState.ENTREGADO_ACUDIENTE,
        tipo_recorrido: TripDirection.TARDE,
        registrado_por_usuario: monitoraId,
      }),
    ).rejects.toThrow(UnprocessableEntityException);

    // Verificar invariante: el estado en viaje_estudiante NO fue alterado
    const current = await service.getStudentTripCustody(
      tripAfternoonId,
      studentId,
    );
    expect(current.estado_custodia).toBe(FsmCustodyState.NO_INICIADO);
    expect(current.hora_abordaje).toBeNull();
    expect(current.hora_desembarque).toBeNull();

    // Verificar invariante: historial_estado_custodia NO registró ningún evento
    const history = await service.getTripCustodyHistory(tripAfternoonId);
    expect(history).toHaveLength(0);
  });

  it("ejecuta el ciclo matutino completo y encadena hashes SHA-256 WORM íntegros", async () => {
    await service.enrollStudentInTrip(tripMorningId, studentId);

    const step1 = await service.executeTransition({
      id_viaje: tripMorningId,
      id_estudiante: studentId,
      estado_destino: FsmCustodyState.EN_ESPERA_ABORDAJE,
      tipo_recorrido: TripDirection.MANANA,
      disparador_evento: "APROXIMACION_PARADA_1",
      registrado_por_usuario: monitoraId,
      latitud: 4.8133,
      longitud: -75.6961,
    });
    expect(step1.custody.estado_custodia).toBe(
      FsmCustodyState.EN_ESPERA_ABORDAJE,
    );
    expect(step1.history.secuencia).toBe(1);
    expect(step1.history.hash_sha256_anterior).toBe(CUSTODY_GENESIS_HASH);
    expect(step1.history.hash_sha256_actual).toMatch(/^[a-f0-9]{64}$/);

    const step2 = await service.executeTransition({
      id_viaje: tripMorningId,
      id_estudiante: studentId,
      estado_destino: FsmCustodyState.A_BORDO_VEHICULO,
      tipo_recorrido: TripDirection.MANANA,
      disparador_evento: "ABORDAJE_QR",
      registrado_por_usuario: monitoraId,
    });
    expect(step2.custody.estado_custodia).toBe(FsmCustodyState.A_BORDO_VEHICULO);
    expect(step2.custody.hora_abordaje).toBeInstanceOf(Date);
    expect(step2.history.secuencia).toBe(2);
    expect(step2.history.hash_sha256_anterior).toBe(
      step1.history.hash_sha256_actual,
    );

    // En mañana NO se permite ENTREGADO_ACUDIENTE
    await expect(
      service.executeTransition({
        id_viaje: tripMorningId,
        id_estudiante: studentId,
        estado_destino: FsmCustodyState.ENTREGADO_ACUDIENTE,
        tipo_recorrido: TripDirection.MANANA,
      }),
    ).rejects.toThrow(UnprocessableEntityException);

    const step3 = await service.executeTransition({
      id_viaje: tripMorningId,
      id_estudiante: studentId,
      estado_destino: FsmCustodyState.EN_COLEGIO,
      tipo_recorrido: TripDirection.MANANA,
      disparador_evento: "LLEGADA_SEDE_SAN_BENITO",
      registrado_por_usuario: monitoraId,
      latitud: 4.8143,
      longitud: -75.6946,
    });
    expect(step3.custody.estado_custodia).toBe(FsmCustodyState.EN_COLEGIO);
    expect(step3.custody.hora_desembarque).toBeInstanceOf(Date);
    expect(step3.history.secuencia).toBe(3);
    expect(step3.history.hash_sha256_anterior).toBe(
      step2.history.hash_sha256_actual,
    );

    const report = await service.verifyWormChainIntegrity();
    expect(report.total_verificados).toBe(3);
    expect(report.cadena_integra).toBe(true);
    expect(report.secuencia_fallo).toBeNull();
  });

  it("permite re-asignación del mismo estudiante en ruta matutina y vespertina sin conflicto (viaje_estudiante) y flujo de contingencia RETORNO_SEDE_POR_FALLA_ENTREGA", async () => {
    // Mañana: entrega en colegio
    await service.enrollStudentInTrip(tripMorningId, studentId);
    await service.executeTransition({
      id_viaje: tripMorningId,
      id_estudiante: studentId,
      estado_destino: FsmCustodyState.EN_ESPERA_ABORDAJE,
      tipo_recorrido: TripDirection.MANANA,
    });
    await service.executeTransition({
      id_viaje: tripMorningId,
      id_estudiante: studentId,
      estado_destino: FsmCustodyState.A_BORDO_VEHICULO,
      tipo_recorrido: TripDirection.MANANA,
    });
    await service.executeTransition({
      id_viaje: tripMorningId,
      id_estudiante: studentId,
      estado_destino: FsmCustodyState.EN_COLEGIO,
      tipo_recorrido: TripDirection.MANANA,
    });

    // Tarde: mismo estudiante en viaje independiente -> contingencia -> retorno a sede
    await service.enrollStudentInTrip(tripAfternoonId, studentId);
    await service.executeTransition({
      id_viaje: tripAfternoonId,
      id_estudiante: studentId,
      estado_destino: FsmCustodyState.EN_ESPERA_ABORDAJE,
      tipo_recorrido: TripDirection.TARDE,
    });
    await service.executeTransition({
      id_viaje: tripAfternoonId,
      id_estudiante: studentId,
      estado_destino: FsmCustodyState.A_BORDO_VEHICULO,
      tipo_recorrido: TripDirection.TARDE,
    });

    // En tarde NO se permite ir directo A_BORDO_VEHICULO -> EN_COLEGIO sin contingencia
    await expect(
      service.executeTransition({
        id_viaje: tripAfternoonId,
        id_estudiante: studentId,
        estado_destino: FsmCustodyState.EN_COLEGIO,
        tipo_recorrido: TripDirection.TARDE,
      }),
    ).rejects.toThrow(UnprocessableEntityException);

    const fallback = await service.executeTransition({
      id_viaje: tripAfternoonId,
      id_estudiante: studentId,
      estado_destino: FsmCustodyState.RETORNO_SEDE_POR_FALLA_ENTREGA,
      tipo_recorrido: TripDirection.TARDE,
      disparador_evento: "ACUDIENTE_AUSENTE_PARADA",
    });
    expect(fallback.custody.estado_custodia).toBe(
      FsmCustodyState.RETORNO_SEDE_POR_FALLA_ENTREGA,
    );
    expect(fallback.custody.hora_desembarque).toBeNull();

    const returned = await service.executeTransition({
      id_viaje: tripAfternoonId,
      id_estudiante: studentId,
      estado_destino: FsmCustodyState.EN_COLEGIO,
      tipo_recorrido: TripDirection.TARDE,
      disparador_evento: "RECEPCION_SEDE_COORDINACION",
    });
    expect(returned.custody.estado_custodia).toBe(FsmCustodyState.EN_COLEGIO);
    expect(returned.custody.hora_desembarque).toBeInstanceOf(Date);

    // Ambos viajes conservan estados independientes y cadena íntegra
    const morningState = await service.getStudentTripCustody(
      tripMorningId,
      studentId,
    );
    expect(morningState.estado_custodia).toBe(FsmCustodyState.EN_COLEGIO);
    const history = await service.getStudentCustodyHistory(studentId);
    expect(history).toHaveLength(7);

    const integrity = await service.verifyWormChainIntegrity();
    expect(integrity.cadena_integra).toBe(true);
    expect(integrity.total_verificados).toBe(7);
  });

  it("bloquea el cierre del viaje (FINALIZADO) mientras existan menores A_BORDO_VEHICULO y lo permite tras desembarque", async () => {
    await repository.registerTrip({
      id_viaje: tripMorningId,
      id_ruta: routeMorningId,
      fecha: "2026-11-23",
      tipo_recorrido: TripDirection.MANANA,
      estado: TripStateEnum.EN_CURSO,
    });

    await service.enrollStudentInTrip(tripMorningId, studentId);
    await service.executeTransition({
      id_viaje: tripMorningId,
      id_estudiante: studentId,
      estado_destino: FsmCustodyState.EN_ESPERA_ABORDAJE,
      tipo_recorrido: TripDirection.MANANA,
    });
    await service.executeTransition({
      id_viaje: tripMorningId,
      id_estudiante: studentId,
      estado_destino: FsmCustodyState.A_BORDO_VEHICULO,
      tipo_recorrido: TripDirection.MANANA,
    });

    await expect(service.finalizeTrip(tripMorningId)).rejects.toThrow(
      ConflictException,
    );

    await service.executeTransition({
      id_viaje: tripMorningId,
      id_estudiante: studentId,
      estado_destino: FsmCustodyState.EN_COLEGIO,
      tipo_recorrido: TripDirection.MANANA,
    });

    const finalized = await service.finalizeTrip(tripMorningId);
    expect(finalized.estado).toBe(TripStateEnum.FINALIZADO);
    expect(finalized.hora_fin_real).toBeInstanceOf(Date);
  });

  it("job de inicialización matutina inicializa estudiantes contratados a NO_INICIADO de forma idempotente y sin sobreescribir avances", async () => {
    const fecha = "2026-11-23";
    await repository.registerTrip({
      id_viaje: tripMorningId,
      id_ruta: routeMorningId,
      fecha,
      tipo_recorrido: TripDirection.MANANA,
      estado: TripStateEnum.PROGRAMADO,
    });
    await repository.registerTrip({
      id_viaje: tripAfternoonId,
      id_ruta: routeAfternoonId,
      fecha,
      tipo_recorrido: TripDirection.TARDE,
      estado: TripStateEnum.PROGRAMADO,
    });

    repository.registerRouteContract({
      id_ruta: routeMorningId,
      id_estudiante: studentId,
      ciclo_horario: "IDA",
      activo: true,
    });
    repository.registerRouteContract({
      id_ruta: routeMorningId,
      id_estudiante: student2Id,
      ciclo_horario: "AMBOS",
      activo: false, // contrato inactivo -> no debe inicializarse
    });
    repository.registerRouteContract({
      id_ruta: routeAfternoonId,
      id_estudiante: studentId,
      ciclo_horario: "AMBOS",
      activo: true,
    });

    // Antes de la hora configurada (05:00) el tick no ejecuta
    const beforeSchedule = await morningJob.tick(new Date(2026, 10, 23, 4, 30));
    expect(beforeSchedule).toBeNull();

    // A las 05:00 ejecuta una sola vez
    const atSchedule = await morningJob.tick(new Date(2026, 10, 23, 5, 0));
    expect(atSchedule).not.toBeNull();
    expect(atSchedule?.registros_inicializados).toBe(2);
    expect(morningJob.getLastExecutedDate()).toBe(fecha);

    // Segundo tick el mismo día no re-ejecuta
    const secondTickSameDay = await morningJob.tick(
      new Date(2026, 10, 23, 5, 15),
    );
    expect(secondTickSameDay).toBeNull();

    // Avanzar estado de studentId en mañana y volver a correr manualmente -> idempotente
    await service.executeTransition({
      id_viaje: tripMorningId,
      id_estudiante: studentId,
      estado_destino: FsmCustodyState.EN_ESPERA_ABORDAJE,
      tipo_recorrido: TripDirection.MANANA,
    });

    const manualRerun = await service.runMorningInitialization(fecha);
    expect(manualRerun.registros_inicializados).toBe(0);

    const stateAfterRerun = await service.getStudentTripCustody(
      tripMorningId,
      studentId,
    );
    expect(stateAfterRerun.estado_custodia).toBe(
      FsmCustodyState.EN_ESPERA_ABORDAJE,
    );
  });

  it("valida casos negativos: estudiante no matriculado (404), coordenadas inválidas (400), puerto ICustodyFsmPort y bloqueo WORM", async () => {
    await expect(
      service.executeTransition({
        id_viaje: tripMorningId,
        id_estudiante: studentId,
        estado_destino: FsmCustodyState.EN_ESPERA_ABORDAJE,
        tipo_recorrido: TripDirection.MANANA,
      }),
    ).rejects.toThrow(NotFoundException);

    await service.enrollStudentInTrip(tripMorningId, studentId);

    // Coordenadas incompletas (solo latitud)
    await expect(
      service.executeTransition({
        id_viaje: tripMorningId,
        id_estudiante: studentId,
        estado_destino: FsmCustodyState.EN_ESPERA_ABORDAJE,
        tipo_recorrido: TripDirection.MANANA,
        latitud: 4.8143,
      }),
    ).rejects.toThrow(BadRequestException);

    // Coordenadas fuera de rango WGS84
    await expect(
      service.executeTransition({
        id_viaje: tripMorningId,
        id_estudiante: studentId,
        estado_destino: FsmCustodyState.EN_ESPERA_ABORDAJE,
        tipo_recorrido: TripDirection.MANANA,
        latitud: 95,
        longitud: -75.6946,
      }),
    ).rejects.toThrow(BadRequestException);

    // Puerto ICustodyFsmPort
    expect(
      service.canTransition(
        CustodyStateEnum.NO_INICIADO,
        CustodyStateEnum.EN_ESPERA_ABORDAJE,
        "MANANA",
      ),
    ).toBe(true);
    expect(
      service.canTransition(
        CustodyStateEnum.NO_INICIADO,
        CustodyStateEnum.ENTREGADO_ACUDIENTE,
        "TARDE",
      ),
    ).toBe(false);

    const portResult = await service.transition({
      id_viaje: tripMorningId,
      id_estudiante: studentId,
      estado_origen: CustodyStateEnum.NO_INICIADO,
      estado_destino: CustodyStateEnum.EN_ESPERA_ABORDAJE,
      id_monitora: monitoraId,
      tipo_recorrido: "MANANA",
    });
    expect(portResult).toEqual({
      success: true,
      newState: CustodyStateEnum.EN_ESPERA_ABORDAJE,
    });

    // Intento de mutación WORM rechazado
    expect(() => repository.attemptMutateHistory()).toThrow(
      WormImmutabilityViolationError,
    );
  });
});
