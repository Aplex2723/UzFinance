-- Categorías iniciales con su descripción para Jev. Solo se crean las que faltan (por nombre):
-- no pisa categorías que ya hayas creado ni sus descripciones.
-- Las descripciones usan el vocabulario que aparece en los estados de cuenta (comercios, abreviaturas): así Jev las reconoce.
DECLARE @c TABLE (name NVARCHAR(60), color VARCHAR(9), description NVARCHAR(400));
INSERT @c (name, color, description) VALUES
(N'Restaurantes y cafés', '#f97316', N'Restaurantes, cafeterías y comida fuera de casa: Starbucks, Tim Hortons, Cafe Sirena, Dominos, Carls Jr, Krispy Kreme, VIPS, Dairy Queen, taquerías, dogos y hot dogs, helados, antojitos, panaderías, mariscos, bares, comida rápida, food trucks, REST (restaurante).'),
(N'Comida a domicilio', '#fb923c', N'Pedidos de comida por aplicación: Uber Eats, Rappi, DiDi Food, comida a domicilio, delivery.'),
(N'Supermercado', '#22c55e', N'Despensa y abarrotes: Walmart, Super W, Aki, Soriana, Chedraui (281), 281 Mérida, Costco, Sams, HEB, Bodega Aurrera, La Comer, Superama, Super DiDi, tienda de abarrotes, frutería, carnicería, mercado, súper.'),
(N'Tiendas de conveniencia', '#84cc16', N'Tiendas de conveniencia y minisúper: Oxxo, 7-Eleven, Circle K, Extra, Kiosko, TDA (tienda), MISC (miscelánea), CONV SHOP, tienda de la esquina.'),
(N'Transporte', '#3b82f6', N'Traslados en auto por aplicación o taxi y transporte público: Uber Trip, DiDi rides, Cabify, taxi, casetas, estacionamiento, parquímetro, camión, Metro, ADO.'),
(N'Gasolina y auto', '#eab308', N'Gasolineras y gastos del coche: gasolineras (Pemex, Gasser, Smartpy, ABTS, Mega Sur), combustibles, estación de servicio, SERV, cargadores de autos eléctricos (Evergo), lavado de autos, refacciones, taller mecánico, llantas, verificación, seguro de auto.'),
(N'Viajes y hospedaje', '#06b6d4', N'Vuelos, hoteles, rentas vacacionales, renta de autos y turismo: VivaAerobus, Volaris, Aeroméxico, Avasa, ADO, autobuses foráneos, Airbnb, Booking, hotel (Emporio, Fiesta Inn, Marriott), Hertz, tours, boletos de avión, resort.'),
(N'Compras y ropa', '#ec4899', N'Tiendas departamentales, ropa, calzado, joyería, accesorios y compras en general: Palacio de Hierro, Liverpool (LIV), Sears, Zara, Shein, VSFA (Victorias Secret), Pandora, Miniso, Ripley, joyería, Mercado Libre, Amazon marketplace, tienda en línea, plaza comercial.'),
(N'Electrónica y tecnología', '#6366f1', N'Aparatos y accesorios electrónicos: MacStore, iShop, Apple Store, Best Buy, Steren, Cyberpuerta, celulares, computadoras, tablets, audífonos, cables, consolas, cámaras, gadgets.'),
(N'Suscripciones', '#a855f7', N'Pagos recurrentes digitales: Netflix, Spotify, Disney Plus, YouTube Premium, HBO Max, Amazon Prime, Prime Video, Apple (iTunes, iCloud, App Store), Google One, Claude, Anthropic, OpenAI, ChatGPT, Microsoft 365, membresías.'),
(N'Trabajo y software', '#8b5cf6', N'Herramientas y servicios para trabajar: hosting y dominios (OVH, GoDaddy), Facturama, GitHub, Vercel, AWS, Azure, Google Workspace, papelería y oficina (Office Max), honorarios, servicios profesionales, contador, publicidad.'),
(N'Entretenimiento', '#f43f5e', N'Ocio y diversión: cine (Cinépolis, Cinemex), parques (PQUE), taquilla, museos, Ripley, videojuegos (Steam, Nintendo, PlayStation, Xbox), boletos (TusBoletos, Ticketmaster), conciertos, juegos y juguetes, antros, eventos, arte y juego, boliche.'),
(N'Salud', '#ef4444', N'Salud: farmacias (Yza, Farm, Farmacias Similares, Guadalajara, Benavides, San Pablo), doctores, consultorio, dentista y dental, laboratorio, óptica, hospital, terapia, psicólogo, seguro médico.'),
(N'Mascotas', '#f59e0b', N'Mascotas: veterinaria, clínica veterinaria, croquetas, alimento y accesorios para mascotas, estética canina, Petco.'),
(N'Servicios y telecom', '#0ea5e9', N'Recibos y servicios del hogar: CFE (luz), agua, gas LP, Telmex, Telcel (recargas, saldo, Htech), Izzi, Totalplay, Starlink, internet, ADT (alarma), predial, renta, mantenimiento.'),
(N'Hogar', '#14b8a6', N'Casa y hogar: muebles, decoración, ferretería (FERR), Home Depot, Ikea, Coppel, limpieza, lavandería, tintorería, plomero, jardinería, electrodomésticos.'),
(N'Cuidado personal', '#d946ef', N'Cuidado personal y bienestar: salón de belleza, barbería, estética, spa, masajes, uñas, cosméticos, perfumería, Sephora, gimnasio y fitness (Anytime Fitness, Smart Fit).'),
(N'Educación', '#10b981', N'Educación: colegiaturas, cursos, talleres, libros, librería, escuelas, Udemy, Coursera, papelería escolar.'),
(N'Comisiones e intereses', '#94a3b8', N'Cargos del banco: intereses, comisión por administración, comisión por disposición de efectivo, comisión por transferencia internacional, IVA de comisiones e intereses, anualidad, penalizaciones.'),
(N'Impuestos y gobierno', '#64748b', N'Impuestos y trámites: SAT, pago de impuestos, predial, tenencia, licencias, actas, multas, servicios de gobierno (SERV GOB), permisos.'),
(N'Donativos y regalos', '#f472b6', N'Donativos, donaciones, caridad, regalos, flores, propinas.'),
(N'Deudas y préstamos', '#78716c', N'Pagos de créditos y préstamos: Procredit, Finanzia, Kueski, financiera, crédito personal, hipoteca, arrendamiento financiero, mensualidad de préstamo.'),
(N'Transferencias', '#a3a3a3', N'Transferencias SPEI a terceros y envíos de dinero a personas: pago interbancario, transferencia a un beneficiario, pagos a personas físicas sin un comercio identificable.'),
(N'Efectivo', '#a8a29e', N'Retiros y disposiciones de efectivo: DISP. EFECTIV (disposición de efectivo), cajero automático, retiro de efectivo en sucursal o en un súper.'),
(N'Otros', '#9ca3af', N'Cualquier cargo que no encaja claramente en las demás categorías o cuyo comercio no se puede identificar.');

INSERT dbo.categories (name, color, description)
SELECT s.name, s.color, s.description FROM @c s
WHERE NOT EXISTS (SELECT 1 FROM dbo.categories k WHERE k.name = s.name);

-- Las que ya existían con ese nombre (sin descripción) la reciben; las que ya tienen una propia se respetan.
UPDATE k SET description = s.description
FROM dbo.categories k JOIN @c s ON s.name = k.name
WHERE k.description IS NULL;
