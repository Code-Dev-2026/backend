-- ============================================================================
-- CAMINO SEGURO - BACKEND CORE DDL (POSTGRESQL 16 + POSTGIS 3.4)
-- Archivo: V011__student_sensitive_fields.sql
-- Issue #4: Criptovault de datos sensibles del expediente del menor (Ley 1581)
-- Todos los campos personales se guardan SOLO como formato_cifrado_aes
-- (key_version:iv:tag:ciphertext, AES-256-GCM). La búsqueda exacta por
-- documento usa documento_blind_index (HMAC-SHA256, ya creado en V003).
-- ============================================================================

BEGIN;

ALTER TABLE estudiante
    ADD COLUMN IF NOT EXISTS nombre_completo_cifrado formato_cifrado_aes,
    ADD COLUMN IF NOT EXISTS direccion_cifrada formato_cifrado_aes,
    ADD COLUMN IF NOT EXISTS condiciones_medicas_cifradas formato_cifrado_aes;

-- nombre_completo_cifrado reemplaza a nombres_cifrado + apellidos_cifrado.
ALTER TABLE estudiante ALTER COLUMN nombres_cifrado DROP NOT NULL;
ALTER TABLE estudiante ALTER COLUMN apellidos_cifrado DROP NOT NULL;

COMMENT ON COLUMN estudiante.nombre_completo_cifrado IS 'AES-256-GCM key_version:iv:tag:ciphertext (Ley 1581)';
COMMENT ON COLUMN estudiante.documento_cifrado IS 'AES-256-GCM key_version:iv:tag:ciphertext (Ley 1581)';
COMMENT ON COLUMN estudiante.direccion_cifrada IS 'AES-256-GCM key_version:iv:tag:ciphertext (Ley 1581)';
COMMENT ON COLUMN estudiante.condiciones_medicas_cifradas IS 'AES-256-GCM key_version:iv:tag:ciphertext; dato sensible de salud (Ley 1581 art. 5)';
COMMENT ON COLUMN estudiante.documento_blind_index IS 'HMAC-SHA256(APP_BLIND_INDEX_HMAC_KEY, documento normalizado) para búsqueda exacta sin descifrar';

COMMIT;
