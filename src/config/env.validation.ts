import * as Joi from "joi";

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid("development", "production", "test")
    .default("development"),
  PORT: Joi.number().default(3000),
  API_PREFIX: Joi.string().default("api/v1"),
  CORS_ALLOWED_ORIGINS: Joi.string().default(
    "http://localhost:3000,http://localhost:5173",
  ),

  // Configuración de Base de Datos PostgreSQL 16 + PostGIS
  DB_HOST: Joi.string().default("localhost"),
  DB_PORT: Joi.number().default(5432),
  DB_NAME: Joi.string().default("camino_seguro_db"),
  DB_USER: Joi.string().default("app_user"),
  DB_PASSWORD: Joi.string().default("camino_seguro_pass"),
  GEO_USE_POSTGIS: Joi.string().valid("true", "false").default("false"),
  CUSTODY_USE_POSTGRES: Joi.string().valid("true", "false").default("false"),
  CUSTODY_MORNING_JOB_ENABLED: Joi.string()
    .valid("true", "false")
    .default("false"),
  CUSTODY_MORNING_JOB_HOUR: Joi.number().integer().min(0).max(23).default(5),
  CUSTODY_MORNING_JOB_MINUTE: Joi.number().integer().min(0).max(59).default(0),
  CUSTODY_MORNING_JOB_INTERVAL_MS: Joi.number()
    .integer()
    .min(1000)
    .default(60000),

  // Seguridad Criptográfica y Ley 1581 (ADR-002)
  CURRENT_KEY_VERSION: Joi.string().default("v1"),
  APP_ENCRYPTION_MASTER_KEY: Joi.string().default(
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  ),
  APP_BLIND_INDEX_HMAC_KEY: Joi.string().default(
    "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
  ),

  // Autenticación JWT y MFA
  JWT_SECRET: Joi.string().default("super_secret_jwt_key_camino_seguro_2026"),
  JWT_EXPIRES_IN: Joi.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default("7d"),

  // Correo saliente (OTP de doble factor). Sin SMTP_HOST, en desarrollo
  // el código se escribe en el log; en producción el arranque falla.
  SMTP_HOST: Joi.string().allow("").optional(),
  SMTP_PORT: Joi.number().default(587),
  SMTP_SECURE: Joi.boolean().default(false),
  SMTP_USER: Joi.string().allow("").optional(),
  SMTP_PASSWORD: Joi.string().allow("").optional(),
  MAIL_FROM: Joi.string().default(
    "Camino Seguro <no-reply@caminoseguro.edu.co>",
  ),

  // Broker IoT MQTT y WebSockets
  MQTT_BROKER_URL: Joi.string().default("mqtt://localhost:1883"),
});
