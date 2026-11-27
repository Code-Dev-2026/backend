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
  ATTENDANCE_USE_POSTGRES: Joi.string()
    .valid("true", "false")
    .default("false"),
  PASSENGERS_USE_POSTGRES: Joi.string()
    .valid("true", "false")
    .default("false"),
  REALTIME_USE_POSTGRES: Joi.string()
    .valid("true", "false")
    .default("false"),
  NOTIFICATIONS_USE_POSTGRES: Joi.string()
    .valid("true", "false")
    .default("false"),
  QR_DYNAMIC_HMAC_SECRET: Joi.string().default(
    "dev_qr_dynamic_hmac_secret_camino_seguro_2026",
  ),
  QR_DYNAMIC_TTL_SECONDS: Joi.number().integer().min(30).max(86400).default(300),
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

  // Broker IoT MQTT (MQTTS / mTLS - OWASP ASVS V10.3) y Telemetría (Issue #12)
  MQTT_ENABLED: Joi.string().valid("true", "false").default("false"),
  MQTT_BROKER_URL: Joi.string().default("mqtts://localhost:8883"),
  MQTT_TOPIC_PATTERN: Joi.string().default("telemetry/vehicles/+/gps"),
  MQTT_CLIENT_ID: Joi.string().default("camino-seguro-backend-telemetry"),
  MQTT_USERNAME: Joi.string().allow("").optional(),
  MQTT_PASSWORD: Joi.string().allow("").optional(),
  MQTT_TLS_CA_PATH: Joi.string().allow("").optional(),
  MQTT_TLS_CERT_PATH: Joi.string().allow("").optional(),
  MQTT_TLS_KEY_PATH: Joi.string().allow("").optional(),
  MQTT_TLS_REJECT_UNAUTHORIZED: Joi.string()
    .valid("true", "false")
    .default("true"),
  MQTT_RECONNECT_PERIOD_MS: Joi.number().integer().min(250).default(5000),

  TELEMETRY_USE_POSTGRES: Joi.string()
    .valid("true", "false")
    .default("false"),
  TELEMETRY_BATCH_SIZE: Joi.number().integer().min(1).max(5000).default(100),
  TELEMETRY_BATCH_FLUSH_MS: Joi.number()
    .integer()
    .min(10)
    .max(10000)
    .default(100),
  TELEMETRY_MAX_ACCURACY_METERS: Joi.number().min(1).max(100).default(30),
  TELEMETRY_PARTITION_JOB_ENABLED: Joi.string()
    .valid("true", "false")
    .default("false"),
  TELEMETRY_PARTITION_MONTHS_AHEAD: Joi.number()
    .integer()
    .min(0)
    .max(24)
    .default(2),
  TELEMETRY_RETENTION_DAYS: Joi.number()
    .integer()
    .min(30)
    .max(3650)
    .default(180),
  TELEMETRY_PARTITION_JOB_INTERVAL_MS: Joi.number()
    .integer()
    .min(1000)
    .default(3600000),
});
