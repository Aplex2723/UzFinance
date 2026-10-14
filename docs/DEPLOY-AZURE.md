# Despliegue en Azure

Guía para montar UzFinance en tu propia suscripción de Azure (App Service + Azure SQL + Entra ID) y operarlo. Los nombres entre `<…>` son los tuyos.

## Aprovisionar desde cero

Receta adaptada de despliegues reales (léela completa antes de pegarla: crea recursos que cuestan dinero). Necesitas `az` y `gh` con sesión iniciada, Node 24 y permiso para crear *app registrations* en tu tenant. **Elige tu perfil de costo antes de empezar:**

| Perfil | Plan web | Base de datos | Costo aprox. |
|---|---|---|---|
| **Gratis** | `F1` (sin *Always On*, 60 min de CPU/día) | SQL serverless con la oferta gratuita (`--use-free-limit`; se pausa y tiene cupo mensual, ver [límites](#límites-del-plan-gratuito-léelo)) | US$0 |
| **Siempre encendido** | `B1` (+ `--always-on true`) | SQL `Basic` (5 DTU, 2 GB) | ≈ US$18/mes (B1 ≈ 13 + SQL ≈ 5) |

> Azure **no tiene un tope duro de gasto**: los presupuestos y alertas avisan, no cortan. Crea el presupuesto (paso 8) antes de dejar nada corriendo.

```bash
# 0) Variables (cambia lo que sea tuyo)
SUB=$(az account show --query id -o tsv); TENANT=$(az account show --query tenantId -o tsv)
RG=rg-uzfinance; LOC=southcentralus; SFX=$(openssl rand -hex 3 | cut -c1-5)
APP=uzfinance-$SFX; SRV=uzfinance-sql-$SFX; PLAN=plan-uzfinance
ME_EMAIL=<tu-correo>; ME_OID=$(az ad signed-in-user show --query id -o tsv)
GH_REPO=<tu-usuario>/UzFinance

# 1) Grupo de recursos, plan y Web App (Node 24 LTS)
az group create -n $RG -l $LOC
az appservice plan create -g $RG -n $PLAN -l $LOC --is-linux --sku F1        # o B1
az webapp create -g $RG -p $PLAN -n $APP --runtime "NODE:24-lts" --https-only true
az webapp config set -g $RG -n $APP --ftps-state Disabled --http20-enabled true --min-tls-version 1.2 \
  --startup-file "node server.js"                                            # con B1 añade --always-on true

# 2) Identidades: la de la app (para la base) y una de usuario (solo para Easy Auth)
az webapp identity assign -g $RG -n $APP
UAMI=$(az identity create -g $RG -n id-uzfinance-auth -l $LOC --query "{c:clientId,p:principalId,id:id}" -o json)
UAMI_CLIENT=$(echo "$UAMI" | python3 -c "import json,sys;print(json.load(sys.stdin)['c'])")
UAMI_PRINCIPAL=$(echo "$UAMI" | python3 -c "import json,sys;print(json.load(sys.stdin)['p'])")
az webapp identity assign -g $RG -n $APP --identities "$(echo "$UAMI" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")"

# 3) Azure SQL: solo autenticación Entra (sin logins ni passwords SQL)
az sql server create -g $RG -n $SRV -l $LOC --enable-ad-only-auth --external-admin-principal-type User \
  --external-admin-name $ME_EMAIL --external-admin-sid $ME_OID --minimal-tls-version 1.2
az sql db create -g $RG -s $SRV -n uzfinance --edition Basic --capacity 5 --max-size 2GB \
  --backup-storage-redundancy Local       # perfil gratis: en su lugar `--use-free-limit --free-limit-exhaustion-behavior AutoPause --compute-model Serverless --edition GeneralPurpose --family Gen5 --capacity 2`
az sql server firewall-rule create -g $RG -s $SRV -n AllowAzureServices --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0

# 4) Esquema y permisos (regla de firewall TEMPORAL con tu IP; se borra al final)
MYIP=$(curl -s https://api.ipify.org)
az sql server firewall-rule create -g $RG -s $SRV -n tmp-migrate --start-ip-address $MYIP --end-ip-address $MYIP; sleep 20
export DB_SERVER=$SRV.database.windows.net DB_NAME=uzfinance
npx tsx scripts/azure-sql.ts migrate
npx tsx scripts/azure-sql.ts grant "$(az webapp identity show -g $RG -n $APP --query principalId -o tsv)" $APP   # solo db_datareader + db_datawriter
az sql server firewall-rule delete -g $RG -s $SRV -n tmp-migrate

# 5) Login con Entra ID (Easy Auth) sin client secret: credencial federada sobre la identidad de usuario
URL=https://$APP.azurewebsites.net
WEB_APPID=$(az ad app create --display-name uzfinance-web --sign-in-audience AzureADMyOrg \
  --web-redirect-uris "$URL/.auth/login/aad/callback" --enable-id-token-issuance true --query appId -o tsv)
az ad sp create --id $WEB_APPID >/dev/null
az ad app federated-credential create --id "$(az ad app show --id $WEB_APPID --query id -o tsv)" --parameters \
  "{\"name\":\"easyauth-uami\",\"issuer\":\"https://login.microsoftonline.com/$TENANT/v2.0\",\"subject\":\"$UAMI_PRINCIPAL\",\"audiences\":[\"api://AzureADTokenExchange\"]}"

# 6) App Settings (los secretos solo viven aquí; ver docs/DEVELOPMENT.md para la lista completa)
az webapp config appsettings set -g $RG -n $APP -o none --settings \
  AUTH_MODE=easyauth ALLOWED_EMAIL=$ME_EMAIL ALLOWED_TENANT_ID=$TENANT CATEGORIZER=rules \
  DB_AUTH=msi DB_SERVER=$SRV.database.windows.net DB_NAME=uzfinance DB_TRUST_SERVER_CERT=false \
  HOSTNAME=0.0.0.0 PORT=8080 WEBSITES_PORT=8080 SCM_DO_BUILD_DURING_DEPLOYMENT=false \
  OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID=$UAMI_CLIENT WEBSITE_AUTH_AAD_ALLOWED_TENANTS=$TENANT \
  INGEST_TOKEN="$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-56)"

# 7) Easy Auth: todo exige sesión salvo las rutas que traen su propio token; solo entra TU object id
cat > /tmp/auth.json <<JSON
{"properties":{
 "platform":{"enabled":true,"runtimeVersion":"~1"},
 "globalValidation":{"requireAuthentication":true,"unauthenticatedClientAction":"RedirectToLoginPage","redirectToProvider":"azureactivedirectory",
   "excludedPaths":["/api/ingest","/api/ingest/email","/manifest.webmanifest","/icons/*"]},
 "identityProviders":{"azureActiveDirectory":{"enabled":true,
   "registration":{"openIdIssuer":"https://login.microsoftonline.com/$TENANT/v2.0","clientId":"$WEB_APPID","clientSecretSettingName":"OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID"},
   "validation":{"defaultAuthorizationPolicy":{"allowedPrincipals":{"identities":["$ME_OID"]}}}}},
 "login":{"cookieExpiration":{"convention":"FixedTime","timeToExpiration":"90.00:00:00"},"tokenStore":{"enabled":false}}
}}
JSON
az rest --method put --uri "/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Web/sites/$APP/config/authsettingsV2?api-version=2022-03-01" --body @/tmp/auth.json
rm /tmp/auth.json

# 8) Presupuesto y alertas (¡no te lo saltes!): ver "Límites y alertas de costo" más abajo

# 9) Despliegue desde GitHub por OIDC (sin secretos): credencial federada atada a tu repo y a `main`
DEPLOY_APPID=$(az ad app create --display-name uzfinance-github-deploy --sign-in-audience AzureADMyOrg --query appId -o tsv)
az ad sp create --id $DEPLOY_APPID >/dev/null
OWNER_ID=$(gh api repos/$GH_REPO --jq .owner.id); REPO_ID=$(gh api repos/$GH_REPO --jq .id)
az ad app federated-credential create --id "$(az ad app show --id $DEPLOY_APPID --query id -o tsv)" --parameters \
  "{\"name\":\"github-main\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"repo:${GH_REPO%%/*}@$OWNER_ID/${GH_REPO##*/}@$REPO_ID:ref:refs/heads/main\",\"audiences\":[\"api://AzureADTokenExchange\"]}"
sleep 20
az role assignment create --assignee $DEPLOY_APPID --role "Website Contributor" \
  --scope "/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Web/sites/$APP"   # solo sobre la Web App

for kv in AZURE_CLIENT_ID=$DEPLOY_APPID AZURE_TENANT_ID=$TENANT AZURE_SUBSCRIPTION_ID=$SUB \
          AZURE_RESOURCE_GROUP=$RG AZURE_WEBAPP_NAME=$APP; do gh variable set "${kv%%=*}" --body "${kv#*=}" -R $GH_REPO; done
```

Con las variables definidas, el siguiente push a `main` pasa por CI, despliega y corre el smoke test. **Sin esas variables el job de despliegue se omite**, por eso un fork solo corre el CI.

> **Cuidado:** el *subject* de la credencial federada incluye los IDs numéricos del propietario y del repo. Si renombras el repo no pasa nada, pero si lo borras y lo recreas debes rehacer la credencial.

### Límites y alertas de costo

Mínimo recomendable (ajusta el monto a tu plan):

```bash
az monitor action-group create -g $RG -n ag-uzfinance --short-name uzfinance --action email yo $ME_EMAIL
az consumption budget create --budget-name budget-uzfinance -g $RG --category cost --amount 20 --time-grain monthly \
  --start-date $(date +%Y-%m-01) --end-date 2030-12-31 \
  --notifications "[{\"enabled\":true,\"operator\":\"GreaterThan\",\"threshold\":80,\"contactEmails\":[\"$ME_EMAIL\"]}]"
```

Además conviene una *Azure Policy* "Not allowed resource types" sobre el grupo para impedir recursos caros (VMs, AKS, Redis, Cosmos, Front Door…) y alertas de actividad cuando alguien cambie el plan o la base. Revisa el costo real en *Cost Management* durante los primeros días.

## Azure: recursos y costo

Todo vive en el grupo de recursos **`rg-uzfinance`** (región `southcentralus`). Hay un único entorno (producción).

| Recurso | Nombre | Costo/mes |
|---|---|---|
| Azure SQL (servidor, solo Entra) | `<tu-servidor-sql>` | $0 |
| Azure SQL Database (serverless, oferta gratuita, `AutoPause` al agotar) | `uzfinance` | $0 |
| App Service plan F1 (Linux) | `plan-uzfinance` | $0 |
| Web App (Node 24 LTS) | `<tu-app>` → https://<tu-app>.azurewebsites.net | $0 |
| Managed Identity de usuario (solo Easy Auth) | `id-uzfinance-auth` | $0 |
| Presupuesto US$5/mes con alertas | `budget-uzfinance` | $0 |
| Alerta de cupo SQL + grupo de acciones | `alert-sql-free-quota`, `ag-uzfinance` | $0 |
| App registrations (Entra) | `uzfinance-web`, `uzfinance-github-deploy` | $0 |

**Costo mensual esperado: US$0.** Región: la oferta gratuita de SQL serverless no existe en México Central; South Central US es la más cercana con disponibilidad, y se dejó la Web App en la misma región para minimizar latencia con la base.

## Runbook de despliegue

**Despliegue normal:** `git push` a `main` → [`deploy.yml`](../.github/workflows/deploy.yml): CI completo → build standalone → `azure/login` (OIDC) → `az webapp deploy` → smoke test. Si algo falla, no se despliega.

Variables del repo (no son secretos): `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_WEBAPP_NAME`.

Redesplegar sin cambios: `gh workflow run deploy.yml`.
Rollback: `git revert <commit> && git push` (vuelve a pasar por el pipeline).

**Smoke test manual:** `bash scripts/smoke.sh https://<tu-app>.azurewebsites.net [INGEST_TOKEN]`

### Migraciones de base de datos

El despliegue **no** modifica el esquema (la identidad de la app no tiene DDL). Las migraciones (`db/migrations/*.sql`) se aplican a mano con tu identidad Entra (administrador del servidor SQL), **antes** de desplegar código que las necesite:

```bash
az login                                   # con la cuenta administradora del servidor SQL
RG=rg-uzfinance; SRV=<tu-servidor-sql>
MYIP=$(curl -s https://api.ipify.org)
az sql server firewall-rule create -g $RG -s $SRV -n tmp-migrate --start-ip-address $MYIP --end-ip-address $MYIP
sleep 20
DB_SERVER=$SRV.database.windows.net DB_NAME=uzfinance npx tsx scripts/azure-sql.ts migrate
az sql server firewall-rule delete -g $RG -s $SRV -n tmp-migrate      # ¡siempre cerrar la regla!
```

Escribe migraciones compatibles hacia atrás (agregar, no romper) para poder aplicarlas antes del código nuevo.

### Operación

```bash
# Ver el estado y los últimos logs
az webapp show -g rg-uzfinance -n <tu-app> --query state
az webapp log config -g rg-uzfinance -n <tu-app> --application-logging filesystem --level error
az webapp log tail   -g rg-uzfinance -n <tu-app>

# Cupo gratuito restante de la base (vCore-segundos)
DBID=$(az sql db show -g rg-uzfinance -s <tu-servidor-sql> -n uzfinance --query id -o tsv)
az monitor metrics list --resource $DBID --metric free_amount_remaining --interval PT1H --aggregation Minimum -o table
```

## Rotación del token de ingesta

El token vive solo en el App Setting `INGEST_TOKEN` (y en tu Atajo). Cada cambio de App Settings reinicia la app (unos segundos). Rotación **sin cortes**, en dos fases:

```bash
RG=rg-uzfinance; APP=<tu-app>

# 0) Ver el token actual (no lo pegues en chats ni commits)
az webapp config appsettings list -g $RG -n $APP --query "[?name=='INGEST_TOKEN'].value | [0]" -o tsv

# 1) Generar uno nuevo y dejar el viejo como "previo" (ambos válidos)
OLD=$(az webapp config appsettings list -g $RG -n $APP --query "[?name=='INGEST_TOKEN'].value | [0]" -o tsv)
NEW=$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-56)
az webapp config appsettings set -g $RG -n $APP --settings INGEST_TOKEN="$NEW" INGEST_TOKEN_PREVIOUS="$OLD" -o none
echo "$NEW" | pbcopy && echo "Token nuevo copiado al portapapeles"

# 2) Pega el token nuevo en el Atajo (encabezado Authorization: Bearer …) y dispara una prueba

# 3) Retirar el viejo
az webapp config appsettings delete -g $RG -n $APP --setting-names INGEST_TOKEN_PREVIOUS -o none
unset OLD NEW
```

**Si el token se filtró:** salta la fase de "previo": genera `NEW`, `set INGEST_TOKEN="$NEW"` y `delete INGEST_TOKEN_PREVIOUS` de inmediato; el Atajo dejará de funcionar hasta que lo actualices. Después revisa la actividad (`source = shortcut`) por movimientos que no reconozcas.

## Límites del plan gratuito (léelo)

**App Service F1:** cuota de CPU de 60 min/día compartida, 1 GB de RAM, sin *Always On* (la app se duerme sin tráfico y la primera visita tarda), un solo proceso (el rate limiter en memoria funciona porque no hay escalado horizontal). Si alguna vez molesta, el siguiente escalón es B1 (≈ US$13/mes).

**Azure SQL gratuita (serverless):**

- Cupo: **100,000 vCore-segundos/mes** y 32 GB. Se renueva cada mes calendario.
- Mientras está despierta consume **al menos 0.5 vCore → 1,800 vCore-s por hora despierta → ≈ 55 horas despierta al mes (≈ 1.8 h/día)**.
- La base se pausa tras **60 min sin actividad** y ese tiempo **no se puede cambiar** en la oferta gratuita. Cada visita o gasto del Atajo la despierta ≥ 60 min.
- Si el uso es muy repartido (muchos gastos en horas distintas), **el cupo puede agotarse antes de fin de mes**. Entonces la base se pausa hasta el mes siguiente: el dashboard falla y `/api/ingest` responde 503 (el Atajo reintenta, pero tras agotar el cupo no hay datos que guardar hasta el nuevo mes).
- Por eso hay una **alerta por correo** cuando quedan < 30,000 vCore-s. Si te llega temprano en el mes, las opciones son: (a) cambiar a *BillForUsage* (irreversible; se paga solo el excedente, ≈ US$0.26 por hora despierta), (b) un plan fijo (SQL *Basic* ≈ US$5/mes, siempre despierta) o (c) migrar a Cosmos DB free tier (sin pausa, requiere reescribir la capa de datos).
- `LiveRefresh` está diseñado para **no** mantener despierta la base: solo consulta con la pestaña visible y actividad en los últimos 5 min.
- **Arranque en frío:** la primera consulta tras una pausa tarda 30–60 s. `/api/ingest` reintenta la conexión y, si no alcanza, responde `503` con `Retry-After`; el Atajo debe reintentar (ver guía).

## Destruir todo (NO se ejecuta solo)

> **Irreversible.** Elimina la base y todos tus datos. Antes exporta lo que quieras conservar (Reportes → CSV por mes). Estos comandos están aquí solo como documentación; no los ejecutes sin estar seguro.

```bash
# 1) Todo lo que vive en el grupo de recursos (Web App, plan, SQL + base, identidad, presupuesto, alertas)
az group delete -n rg-uzfinance --yes --no-wait

# 2) App registrations en Entra (viven fuera del grupo de recursos)
az ad app delete --id "$(az ad app list --display-name uzfinance-web --query '[0].appId' -o tsv)"
az ad app delete --id "$(az ad app list --display-name uzfinance-github-deploy --query '[0].appId' -o tsv)"

# 3) Variables del repositorio (opcional)
for v in AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_SUBSCRIPTION_ID AZURE_RESOURCE_GROUP AZURE_WEBAPP_NAME; do gh variable delete $v; done

# 4) Opcional: quitar a tu Gmail invitado del tenant
az ad user delete --id "tu-correo_gmail.com#EXT#@<tu-tenant>.onmicrosoft.com"
```

Local: `npm run db:down` y `docker volume rm uzfinance_uzfinance-db` borran la base de docker.

## Solución de problemas

| Síntoma | Causa probable / qué hacer |
|---|---|
| El navegador muestra 401/403 tras iniciar sesión | La cuenta no está asignada a la enterprise app `uzfinance-web`, o su correo no coincide con `ALLOWED_EMAIL`. Revisa asignación y el claim real en `/.auth/me` (con sesión iniciada) |
| El Atajo recibe 401 | Token incorrecto o falta el espacio en `Bearer <token>`; si rotaste, actualiza el Atajo |
| El Atajo recibe 503 o tarda | Base despertando; reintenta. Si persiste el mes completo, se agotó el cupo gratuito (ver sección de límites) |
| Un gasto cae en "Sin asignar" | El nombre de la tarjeta no coincide con ningún alias; ver notas del movimiento y agrega el alias |
| La primera visita es lenta | App Service F1 sin *Always On* + base pausada; es normal tras horas de inactividad |
| El deploy falla en `azure/login` | La credencial federada debe coincidir con el *subject* real del token (incluye IDs inmutables del repo); el log del paso lo muestra |
| El deploy pasa pero la app no arranca | Revisa `az webapp log tail`; en Linux el servidor standalone necesita `HOSTNAME=0.0.0.0` y `PORT=8080` |
| `npm run typecheck` falla en limpio | Corre `npm run typecheck` (genera primero los tipos de rutas de Next) |
