import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  SAN_BENITO_CENTER,
  SAN_BENITO_GEOFENCE_CODE,
  SAN_BENITO_SCHOOL_ID,
} from "./domain/geo.types";
import { AssignmentCycle, RouteShift, ZoneType } from "./domain/route.entity";
import { GeoZonesService } from "./geo-zones.service";
import { InMemoryGeoRepository } from "./infrastructure/in-memory-geo.repository";
import { RouteAssignmentService } from "./route-assignment.service";
import { RoutesService } from "./routes.service";

describe("Módulo Geoespacial (Issue #6: Rutas, Paradas GiST, Geocercas y Asignaciones)", () => {
  let repo: InMemoryGeoRepository;
  let routesService: RoutesService;
  let assignmentService: RouteAssignmentService;
  let geoZonesService: GeoZonesService;

  const idColegio = SAN_BENITO_SCHOOL_ID;
  const idEmpresa = "018e38d9-3f00-7200-a000-000000000003";
  const idEstudiante = "018e38d9-3f00-7200-a000-0000000000a1";

  const polilineaPereira = {
    type: "LineString" as const,
    coordinates: [
      [-75.6961, 4.8133] as [number, number], // Parque Los Álamos
      [-75.6922, 4.8155] as [number, number], // Av. Circunvalar Calle 14
      [-75.6946, 4.8143] as [number, number], // Colegio San Benito del Otún
    ],
  };

  beforeEach(() => {
    repo = new InMemoryGeoRepository();
    routesService = new RoutesService(repo);
    assignmentService = new RouteAssignmentService(repo, repo);
    geoZonesService = new GeoZonesService(repo, repo);
  });

  describe("RoutesService (IRouteDefinitionService - ISP)", () => {
    it("crea una ruta escolar con LineString GeoJSON y retorna paradas en orden secuencial", async () => {
      const ruta = await routesService.createRoute({
        id_colegio: idColegio,
        id_empresa: idEmpresa,
        codigo: "R-01",
        nombre: "Ruta Pinares - San Benito",
        jornada: RouteShift.MANANA,
        polilinea_oficial: polilineaPereira,
        origen_nombre: "Parque Los Álamos",
        destino_nombre: "Colegio San Benito del Otún",
      });

      // Se insertan fuera de orden para validar ordenamiento secuencial
      await routesService.addStop(ruta.id_ruta, {
        nombre: "Patio Colegio San Benito del Otún",
        orden_secuencia: 2,
        punto_geografico: {
          type: "Point",
          coordinates: [SAN_BENITO_CENTER.longitud, SAN_BENITO_CENTER.latitud],
        },
        horario_estimado: "06:45:00",
        radio_metros: 150,
      });

      await routesService.addStop(ruta.id_ruta, {
        nombre: "Parque Los Álamos",
        orden_secuencia: 1,
        punto_geografico: {
          type: "Point",
          coordinates: [-75.6961, 4.8133],
        },
        horario_estimado: "06:25:00",
        radio_metros: 100,
      });

      const details = await routesService.getRouteDetails(ruta.id_ruta);
      expect(details.codigo).toBe("R-01");
      expect(details.srid).toBe(4326);
      expect(details.polilinea_oficial.type).toBe("LineString");
      expect(details.paradas).toHaveLength(2);
      expect(details.paradas.map((p) => p.orden_secuencia)).toEqual([1, 2]);
      expect(details.paradas[0].radio_geocerca.type).toBe("Polygon");
    });

    it("rechaza códigos de ruta duplicados con ConflictException", async () => {
      await routesService.createRoute({
        id_colegio: idColegio,
        id_empresa: idEmpresa,
        codigo: "R-01",
        nombre: "Ruta 1",
        jornada: RouteShift.MANANA,
        polilinea_oficial: polilineaPereira,
        origen_nombre: "Origen",
        destino_nombre: "Destino",
      });

      await expect(
        routesService.createRoute({
          id_colegio: idColegio,
          id_empresa: idEmpresa,
          codigo: "R-01",
          nombre: "Ruta Duplicada",
          jornada: RouteShift.TARDE,
          polilinea_oficial: polilineaPereira,
          origen_nombre: "Origen",
          destino_nombre: "Destino",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("rechaza orden_secuencia duplicado dentro de la misma ruta", async () => {
      const ruta = await routesService.createRoute({
        id_colegio: idColegio,
        id_empresa: idEmpresa,
        codigo: "R-01",
        nombre: "Ruta 1",
        jornada: RouteShift.MANANA,
        polilinea_oficial: polilineaPereira,
        origen_nombre: "Origen",
        destino_nombre: "Destino",
      });

      await routesService.addStop(ruta.id_ruta, {
        nombre: "Parada 1",
        orden_secuencia: 1,
        punto_geografico: { type: "Point", coordinates: [-75.6961, 4.8133] },
        horario_estimado: "06:30:00",
      });

      await expect(
        routesService.addStop(ruta.id_ruta, {
          nombre: "Parada Duplicada",
          orden_secuencia: 1,
          punto_geografico: { type: "Point", coordinates: [-75.6922, 4.8155] },
          horario_estimado: "06:35:00",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("rechaza coordenadas fuera de rango WGS84 (OWASP ASVS V5.1)", async () => {
      await expect(
        routesService.createRoute({
          id_colegio: idColegio,
          id_empresa: idEmpresa,
          codigo: "R-BAD",
          nombre: "Ruta Inválida",
          jornada: RouteShift.MANANA,
          polilinea_oficial: {
            type: "LineString",
            coordinates: [
              [-200, 4.8133],
              [-75.6946, 95],
            ],
          },
          origen_nombre: "Origen",
          destino_nombre: "Destino",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("arroja NotFoundException al consultar ruta inexistente", async () => {
      await expect(
        routesService.getRouteDetails("018e38d9-3f00-7200-a000-000000000999"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("RouteAssignmentService (FK compuesta (id_ruta, id_parada) - Criterio de Aceptación #6)", () => {
    it("permite asignar estudiante cuando ambas paradas pertenecen a la ruta R-01", async () => {
      const ruta1 = await routesService.createRoute({
        id_colegio: idColegio,
        id_empresa: idEmpresa,
        codigo: "R-01",
        nombre: "Ruta R-01",
        jornada: RouteShift.MANANA,
        polilinea_oficial: polilineaPereira,
        origen_nombre: "Álamos",
        destino_nombre: "San Benito",
      });

      const paradaSubida = await routesService.addStop(ruta1.id_ruta, {
        nombre: "Parque Los Álamos",
        orden_secuencia: 1,
        punto_geografico: { type: "Point", coordinates: [-75.6961, 4.8133] },
        horario_estimado: "06:25:00",
      });

      const paradaBajada = await routesService.addStop(ruta1.id_ruta, {
        nombre: "Sede San Benito",
        orden_secuencia: 2,
        punto_geografico: {
          type: "Point",
          coordinates: [SAN_BENITO_CENTER.longitud, SAN_BENITO_CENTER.latitud],
        },
        horario_estimado: "06:45:00",
      });

      const assignment = await assignmentService.assignStudentToRoute({
        id_estudiante: idEstudiante,
        id_ruta: ruta1.id_ruta,
        id_parada_subida: paradaSubida.id_parada,
        id_parada_bajada: paradaBajada.id_parada,
        ciclo_horario: AssignmentCycle.AMBOS,
      });

      expect(assignment.id_ruta).toBe(ruta1.id_ruta);
      expect(assignment.id_parada_subida).toBe(paradaSubida.id_parada);
      expect(assignment.activa).toBe(true);
    });

    it("rechaza asociar una parada de subida de R-02 a un estudiante asignado a R-01 (violación FK compuesta)", async () => {
      const ruta1 = await routesService.createRoute({
        id_colegio: idColegio,
        id_empresa: idEmpresa,
        codigo: "R-01",
        nombre: "Ruta R-01",
        jornada: RouteShift.MANANA,
        polilinea_oficial: polilineaPereira,
        origen_nombre: "Álamos",
        destino_nombre: "San Benito",
      });
      const ruta2 = await routesService.createRoute({
        id_colegio: idColegio,
        id_empresa: idEmpresa,
        codigo: "R-02",
        nombre: "Ruta R-02",
        jornada: RouteShift.MANANA,
        polilinea_oficial: polilineaPereira,
        origen_nombre: "Cerritos",
        destino_nombre: "San Benito",
      });

      const paradaR1 = await routesService.addStop(ruta1.id_ruta, {
        nombre: "Parada R-01",
        orden_secuencia: 1,
        punto_geografico: { type: "Point", coordinates: [-75.6961, 4.8133] },
        horario_estimado: "06:25:00",
      });
      const paradaR2 = await routesService.addStop(ruta2.id_ruta, {
        nombre: "Parada R-02",
        orden_secuencia: 1,
        punto_geografico: { type: "Point", coordinates: [-75.7395, 4.8127] },
        horario_estimado: "06:15:00",
      });

      await expect(
        assignmentService.assignStudentToRoute({
          id_estudiante: idEstudiante,
          id_ruta: ruta1.id_ruta,
          id_parada_subida: paradaR2.id_parada,
          id_parada_bajada: paradaR1.id_parada,
          ciclo_horario: AssignmentCycle.IDA,
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it("rechaza doble asignación activa del mismo estudiante en la misma franja", async () => {
      const ruta1 = await routesService.createRoute({
        id_colegio: idColegio,
        id_empresa: idEmpresa,
        codigo: "R-01",
        nombre: "Ruta R-01",
        jornada: RouteShift.MANANA,
        polilinea_oficial: polilineaPereira,
        origen_nombre: "Álamos",
        destino_nombre: "San Benito",
      });
      const parada = await routesService.addStop(ruta1.id_ruta, {
        nombre: "Parada única",
        orden_secuencia: 1,
        punto_geografico: { type: "Point", coordinates: [-75.6961, 4.8133] },
        horario_estimado: "06:25:00",
      });

      await assignmentService.assignStudentToRoute({
        id_estudiante: idEstudiante,
        id_ruta: ruta1.id_ruta,
        id_parada_subida: parada.id_parada,
        id_parada_bajada: parada.id_parada,
        ciclo_horario: AssignmentCycle.IDA,
      });

      await expect(
        assignmentService.assignStudentToRoute({
          id_estudiante: idEstudiante,
          id_ruta: ruta1.id_ruta,
          id_parada_subida: parada.id_parada,
          id_parada_bajada: parada.id_parada,
          ciclo_horario: AssignmentCycle.IDA,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("GeoZonesService (IGeoProximityQueries - Geocercas y Proximidad Pereira)", () => {
    it("expone la geocerca institucional del Colegio San Benito del Otún y evalúa contención", async () => {
      const schoolZone = await geoZonesService.getSanBenitoSchoolGeofence();
      expect(schoolZone.codigo).toBe(SAN_BENITO_GEOFENCE_CODE);
      expect(schoolZone.tipo_zona).toBe(ZoneType.GEOCERCA_ESCOLAR);

      const inside = await geoZonesService.checkPointInSchoolGeofence(
        SAN_BENITO_CENTER.latitud,
        SAN_BENITO_CENTER.longitud,
      );
      expect(inside.dentro).toBe(true);

      // Aeropuerto Matecaña (~5 km al occidente de San Benito)
      const outside = await geoZonesService.checkPointInSchoolGeofence(
        4.8127,
        -75.7395,
      );
      expect(outside.dentro).toBe(false);
    });

    it("calcula distancias geodésicas y encuentra paradas cercanas en Pereira", async () => {
      const ruta = await routesService.createRoute({
        id_colegio: idColegio,
        id_empresa: idEmpresa,
        codigo: "R-PER-01",
        nombre: "Ruta Centro Pereira",
        jornada: RouteShift.COMPLETA,
        polilinea_oficial: polilineaPereira,
        origen_nombre: "Parque Los Álamos",
        destino_nombre: "San Benito",
      });

      const paradaCercana = await routesService.addStop(ruta.id_ruta, {
        nombre: "Sede San Benito",
        orden_secuencia: 1,
        punto_geografico: {
          type: "Point",
          coordinates: [SAN_BENITO_CENTER.longitud, SAN_BENITO_CENTER.latitud],
        },
        horario_estimado: "06:30:00",
        radio_metros: 120,
      });

      await routesService.addStop(ruta.id_ruta, {
        nombre: "Aeropuerto Matecaña",
        orden_secuencia: 2,
        punto_geografico: { type: "Point", coordinates: [-75.7395, 4.8127] },
        horario_estimado: "07:00:00",
        radio_metros: 120,
      });

      // Distancia entre Parque Los Álamos y Colegio San Benito (~200 m)
      const dist = await geoZonesService.calculateDistanceMeters(
        4.8133,
        -75.6961,
        SAN_BENITO_CENTER.latitud,
        SAN_BENITO_CENTER.longitud,
      );
      expect(dist.distancia_metros).toBeGreaterThan(150);
      expect(dist.distancia_metros).toBeLessThan(250);

      // Búsqueda dentro de 400m desde Parque Los Álamos: solo debe hallar San Benito
      const nearby = await geoZonesService.findNearbyStops(
        4.8133,
        -75.6961,
        400,
      );
      expect(nearby).toHaveLength(1);
      expect(nearby[0].id_parada).toBe(paradaCercana.id_parada);

      // Verificación de contención en geocerca de la parada
      const stopCheck = await geoZonesService.checkPointInStopGeofence(
        paradaCercana.id_parada,
        SAN_BENITO_CENTER.latitud,
        SAN_BENITO_CENTER.longitud,
      );
      expect(stopCheck.dentro).toBe(true);
      expect(stopCheck.distancia_metros).toBe(0);
    });

    it("rechaza coordenadas fuera de rango WGS84 (OWASP ASVS V5.1)", async () => {
      await expect(
        geoZonesService.findNearbyStops(91, -75.6946, 500),
      ).rejects.toThrow(BadRequestException);
      await expect(
        geoZonesService.calculateDistanceMeters(4.81, -181, 4.81, -75.69),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
