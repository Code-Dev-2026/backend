-- ============================================================================
-- CAMINO SEGURO - MOTOR CORE & CUSTODIA (COLEGIO SAN BENITO DEL OTÚN)
-- V009__billing_isolated_schema.sql
-- Sub-sistemas: Esquema Aislado de Facturación, Cartera y Pagos (billing)
--               Segregación de Privilegios Financieros vs Operativos
-- ============================================================================

-- Crear esquema aislado
CREATE SCHEMA IF NOT EXISTS billing;

-- ----------------------------------------------------------------------------
-- 1. TABLA DE ESTADO DE CARTERA POR ESTUDIANTE
-- RF-18, RNF-01, RNF-02
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing.cartera (
    id_cartera UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    id_estudiante UUID NOT NULL REFERENCES public.estudiante(id_estudiante) ON DELETE RESTRICT,
    id_acudiente_titular UUID NOT NULL REFERENCES public.acudiente(id_acudiente) ON DELETE RESTRICT,
    saldo_pendiente NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (saldo_pendiente >= 0),
    saldo_a_favor NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (saldo_a_favor >= 0),
    estado_cartera VARCHAR(20) NOT NULL DEFAULT 'AL_DIA'
        CHECK (estado_cartera IN ('AL_DIA', 'EN_MORA', 'SUSPENDIDO', 'EXONERADO', 'INACTIVO')),
    dias_mora INT NOT NULL DEFAULT 0 CHECK (dias_mora >= 0),
    fecha_corte DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT unq_cartera_estudiante UNIQUE (id_estudiante)
);

CREATE INDEX IF NOT EXISTS idx_cartera_acudiente ON billing.cartera(id_acudiente_titular);
CREATE INDEX IF NOT EXISTS idx_cartera_estado ON billing.cartera(estado_cartera);

-- ----------------------------------------------------------------------------
-- 2. FACTURACIÓN MENSUAL DEL SERVICIO DE TRANSPORTE
-- RF-18
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing.factura (
    id_factura UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    id_cartera UUID NOT NULL REFERENCES billing.cartera(id_cartera) ON DELETE RESTRICT,
    numero_factura VARCHAR(50) NOT NULL UNIQUE,
    periodo_mes SMALLINT NOT NULL CHECK (periodo_mes BETWEEN 1 AND 12),
    periodo_anio INT NOT NULL CHECK (periodo_anio >= 2026),
    subtotal NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0),
    descuento NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (descuento >= 0),
    total NUMERIC(12,2) NOT NULL CHECK (total >= 0),
    fecha_emision DATE NOT NULL DEFAULT CURRENT_DATE,
    fecha_vencimiento DATE NOT NULL,
    estado_factura VARCHAR(20) NOT NULL DEFAULT 'EMITIDA'
        CHECK (estado_factura IN ('EMITIDA', 'PAGADA', 'PAGO_PARCIAL', 'ANULADA', 'VENCIDA')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_fechas_factura CHECK (fecha_vencimiento >= fecha_emision)
);

CREATE INDEX IF NOT EXISTS idx_factura_cartera ON billing.factura(id_cartera);
CREATE INDEX IF NOT EXISTS idx_factura_estado ON billing.factura(estado_factura);

-- ----------------------------------------------------------------------------
-- 3. REGISTRO TRANSACCIONAL DE PAGOS
-- RF-18
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing.pago (
    id_pago UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    id_factura UUID NOT NULL REFERENCES billing.factura(id_factura) ON DELETE RESTRICT,
    monto NUMERIC(12,2) NOT NULL CHECK (monto > 0),
    metodo_pago VARCHAR(30) NOT NULL
        CHECK (metodo_pago IN ('TRANSFERENCIA', 'PSE', 'TARJETA_CREDITO', 'EFECTIVO_CONVENIO', 'DESCUENTO_NOMINA')),
    referencia_transaccion VARCHAR(100) NOT NULL UNIQUE,
    comprobante_url TEXT,
    fecha_pago TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    estado_pago VARCHAR(20) NOT NULL DEFAULT 'APROBADO'
        CHECK (estado_pago IN ('PENDIENTE', 'APROBADO', 'RECHAZADO', 'REVERSADO')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_pago_factura ON billing.pago(id_factura);
