# Comandos de la aplicación **which_game**

Esta aplicación permite a los espectadores votar por opciones de juego usando comandos de chat de Twitch. A continuación se describen todos los comandos disponibles y su funcionalidad.

---

## Alias de voto

| Comando | Descripción |
|---------|-------------|
| `!vota` | Alias para registrar un voto. Equivalente a usar el comando numérico correspondiente a la opción deseada. |
| `!votar` | Alias idéntico a `!vota`. |
| `!vote` | Alias idéntico a `!vota`. |

> **Nota**: Los alias utilizan la configuración `commandAliases` definida en `app.js` y pueden usarse indistintamente.

---

## Comandos de control

| Comando | Acción |
|---------|--------|
| `!reset` o `!reiniciar` | Reinicia la sesión de votación, vuelve a cargar los juegos y restablece los votos. Útil para comenzar una nueva ronda sin recargar la página. |
| `!start` o `!iniciar` | Inicia la fase de votación (si estaba pausada). Habilita la captura de votos y muestra la overlay. Sólo se permite cuando la transmisión está en vivo. |

---

## Comandos numéricos (slots)

Los números representan los **slots** mostrados en la overlay. Cada slot corresponde a una opción de juego.

| Comando | Slot | Tipo de opción | Acción |
|---------|------|----------------|--------|
| `!1` | 1 | Fijo | Votar por la primera opción fija (primer juego de `OPTIONS_DATA`). |
| `!2` | 2 | Fijo | Votar por la segunda opción fija. |
| `!3` | 3 | Fijo **o** carrusel | Si el carrusel está activo, el slot 3 corresponde al primer juego del carrusel; de lo contrario, es la tercera opción fija. |
| `!4` | 4 | Fijo **o** carrusel | Votar por la segunda opción del carrusel (o cuarta opción fija si no hay carrusel). |
| `!5` | 5 | Fijo **o** carrusel | Votar por la tercera opción del carrusel (o quinta opción fija). |
| `!6` | 6 | Fijo **o** carrusel | Votar por la cuarta opción del carrusel (o sexta opción fija). |
| `!7` – `!10` | 7‑10 | Carrusel | Votar por opciones adicionales del carrusel (si existen). Cada comando corresponde al juego del carrusel en la posición `slot‑6`. |

> **Ejemplo**: Si el carrusel contiene 4 juegos, los comandos `!7` a `!10` no estarán activos porque no hay suficientes opciones.

---

## Resumen de comportamiento

- Todos los comandos incrementan el conteo de votos para la opción correspondiente.
- El peso del voto depende del nivel del usuario y posibles bonificaciones (`extraBonus`, `fixedPoints`).
- Cuando una opción alcanza el umbral definido por `WINNER_THRESHOLD` (100 puntos), la votación se detiene y se declara el ganador.
- Los comandos sólo pueden usarse cuando la transmisión está **en vivo** (verificación mediante `isChannelLive`).

---

## Extensión futura

- Se pueden añadir nuevos alias o comandos adicionales modificando la variable `config.commandAliases` en `app.js`.
- Para habilitar o desactivar el carrusel, ajuste `config.carouselInterval` y la lista `CAROUSEL_DATA` en `data.js`.

---

*Este archivo está pensado como referencia rápida para streamers y moderadores que interactúan con la overlay de votación.*
