-- ============================================================================
-- CAMINO SEGURO - BACKEND CORE DDL (POSTGRESQL 16 + POSTGIS 3.4)
-- Archivo: V013__geo_san_benito_geofence.sql
-- Issue #6: Modelado geoespacial de rutas escolares, paradas GiST y geocercas
-- Requisitos SRS: RF-03, RF-04, RNF-05, OWASP ASVS V5.1
-- Reversible mediante: db/migrations/undo/U013__geo_san_benito_geofence.sql
-- ============================================================================

BEGIN;

-- 1. Garantizar secuencia estrictamente positiva en paradas oficiales
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_parada_orden_positivo'
          AND conrelid = 'public.parada'::regclass
    ) THEN
        ALTER TABLE public.parada
            ADD CONSTRAINT chk_parada_orden_positivo CHECK (orden_secuencia > 0);
    END IF;
END $$;

-- 2. Enriquecer zona_geografica con código determinista y vínculo opcional a colegio
ALTER TABLE public.zona_geografica
    ADD COLUMN IF NOT EXISTS codigo VARCHAR(40),
    ADD COLUMN IF NOT EXISTS id_colegio UUID REFERENCES public.colegio(id_colegio) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_zona_geografica_codigo
    ON public.zona_geografica (codigo)
    WHERE codigo IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_zona_geografica_tipo_activa
    ON public.zona_geografica (tipo_zona)
    WHERE activa = TRUE;

CREATE INDEX IF NOT EXISTS idx_zona_geografica_colegio
    ON public.zona_geografica (id_colegio)
    WHERE id_colegio IS NOT NULL;

-- 3. Reafirmar índices espaciales GiST directos sobre columnas geography (RNF-05)
CREATE INDEX IF NOT EXISTS idx_ruta_polilinea ON public.ruta USING GIST (polilinea_oficial);
CREATE INDEX IF NOT EXISTS idx_parada_punto ON public.parada USING GIST (punto_geografico);
CREATE INDEX IF NOT EXISTS idx_parada_geocerca ON public.parada USING GIST (radio_geocerca);
CREATE INDEX IF NOT EXISTS idx_zona_poligono ON public.zona_geografica USING GIST (poligono);

-- 4. Configuración oficial de la geocerca de la sede Colegio San Benito del Otún
-- Ubicación de referencia: Carrera 7 No. 24-50, Pereira, Risaralda (centro ~4.8143, -75.6946)
-- Perímetro cerrado WGS84 (~300m x 300m / ~150m de radio desde la portería institucional)
INSERT INTO public.zona_geografica (
    codigo,
    nombre,
    tipo_zona,
    poligono,
    descripcion,
    activa
)
VALUES (
    'GEOCERCA-SAN-BENITO-OTUN',
    'Sede Colegio San Benito del Otún',
    'GEOCERCA_ESCOLAR',
    ST_GeogFromText(
        'SRID=4326;POLYGON((-75.69595 4.81295, -75.69325 4.81295, -75.69325 4.81565, -75.69595 4.81565, -75.69595 4.81295))'
    ),
    'Geocerca perimetral oficial de la sede Colegio San Benito del Otún en Pereira, Risaralda (SRID 4326).',
    TRUE
)
ON CONFLICT (codigo) WHERE codigo IS NOT NULL DO NOTHING;

COMMENT ON COLUMN public.zona_geografica.codigo IS 'Código único determinista de geocerca (p. ej. GEOCERCA-SAN-BENITO-OTUN)';
COMMENT ON COLUMN public.zona_geografica.id_colegio IS 'Referencia opcional a la institución educativa propietaria de la geocerca escolar';

COMMIT;
