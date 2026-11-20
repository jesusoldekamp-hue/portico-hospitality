# Guía de Despliegue en AWS (Demo Ejecutiva vs. Producción SEGOB)

## 1. Despliegue rápido en el servidor AWS de tu amigo (SOLO PARA DEMO / JUNTA)

El servidor AWS (EC2) de tu amigo sirve perfecto para que la Asociación vea la plataforma funcionando en vivo desde cualquier laptop o celular durante la presentación.

### Opción A — Con Docker (recomendada, 2 minutos)
En el servidor EC2 (Ubuntu / Amazon Linux):

```bash
# 1. Copiar esta carpeta al servidor (vía scp o git)
cd pui-hoteles-asociacion

# 2. Definir secretos únicos y levantar el servicio
export PUI_JWT_SECRET="$(openssl rand -hex 32)"
export PUI_VAULT_KEY="$(openssl rand -hex 32)"
docker compose up -d --build

# 3. Verificar salud 24/7
curl http://localhost:3080/api/health
```

### Opción B — Directo con Node.js (>= 20, sin instalar librerías)
```bash
cd pui-hoteles-asociacion
PORT=3080 PUI_JWT_SECRET="$(openssl rand -hex 32)" PUI_VAULT_KEY="$(openssl rand -hex 32)" node src/server.js
```

### Habilitar HTTPS rápido para la junta (opcional, recomendado)
En el **Security Group** de EC2 abre puertos `80` y `443` (o `3080` temporalmente para prueba interna). Si tu amigo ya tiene un subdominio apuntando a esa IP (ej. `pui-demo.tudominio.com`), pon Caddy o Nginx enfrente apuntando a `127.0.0.1:3080` para obtener TLS/HTTPS automático con Let's Encrypt.

---

## 2. Regla CRÍTICA para Producción Real con SEGOB (cuando ya haya huéspedes reales)

> **NO uses el servidor personal de un tercero para datos reales de hoteles.**

Cuando pasen a **Fase 1 (Piloto Crowne Plaza Monterrey con datos reales y Llave MX)**:
1. **Cuenta AWS propia** a nombre de la Asociación de Hoteles (o contrato formal de encargado de datos con tu empresa).
2. **Base de datos cifrada (AWS RDS PostgreSQL)** con cifrado en reposo vía **AWS KMS** y respaldos automáticos diarios (sustituyendo el archivo `data/state.json` de demo).
3. **HTTPS TLS 1.3 obligatorio** mediante Application Load Balancer (ALB) + ACM + **AWS WAF**.
4. **Llaves y secretos en AWS Secrets Manager** (nunca en código ni en archivos planos).
5. **Pruebas de seguridad SAST / DAST / SCA** y bitácoras centralizadas en CloudWatch para auditoría oficial del Manual Técnico DOF.
