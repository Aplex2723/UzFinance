# Atajo de iPhone (Apple Pay / Wallet)

Cómo registrar gastos automáticamente cada vez que pagas con Apple Pay.


Requisitos: iPhone con iOS que incluya el disparador **Transacción** (Atajos → Automatización), tus tarjetas en Wallet y el token de ingesta (comando de la sección de rotación, paso 0).

> Los nombres de las variables y acciones pueden variar ligeramente según la versión de iOS; la idea es la misma.

## 1. Registra tus tarjetas en UzFinance

En **Tarjetas** crea Amex, tus Banamex y Nu (el emisor define el color y el desglose). El campo **Alias** debe contener el nombre como lo manda Wallet (separa varios con coma, p. ej. `Nu, NuBank`). No distingue mayúsculas ni acentos. También se reconoce por **últimos 4 dígitos**.

Si el nombre no coincide con ninguno, el gasto **no se pierde**: entra a la tarjeta *Sin asignar* y en sus **notas** queda `Tarjeta sin reconocer: "<texto recibido>"`. Copia ese texto como alias de la tarjeta correcta y reasigna el movimiento (editar).

## 2. Crea la automatización

1. **Atajos → Automatización → + → Nueva automatización → Transacción**.
2. Elige las tarjetas a monitorear (todas las que quieras registrar).
3. Siguiente → agrega las acciones de abajo.
4. Al final elige **Ejecutar inmediatamente** y desactiva **Notificar al ejecutar**, para que corra sin pedir confirmación.

## 3. Acciones (en este orden)

1. **Fecha actual**.
2. **Formatear fecha** → Formato de fecha: **ISO 8601**.
3. **Obtener contenido de URL**:
   - **URL:** `https://<tu-app>.azurewebsites.net/api/ingest`
   - **Método:** `POST`
   - **Encabezados:**
     - `Authorization` = `Bearer ` + tu token (con un espacio después de *Bearer*)
     - `Content-Type` = `application/json`
   - **Cuerpo de la solicitud:** JSON, con estos campos (los valores son *variables mágicas* de la entrada **Transacción**):

     | Clave | Tipo | Valor |
     |---|---|---|
     | `merchant` | Texto | **Comercio** de la transacción |
     | `amount` | Texto | **Monto** de la transacción |
     | `card` | Texto | **Tarjeta o pase** (nombre) |
     | `date` | Texto | **Fecha con formato** (paso 2) |

   El monto puede venir como `$123.45`, `MXN 123.45`, etc.; el servidor lo interpreta. Los reembolsos deben llegar con signo negativo: **revisa tus primeras transacciones reales** para confirmar cómo los reporta tu iOS.

## 4. Reintentos (arranque en frío de la base)

Si la base estaba pausada, la primera llamada puede tardar o responder `503`. El servidor es idempotente (deduplica), así que reintentar es seguro. Envuelve la acción *Obtener contenido de URL* así:

```
Repetir 4 veces
  Obtener contenido de URL        ← la acción de arriba
  Si  Contenido de URL  contiene  "status"      ← "inserted" o "duplicate": ya quedó guardado
    Detener este atajo
  Fin Si
  Esperar 45 segundos
Fin Repetir
```

## 5. Probar sin gastar

Las automatizaciones de Transacción no se pueden disparar a mano con datos reales, así que prueba el endpoint por separado.

- **Desde la terminal** (validación sin escribir, `X-Dry-Run`):
  ```bash
  curl -s -X POST https://<tu-app>.azurewebsites.net/api/ingest \
    -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" -H "X-Dry-Run: 1" \
    -d '{"merchant":"PRUEBA","amount":"1.00","card":"Nu"}'
  # → {"status":"ok","dryRun":true}
  ```
- **Desde el iPhone:** duplica el atajo como uno normal ("Probar UzFinance"), reemplaza las variables por texto fijo (`PRUEBA`, `1.00`, el alias de tu tarjeta) y agrega **Mostrar resultado** al final. Debe responder `{"status":"inserted",…}`; bórralo después desde **Transacciones**.

Códigos que verás: `200` listo · `401` token incorrecto (revisa `Bearer ` y el token) · `400` campo faltante/mal formado · `429` demasiados intentos · `503` base despertando (reintenta).
