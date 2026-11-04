import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from '@common/filters/all-exceptions.filter';
import { LoggingInterceptor } from '@common/interceptors/logging.interceptor';
import { TransformInterceptor } from '@common/interceptors/transform.interceptor';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);
  const apiPrefix = configService.get<string>('API_PREFIX', 'api/v1');
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');

  // 1. Seguridad HTTP con Helmet
  app.use(
    helmet({
      contentSecurityPolicy: nodeEnv === 'development' ? false : undefined,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // 2. CORS Seguro
  const allowedOriginsString = configService.get<string>(
    'CORS_ALLOWED_ORIGINS',
    'http://localhost:3000,http://localhost:5173',
  );
  const allowedOrigins = allowedOriginsString.split(',').map((origin) => origin.trim());

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || nodeEnv === 'development') {
        callback(null, true);
      } else {
        callback(new Error(`Origen ${origin} no permitido por política CORS.`));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id', 'X-Idempotency-Key'],
  });

  // 3. Prefijo Global de Rutas
  app.setGlobalPrefix(apiPrefix);

  // 4. Pipes de Validación Globales (Sanitización y Rechazo de Campos no Permitidos)
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // 5. Filtro Global de Excepciones
  app.useGlobalFilters(new AllExceptionsFilter());

  // 6. Interceptores Globales (Logging Estructurado y Envoltorio Estándar de Respuesta)
  app.useGlobalInterceptors(new LoggingInterceptor(), new TransformInterceptor());

  // 7. Documentación OpenAPI / Swagger
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Camino Seguro - Core Backend API')
    .setDescription(
      'Sistema de Control Operativo y Seguridad para Rutas Escolares del Colegio San Benito del Otún / Transportes Camino Seguro S.A.S.\n\n' +
        'Arquitectura Limpia Hexagonal, Cifrado AES-256-GCM (Ley 1581 Habeas Data Menores), PostGIS 3.4 y Monitoreo en Tiempo Real.',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Ingrese el Access Token JWT generado en /auth/login',
        in: 'header',
      },
      'JWT',
    )
    .addTag('Autenticación y Sesiones (Auth & RBAC)')
    .addTag('Colegios e Instituciones (Schools)')
    .addTag('Empresas de Transporte y Flota Homologada (Transport Companies)')
    .addTag('Estudiantes y Bóveda Cifrada (Students & Habeas Data)')
    .addTag('Custodia, Adultos Autorizados y Restricciones Judiciales (Custody)')
    .addTag('Rutas Viales y Georreferenciación PostGIS (Routes & Geospatial)')
    .addTag('Despacho y Ciclo de Vida de Viajes (Trips)')
    .addTag('Asistencia, Abordaje QR y Control de Aforo (Attendance & Capacity)')
    .addTag('Telemetría GPS y Sincronización Offline (Telemetry & Sync)')
    .addTag('Motor Transaccional de Notificaciones Push (Notifications)')
    .addTag('Cartera y Facturación Desacoplada (Billing Isolation)')
    .addTag('Bitácora Forense e Inmutable (Forensic Audit Trail)')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'none',
      filter: true,
    },
  });

  await app.listen(port);
  logger.log(`🚀 Camino Seguro Backend iniciado en el puerto ${port} [Ambiente: ${nodeEnv}]`);
  logger.log(`📚 Documentación Swagger activa en: http://localhost:${port}/${apiPrefix}/docs`);
}

void bootstrap();
