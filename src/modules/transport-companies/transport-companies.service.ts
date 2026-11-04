import { Injectable } from '@nestjs/common';

export interface VehicleHomologated {
  id_vehiculo: string;
  placa: string;
  numero_interno: string;
  capacidad_pasajeros: number; // Capacidad nominal estricta (RN-02)
  marca: string;
  modelo: number;
  soat_vigencia: string;
  tecnomecanica_vigencia: string;
  activo: boolean;
}

@Injectable()
export class TransportCompaniesService {
  private readonly defaultCompany = {
    id_empresa: '018e38d9-3f00-7200-a000-000000000003',
    razon_social: 'Transportes Camino Seguro S.A.S.',
    nit: '901.876.543-2',
    telefono: '+57 (6) 3245678',
    email_contacto: 'operaciones@caminoseguro.com.co',
    activo: true,
  };

  private readonly mockFleet: VehicleHomologated[] = [
    {
      id_vehiculo: '018e38d9-3f00-7200-a000-000000000010',
      placa: 'WGA123',
      numero_interno: 'BUS-01',
      capacidad_pasajeros: 24, // Límite nominal no superable
      marca: 'Chevrolet NKR',
      modelo: 2023,
      soat_vigencia: '2027-12-31',
      tecnomecanica_vigencia: '2027-10-15',
      activo: true,
    },
    {
      id_vehiculo: '018e38d9-3f00-7200-a000-000000000011',
      placa: 'TLZ456',
      numero_interno: 'MICRO-02',
      capacidad_pasajeros: 16,
      marca: 'Nissan Urban',
      modelo: 2024,
      soat_vigencia: '2027-08-20',
      tecnomecanica_vigencia: '2027-08-20',
      activo: true,
    },
  ];

  async getCompanyInfo() {
    return this.defaultCompany;
  }

  async getFleet() {
    return this.mockFleet;
  }

  async getVehicleById(id_vehiculo: string): Promise<VehicleHomologated | undefined> {
    return this.mockFleet.find((v) => v.id_vehiculo === id_vehiculo);
  }
}
