# Matriz de Trazabilidad: Modelo de Datos vs. Requisitos SRS v2.0

Esta matriz vincula formalmente cada una de las tablas del modelo relacional con los requerimientos funcionales (**RF**), no funcionales (**RNF**), reglas de negocio (**RN**) e historias de usuario (**HU**) de la Especificación de Requerimientos de Software (SRS v2.0).

---

| # | Tabla | Requisito SRS / Stack | Descripción y Justificación de Negocio |
|---|---|---|---|
| 1 | `colegio` | **RF-01, RF-13** | Entidad educativa contratante (Colegio San Benito del Otún); ancla institucional. |
| 2 | `empresa_transportadora` | **RF-01, RF-17** | Operador logístico (Transportes Camino Seguro S.A.S.); administra flota y rutas. |
| 3 | `usuario` | **RF-13, RNF-01, RNF-02** | Núcleo de autenticación e identidad centralizada. |
| 4 | `rol` / `usuario_rol` | **RF-13, RNF-02** | Matriz de 8 roles del sistema; control de acceso basado en roles (RBAC). |
| 5 | `refresh_token` | **RNF-01, RNF-02** | Gestión de tokens con `family_id` para detección de robo y revocación en cadena. |
| 6 | `mfa_secret` | **RF-13, RNF-01** | Doble factor de autenticación TOTP para Coordinadora de Convivencia (SuperAdmin). |
| 7 | `dispositivo` | **RF-12, RF-20, RNF-05** | Registro de terminales móviles, tokens FCM para push y enlace de sincronización. |
| 8 | `coordinador` | **RF-13, RF-16** | Perfil directivo con facultad de intervención, autorización de excepciones y firmas. |
| 9 | `conductor` | **RF-09, RNF-07, HU-09** | Operador vehicular; `id_usuario` es opcional para garantizar no intrusión laboral. |
| 10 | `monitora` | **RF-02, RF-06, RF-08** | Tripulación que valida abordajes QR y cotejo visual biométrico de entregas. |
| 11 | `acudiente` | **RF-05, RF-11, RF-19, RF-20** | Titular de patria potestad legitimado para consultar mapa, recibir alertas y radicar. |
| 12 | `adulto_autorizado` | **RF-05, RF-06, RN-04** | Terceros designados formalmente (máximo 3) para retirar al estudiante en parada. |
| 13 | `estudiante` | **RF-01, RF-02, RNF-01, RNF-09** | Menor de edad protegido; datos cifrados en reposo (AES-256-GCM) y blind index. |
| 14 | `estudiante_acudiente` | **RF-01, RF-05, RNF-02** | Relación N:M acudientes-menores que modela custodias compartidas. |
| 15 | `estudiante_autorizado` | **RF-05, RF-06** | Relación N:M autorizados-menores (un abuelo puede recoger a varios hermanos). |
| 16 | `expediente_cifrado` | **RF-05, HU-06, RNF-09** | Bóveda biométrica por adulto autorizado (foto rostro, cédula, consentimiento Ley 1581). |
| 17 | `alerta_judicial` | **RF-07, HU-07, RN-04, RNF-08** | Medidas cautelares registradas por Rectoría; emite bloqueo exclusivo en la entrega. |
| 18 | `viaje` | **RF-02, RF-03, RF-09, RF-18** | Instancia de viaje con exclusiones horarias btree_gist y contador atómico de aforo. |
| 19 | `viaje_estudiante` | **SRS Sec. 4, RN-01 a RN-07** | Estado de custodia por viaje; soporta mañana, tarde y días consecutivos. |
| 20 | `historial_estado_custodia` | **SRS Sec. 4, RF-20, RNF-08** | Máquina de estados inmutable append-only con encadenamiento SHA-256. |
| 21 | `inasistencia` | **RF-04, RN-03** | Reporte previo formal del acudiente que habilita y libera cupo para invitados. |
| 22 | `pasajero_ocasional` | **RF-04, HU-04, RN-03** | Solicitud de cupo temporal con >= 2h de antelación y cupo liberado comprobable. |
| 23 | `vehiculo` | **RF-03, RF-09, RN-02** | Capacidad nominal estricta y módem satelital homologado (sin teléfono personal). |
| 24 | `ruta` | **RF-17, RF-18, RN-06** | Trazado oficial georreferenciado; soporte para detección de desvíos > 300m. |
| 25 | `parada` | **RF-11, RF-17, RN-06** | Paraderos georreferenciados ordenados con radio de geocerca para estimación de ETA. |
| 26 | `asignacion_ruta` | **RF-01, RF-17** | Mapeo del estudiante con su paradero de subida y bajada según ciclo horario. |
| 27 | `zona_geografica` | **RF-10, RF-14, HU-17** | Polígonos espaciales: sombras celulares (La Virginia) y perímetro municipal. |
| 28 | `registro_gps` | **RF-09, RF-18, RNF-07** | Telemetría continua cada 5s; particionado mensual con retención de 180 días. |
| 29 | `registro_de_asistencia` | **RF-02, RF-03, RN-01** | Abordaje y descenso por QR con prevención de lecturas dobles (<15 min). |
| 30 | `entrega` | **RF-06, RF-08, RN-04** | Entrega verificada en parada a receptor legitimado o retorno seguro al colegio. |
| 31 | `acta_custodia` | **RF-08, RF-16** | Formalización digital de entrega del menor en sede escolar a Coordinación. |
| 32 | `incidente` | **RF-16** | Registro inmutable de intentos fallidos, bloqueos de aforo o desvíos viales. |
| 33 | `aval_coordinacion` | **RF-13, RF-08** | Autorización formal superior para transbordos, cambios de chofer o excepciones. |
| 34 | `importacion_matricula` | **RF-01, HU-01** | Auditoría y registro de inconsistencias en cargas masivas CSV/Excel. |
| 35 | `tipo_notificacion` | **RF-12, RF-20** | Catálogo de tipos de eventos y plantillas dinámicas de mensajería. |
| 36 | `notificacion` | **RF-12, RF-14, RF-20, RNF-05** | Despacho transaccional (<2.5s) con protección contra disparo cruzado. |
| 37 | `comunicado` | **RF-12, HU-20** | Emisión institucional unidireccional masiva o zonal de avisos oficiales. |
| 38 | `sync_operation` | **RF-10, RNF-06** | Cola de reconciliación idempotente `(id_dispositivo, idempotency_key)` para SQLite. |
| 39 | `bitacora_auditoria` | **RF-16, RNF-08** | Registro forense inmutable con encadenamiento SHA-256 y bloqueo consultivo. |
| 40 | `billing.cartera` | **RF-15, RN-05** | Gestión contable aislada; prohibido bloquear o discriminar al menor por mora. |
| 41 | `billing.factura` | **RF-15** | Facturación administrativa independiente de la operación de ruta. |
| 42 | `billing.pago` | **RF-15** | Registro de recaudos financieros sin visibilidad para conductores o monitoras. |
