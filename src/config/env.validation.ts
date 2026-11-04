import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  // Runtime
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().default(3000),
  API_PREFIX: Joi.string().default('api/v1'),
  CORS_ALLOWED_ORIGINS: Joi.string().default('http://localhost:3000,http://localhost:5173'),

  // Database PostgreSQL 16 + PostGIS
  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().default(5432),
  DB_NAME: Joi.string().required(),
  DB_USER: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_OWNER_USER: Joi.string().optional(),
  DB_OWNER_PASSWORD: Joi.string().optional(),
  DB_SSL: Joi.boolean().default(false),
  DB_POOL_MIN: Joi.number().default(5),
  DB_POOL_MAX: Joi.number().default(25),
  DB_CONNECTION_TIMEOUT_MS: Joi.number().default(5000),

  // Redis & BullMQ
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').default(''),
  REDIS_DB: Joi.number().default(0),

  // Cryptography (Ley 1581 - Habeas Data Menores)
  CURRENT_KEY_VERSION: Joi.string().default('v1'),
  APP_ENCRYPTION_MASTER_KEY: Joi.string().required().description('Base64 32-byte AES key'),
  APP_BLIND_INDEX_HMAC_KEY: Joi.string().required().description('Base64 32-byte HMAC key'),

  // JWT & MFA
  JWT_ACCESS_SECRET: Joi.string().required().min(32),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().required().min(32),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  MFA_ISSUER: Joi.string().default('CaminoSeguroSanBenito'),

  // Telemetry (MQTT & WebSockets)
  MQTT_BROKER_URL: Joi.string().default('mqtt://localhost:1883'),
  MQTT_CLIENT_ID: Joi.string().default('backend_telemetry_engine'),
  MQTT_USERNAME: Joi.string().allow('').optional(),
  MQTT_PASSWORD: Joi.string().allow('').optional(),
  MQTT_QOS: Joi.number().valid(0, 1, 2).default(1),
  MQTT_TOPIC_GPS_INGEST: Joi.string().default('telemetry/vehicles/+/gps'),
  MQTT_TOPIC_ALERT_INGEST: Joi.string().default('telemetry/vehicles/+/alerts'),

  SOCKET_IO_PORT: Joi.number().default(3001),
  SOCKET_IO_PATH: Joi.string().default('/socket.io'),

  // Firebase Cloud Messaging
  FIREBASE_PROJECT_ID: Joi.string().allow('').optional(),
  FIREBASE_CLIENT_EMAIL: Joi.string().allow('').optional(),
  FIREBASE_PRIVATE_KEY: Joi.string().allow('').optional(),

  // SMS / WhatsApp Fallback
  SMS_GATEWAY_PROVIDER: Joi.string().valid('twilio', 'aws_sns', 'mock').default('mock'),
  SMS_GATEWAY_API_KEY: Joi.string().allow('').optional(),
  SMS_GATEWAY_SENDER_ID: Joi.string().default('CAMINOSEGURO'),

  // Observability & Audit
  LOG_LEVEL: Joi.string().valid('debug', 'info', 'warn', 'error').default('debug'),
  LOG_FORMAT: Joi.string().valid('json', 'text').default('json'),
  AUDIT_LOG_ENABLED: Joi.boolean().default(true),
  METRICS_PORT: Joi.number().default(9090),
});
