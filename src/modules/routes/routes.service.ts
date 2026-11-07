import { Injectable, NotFoundException } from "@nestjs/common";

export interface RouteStop {
  id_parada: string;
  secuencia: number;
  nombre: string;
  radio_geocerca_metros: number;
  latitud: number;
  longitud: number;
}

@Injectable()
export class RoutesService {
  async getRouteDetails(id_ruta: string) {
    if (id_ruta === "not-found") {
      throw new NotFoundException(`Ruta ${id_ruta} no encontrada.`);
    }

    return {
      id_ruta,
      codigo: "RUTA-SUR-01",
      nombre: "Ruta Pinares - San Benito",
      srid: 4326,
      tipo_geometria: "LineString",
      paradas: [
        {
          id_parada: "018e38d9-3f00-7200-a000-000000000021",
          secuencia: 1,
          nombre: "Parque Los Álamos",
          radio_geocerca_metros: 100,
          latitud: 4.8133,
          longitud: -75.6961,
        },
        {
          id_parada: "018e38d9-3f00-7200-a000-000000000022",
          secuencia: 2,
          nombre: "Av. Circunvalar Calle 14",
          radio_geocerca_metros: 120,
          latitud: 4.8155,
          longitud: -75.6922,
        },
        {
          id_parada: "018e38d9-3f00-7200-a000-000000000023",
          secuencia: 3,
          nombre: "Patio Colegio San Benito del Otún",
          radio_geocerca_metros: 150,
          latitud: 4.8211,
          longitud: -75.6899,
        },
      ],
    };
  }
}
