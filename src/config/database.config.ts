import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleAsyncOptions, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSource, DataSourceOptions } from 'typeorm';

export const getDatabaseConfig = (configService: ConfigService): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: configService.get<string>('DB_HOST', 'localhost'),
  port: configService.get<number>('DB_PORT', 5432),
  database: configService.get<string>('DB_NAME', 'camino_seguro_db'),
  username: configService.get<string>('DB_USER', 'app_user'),
  password: configService.get<string>('DB_PASSWORD', 'dev_app_user_password_2026'),
  ssl: configService.get<boolean>('DB_SSL', false) ? { rejectUnauthorized: false } : false,
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],
  synchronize: false, // REGLA ESTRICTA: Las migraciones manuales V001-V010 mandan
  logging: configService.get<string>('NODE_ENV') === 'development' ? ['error', 'warn', 'migration'] : ['error'],
  extra: {
    min: configService.get<number>('DB_POOL_MIN', 5),
    max: configService.get<number>('DB_POOL_MAX', 25),
    connectionTimeoutMillis: configService.get<number>('DB_CONNECTION_TIMEOUT_MS', 5000),
  },
});

export const typeOrmAsyncConfig: TypeOrmModuleAsyncOptions = {
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => getDatabaseConfig(configService),
};

// Data source para ejecución de scripts TypeORM CLI en tiempo de desarrollo
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'camino_seguro_db',
  username: process.env.DB_OWNER_USER || process.env.DB_USER || 'app_owner',
  password: process.env.DB_OWNER_PASSWORD || process.env.DB_PASSWORD || 'dev_owner_password_san_benito_2026',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/../../db/migrations/*.sql'],
  synchronize: false,
} as DataSourceOptions);
