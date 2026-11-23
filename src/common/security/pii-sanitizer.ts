/**
 * Sanitizador de información personal identificable (PII) para logs
 * (Ley 1581 de 2012 — datos de menores). Nunca se usa para respuestas HTTP,
 * solo para lo que se escribe en la salida del sistema.
 */

export const REDACTED = "[REDACTADO]";

/** Fragmentos de nombres de campo cuyo valor nunca debe aparecer en logs. */
const SENSITIVE_KEY_FRAGMENTS = [
  "password",
  "contrasena",
  "secret",
  "token",
  "authorization",
  "cookie",
  "apikey",
  "api_key",
  "master_key",
  "hmac",
  "_enc",
  "cifrad",
  "blind_index",
  "nombre",
  "apellido",
  "documento",
  "direccion",
  "domicilio",
  "condicion",
  "medic",
  "telefono",
  "email",
  "correo",
  "fecha_nacimiento",
];

/** Nombres de campo sensibles que solo se comparan de forma exacta. */
const SENSITIVE_EXACT_KEYS = new Set(["code", "otp", "key", "pin", "cid"]);

const VALUE_PATTERNS: Array<[RegExp, string]> = [
  // Texto cifrado AES (key_version:iv:tag:ciphertext)
  [
    /\bv\d+:[A-Za-z0-9+/=]{8,}:[A-Za-z0-9+/=]{8,}:[A-Za-z0-9+/=]+/g,
    "[CIFRADO]",
  ],
  // JWT
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[JWT]"],
  // Cabecera Bearer
  [/\bBearer\s+\S+/gi, "Bearer [REDACTADO]"],
  // Correos electrónicos
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[EMAIL]"],
  // Documentos con puntos: 1.088.123.456
  [/(?<![\w.-])\d{1,3}(?:\.\d{3}){2,}(?![\w-])/g, "[NUMERO]"],
  // Documentos, teléfonos, códigos: 6 o más dígitos seguidos
  // (no toca segmentos de UUID porque van unidos por guiones).
  [/(?<![\w-])\d{6,}(?![\w-])/g, "[NUMERO]"],
];

export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    SENSITIVE_EXACT_KEYS.has(k) ||
    SENSITIVE_KEY_FRAGMENTS.some((fragment) => k.includes(fragment))
  );
}

export function sanitizeString(value: string): string {
  return VALUE_PATTERNS.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    value,
  );
}

/** Copia profunda con los campos sensibles redactados. No muta el original. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return "[PROFUNDIDAD]";
  }
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (value instanceof Error) {
    const copy = new Error(sanitizeString(value.message));
    copy.name = value.name;
    copy.stack = value.stack ? sanitizeString(value.stack) : undefined;
    return copy;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED : sanitize(inner, depth + 1);
  }
  return result;
}

/**
 * Sanitiza una URL: redacta los valores de parámetros de query sensibles y
 * enmascara documentos, correos o tokens que aparezcan en la ruta.
 */
export function sanitizeUrl(url: string): string {
  const [path, query] = url.split("?", 2);
  const cleanPath = sanitizeString(path);
  if (query === undefined) {
    return cleanPath;
  }

  const cleanQuery = query
    .split("&")
    .map((pair) => {
      const [rawKey, ...rest] = pair.split("=");
      if (rest.length === 0) {
        return sanitizeString(rawKey);
      }
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey);
      } catch {
        // clave mal codificada: se evalúa tal cual
      }
      return isSensitiveKey(key)
        ? `${rawKey}=${REDACTED}`
        : `${rawKey}=${sanitizeString(rest.join("="))}`;
    })
    .join("&");

  return `${cleanPath}?${cleanQuery}`;
}
