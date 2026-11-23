import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import { HashService } from "@common/crypto/hash.service";
import {
  BoardingValidationMethod,
  InvalidQrTokenError,
} from "./domain/attendance.types";

const DYNAMIC_QR_PREFIX = "cs-qr:v1:";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const DEFAULT_DEV_QR_SECRET = "dev_qr_dynamic_hmac_secret_camino_seguro_2026";

export interface ValidatedQrToken {
  tipo: "DINAMICO" | "ESTATICO";
  id_estudiante: string | null;
  qr_token_hash: string;
  metodo_validacion: BoardingValidationMethod;
}

/**
 * Servicio SRP de homologación y validación criptográfica de tokens QR (Issue #8).
 *
 * Soporta:
 * 1. QR dinámico firmado con HMAC-SHA256 y expiración temporal (`cs-qr:v1:<uuid>:<exp>:<sig>`),
 *    verificado con comparación en tiempo constante (`crypto.timingSafeEqual`).
 * 2. QR estático institucional o QR ocasional temporal, cuyo hash SHA-256 se contrasta
 *    en base de datos contra `estudiante.qr_token_hash` o `pasajero_ocasional.qr_provisional_hash`.
 */
@Injectable()
export class QrTokenValidator {
  private readonly hashService: HashService;
  private readonly hmacSecret: string;
  private readonly defaultTtlSeconds: number;

  constructor(
    @Optional() hashService?: HashService,
    @Optional() configService?: ConfigService,
  ) {
    this.hashService = hashService ?? new HashService();
    const configuredSecret =
      configService?.get<string>("QR_DYNAMIC_HMAC_SECRET") ??
      DEFAULT_DEV_QR_SECRET;
    const isProduction =
      configService?.get<string>("NODE_ENV") === "production";
    if (
      isProduction &&
      (configuredSecret === DEFAULT_DEV_QR_SECRET ||
        configuredSecret.length < 32)
    ) {
      throw new Error(
        "QR_DYNAMIC_HMAC_SECRET inseguro para producción: defina un secreto propio de al menos 32 caracteres.",
      );
    }
    this.hmacSecret = configuredSecret;
    this.defaultTtlSeconds =
      configService?.get<number>("QR_DYNAMIC_TTL_SECONDS") ?? 300;
  }

  /**
   * Genera un token QR dinámico firmado HMAC-SHA256 con ventana de expiración.
   */
  generateDynamicQrToken(
    idEstudiante: string,
    ttlSeconds = this.defaultTtlSeconds,
    nowEpochSeconds = Math.floor(Date.now() / 1000),
  ): string {
    if (!UUID_PATTERN.test(idEstudiante)) {
      throw new InvalidQrTokenError(
        "QR_INVALIDO",
        "Identificador de estudiante inválido para generar QR dinámico.",
      );
    }

    const exp = nowEpochSeconds + ttlSeconds;
    const payload = `${idEstudiante}:${exp}`;
    const signature = this.signPayload(payload);
    return `${DYNAMIC_QR_PREFIX}${payload}:${signature}`;
  }

  /**
   * Valida un código QR escaneado (dinámico firmado o estático homologado).
   */
  validate(
    rawToken: string,
    requestedMethod: BoardingValidationMethod = "QR_INSTITUCIONAL",
    nowEpochSeconds = Math.floor(Date.now() / 1000),
  ): ValidatedQrToken {
    const trimmed = typeof rawToken === "string" ? rawToken.trim() : "";

    if (!trimmed || trimmed.length > 512) {
      throw new InvalidQrTokenError(
        "QR_INVALIDO",
        "El token QR está vacío o excede la longitud máxima permitida.",
      );
    }

    if (trimmed.startsWith("cs-qr:")) {
      return this.validateDynamicToken(trimmed, requestedMethod, nowEpochSeconds);
    }

    return {
      tipo: "ESTATICO",
      id_estudiante: null,
      qr_token_hash: this.hashService.sha256(trimmed),
      metodo_validacion: requestedMethod,
    };
  }

  private validateDynamicToken(
    token: string,
    requestedMethod: BoardingValidationMethod,
    nowEpochSeconds: number,
  ): ValidatedQrToken {
    if (!token.startsWith(DYNAMIC_QR_PREFIX)) {
      throw new InvalidQrTokenError(
        "QR_INVALIDO",
        "Versión de token QR dinámico no soportada.",
      );
    }

    const body = token.slice(DYNAMIC_QR_PREFIX.length);
    const parts = body.split(":");
    if (parts.length !== 3) {
      throw new InvalidQrTokenError(
        "QR_INVALIDO",
        "Formato de token QR dinámico malformado.",
      );
    }

    const [idEstudiante, expRaw, providedSig] = parts;
    if (
      !UUID_PATTERN.test(idEstudiante) ||
      !/^\d+$/.test(expRaw) ||
      !HEX_SHA256_PATTERN.test(providedSig)
    ) {
      throw new InvalidQrTokenError(
        "QR_INVALIDO",
        "Estructura interna del token QR dinámico inválida.",
      );
    }

    const expectedSig = this.signPayload(`${idEstudiante}:${expRaw}`);
    const validSignature = crypto.timingSafeEqual(
      Buffer.from(expectedSig, "hex"),
      Buffer.from(providedSig.toLowerCase(), "hex"),
    );

    if (!validSignature) {
      throw new InvalidQrTokenError(
        "QR_INVALIDO",
        "Firma criptográfica del token QR dinámico inválida.",
      );
    }

    const exp = Number(expRaw);
    if (!Number.isSafeInteger(exp) || exp < nowEpochSeconds) {
      throw new InvalidQrTokenError(
        "QR_EXPIRADO",
        "El token QR dinámico ha expirado. Solicite un nuevo código.",
      );
    }

    return {
      tipo: "DINAMICO",
      id_estudiante: idEstudiante,
      qr_token_hash: this.hashService.sha256(token),
      metodo_validacion: requestedMethod,
    };
  }

  private signPayload(payload: string): string {
    return crypto
      .createHmac("sha256", this.hmacSecret)
      .update(payload, "utf8")
      .digest("hex");
  }
}
