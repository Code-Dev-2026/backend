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

  // Broker IoT MQTT y WebSockets
  MQTT_BROKER_URL: Joi.string().default("mqtt://localhost:1883"),
});
