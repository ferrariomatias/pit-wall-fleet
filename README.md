# Pit Wall Fleet

**Quién te está esperando y quién está trabajando, en esta máquina, en tus máquinas SSH y en tus servidores Orca emparejados.**

Panel lateral de solo lectura para [Orca](https://github.com/stablyai/orca). Es un fork de
[Pit Wall](https://github.com/Juanpe/orca-pit-wall) de Juanpe Catalán (MIT) que agrega los hosts remotos.

## Qué agrega sobre Pit Wall

| | Pit Wall | Pit Wall Fleet |
| --- | --- | --- |
| Worktrees locales | ✓ | ✓ |
| Worktrees por SSH | Aparecen, pero sin decir en qué máquina están | Marcados con el nombre de la máquina |
| Servidores Orca emparejados (`orca environment add`) | No aparecen | Aparecen, con sus sesiones, PRs y checks |
| Mismo proyecto en dos máquinas | Se mezcla en un solo grupo | Un grupo por máquina |
| Filtro por host | — | Una ficha por host; la elección se recuerda |
| Host caído | — | Aviso: "No answer from …" y SSH sin conectar |

## Cómo funciona

- **Local y SSH:** igual que Pit Wall. La API de plugins (`workspace.list`, `agents.list`) ya lista
  los worktrees SSH; este plugin lee además su `hostId` y lo muestra.
- **Nombres de host:** `orca host list --json` (cada 30 s).
- **Servidores emparejados:** el Orca local no los lista, así que el worker corre
  `orca worktree ps --json --environment <id>` por cada uno (cada 10 s, hasta 12 servidores).
  Un snapshot nunca espera más de 4 s a un servidor: sale con la última respuesta o con
  "connecting…" y la lectura sigue para el próximo refresco.

Los tres comandos son de solo lectura. No hay llamadas de red propias, ni lectura o escritura de archivos.

## Límites conocidos

- **Clic en una sesión de un servidor emparejado:** sus terminales pertenecen a ese servidor, así que
  no se pueden enfocar desde acá. El plugin intenta abrir el workspace y, si Orca no puede, avisa en qué
  servidor vive.
- **Sesiones de servidores:** solo tienen lo que da `worktree ps` (no hay eventos en vivo): se
  actualizan cada 10 s, no al instante.

## Instalación

Necesita **Orca 1.4.259** o posterior.

```sh
# Probarlo desde esta carpeta
orca plugin dev load .
orca plugin test . --json

# O instalarlo desde tu propio repo (necesita un tag vX.Y.Z)
orca plugin install <tu-usuario>/pit-wall-fleet
```

## Permisos

Los mismos que Pit Wall: `trusted-worker`, `workspace:read`, `agent:read`, `workspace:write`
(solo `terminal.focus` y `workspace.open` al hacer clic) y `storage:own` (sesiones ya vistas y el
host elegido).

## Archivos

| Archivo | Qué hace |
| --- | --- |
| `src/fleet.ts` | Lo que se lee por el CLI de `orca`: local, nombres de host y servidores (con caché) |
| `src/model.ts` | Une API y CLI, nombra el host de cada fila y arma las secciones |
| `src/view.ts` | Agrupa por host y proyecto, filtra por host, separa lo ya visto |
| `src/worker.ts` | Lee Orca y responde `snapshot` y `open` |
| `panel/` | El panel: HTML, CSS y el organigrama |

## Licencia

MIT. Copyright (c) 2026 Juanpe Catalán (Pit Wall) y colaboradores de este fork. Ver [LICENSE](LICENSE).
