import { Injectable, NotFoundException } from '@nestjs/common';

export interface SchoolData {
  id_colegio: string;
  nombre: string;
  nit: string;
  direccion: string;
  telefono: string;
  activo: boolean;
}

@Injectable()
export class SchoolsService {
  private readonly defaultSchool: SchoolData = {
    id_colegio: '018e38d9-3f00-7200-a000-000000000002',
    nombre: 'Colegio San Benito del Otún',
    nit: '900.123.456-7',
    direccion: 'Carrera 7 No. 24-50, Pereira, Risaralda',
    telefono: '+57 (6) 3134567',
    activo: true,
  };

  async getSanBenitoInfo(): Promise<SchoolData> {
    return this.defaultSchool;
  }

  async findById(id: string): Promise<SchoolData> {
    if (id !== this.defaultSchool.id_colegio) {
      throw new NotFoundException(`Institución educativa con id ${id} no encontrada.`);
    }
    return this.defaultSchool;
  }
}
