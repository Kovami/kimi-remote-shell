# План разработки kimi-remote-shell

Полный аналог [torarnv/claude-remote-shell](https://github.com/torarnv/claude-remote-shell) для Kimi Code CLI:
перенаправление выполнения shell-команд агента на удалённую машину по SSH с опциональной
двусторонней синхронизацией файлов через Mutagen.

---

## 1. Разбор оригинала (claude-remote-shell)

Один bash-скрипт (~320 строк), работающий в четырёх режимах по `basename "$0"`:

| Режим | Назначение |
|---|---|
| `claude-remote-shell*` | Лончер: парсит `[user@]host[:/path] [claude-cmd] [args...]`, поднимает окружение, запускает Claude |
| `claude-remote-control` | Прокси для спавна сессий remote-control |
| `session-start` / `session-end` | Хуки плагина: mutagen-синк данных сессии, маппинг путей |
| `bash` | Обёртка shell: перехват и форвардинг каждой команды по SSH |

Ключевые механизмы Claude Code, на которые опирается оригинал:

1. **`CLAUDE_CODE_SHELL`** — env-переменная, заменяющая shell Bash-инструмента. Лончер создаёт
   симлинк `bash` на самого себя и получает полный перехват всех команд (с cwd, stdout/stderr, exit code).
2. **Временный плагин** (`--plugin-dir`) с хуками `SessionStart`/`SessionEnd` — синк `tool-results`
   сессии и запись маппинга путей в `CLAUDE_ENV_FILE`.
3. **`--append-system-prompt`** — внедрение контекста об удалённом окружении в системный промпт.
4. **`--allowedTools 'Bash(*)'`** / симлинк `claude-remote-shell-yolo` — авто-аппрув Bash на доверенной VM.
5. **Mutagen**: изолированный демон на сессию (`MUTAGEN_DATA_DIRECTORY`), sync `two-way-resolved`
   проекта + tmpdir'а (где Claude трекает cwd), `flush --all` до и после каждой команды.
6. **SSH ControlMaster** (`ControlPath` в сессионной tmpdir, `ControlPersist`) — одно соединение
   на все команды; teardown по `trap EXIT` (terminate sync, stop daemon, `ssh -O exit`, rm tmpdir).
7. **Трансляция путей** в обе стороны: локальные пути в тексте команд переписываются на удалённые,
   удалённые пути в stdout/stderr — обратно (FIFO + `awk` с экранированным `gsub`).

## 2. Что есть у Kimi Code (проверено по докам и бинарнику 2.1.1)

| Механизм Claude Code | Аналог в Kimi Code | Вердикт |
|---|---|---|
| `CLAUDE_CODE_SHELL` | **Отсутствует.** В бинарнике (`packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts`): `processService.spawn(env.shellPath, ["-c", "cd <cwd> && <command>"])`, где `shellPath` — первый существующий из `/bin/bash`, `/usr/bin/bash`, `/usr/local/bin/bash`. `KIMI_SHELL_PATH` — только Windows (Git Bash). Обхода на POSIX нет | ❌ прямой порт невозможен |
| Плагины с хуками (`--plugin-dir`) | Плагины Kimi (`kimi.plugin.json`): поля `hooks`, `mcpServers`, `systemPrompt`/`systemPromptPath`, `sessionStart.skill`, `agents`. Хуки: те же события, тот же протокол (stdin JSON, exit 0/2, `permissionDecision`) | ✅ |
| `--append-system-prompt` | `systemPrompt` / `systemPromptPath` в манифесте плагина (до 32 КБ); `--agent-file` с `${base_prompt}` | ✅ |
| `--allowedTools 'Bash(*)'` | `kimi --yolo` / `--auto`; permission-правила `[[permission.rules]]` с паттернами `Bash(*)`, `mcp__server__*` | ✅ |
| Хук SessionStart | Событие `SessionStart` в хуках плагина | ✅ |
| — | **MCP**: сервер объявляется в манифесте плагина (`mcpServers`, stdio, `./`-пути внутри корня плагина, поле `env`), инструменты видны как `mcp__<server>__<tool>`, хук `PreToolUse` может блокировать встроенный Bash | ✅ ключ к архитектуре |

**Главное отличие:** перехватить встроенный Bash-инструмент нельзя — shell захардкожен.
Вместо перехвата — **замена**: MCP-сервер с удалённым исполнением + блокирующий хук на встроенный Bash.

## 3. Архитектура kimi-remote-shell

Три компонента:

```
kimi-remote-shell                 # лончер (bash-скрипт, как в оригинале)
└─ plugin/                        # плагин Kimi Code
   ├─ kimi.plugin.json            # манифест: mcpServers + hooks + systemPrompt
   ├─ server.mjs                  # MCP-сервер (Node, stdio): удалённое выполнение
   ├─ hooks/block-local-bash.mjs  # PreToolUse(Bash) → deny с указанием на MCP-инструмент
   └─ hooks/remote-context.mjs    # UserPromptSubmit (первый промпт) → контекст об удалённом хосте
```

### 3.1. MCP-сервер `remote-shell` (ядро)

Инструмент `mcp__remote-shell__bash` — зеркало встроенного Bash по семантике:

- Параметры: `command`, `cwd`, `timeout`, `run_in_background`, `description`, `disable_timeout`
  (те же имена, что у встроенного — модель перестраивается безболезненно).
- Выполнение: `ssh $KIMI_REMOTE_SSH_OPTIONS "$KIMI_REMOTE_HOST" "bash -c ..."` —
  удалённая команда собирается как `export SHELL=bash TMPDIR=... && cd <cwd> && eval <command>`,
  с потоковым stdout/stderr и пробросом exit code (как в оригинале, строка 285–315).
- `mutagen sync flush --all` до и после каждой команды (fallback: `reset` + повторный flush).
- Трансляция путей: `KIMI_LOCAL_PATH` → `KIMI_REMOTE_PATH` в тексте команды и cwd;
  обратная замена в stdout/stderr (стримингово, построчно).
- Фоновые задачи: собственный реестр удалённых задач (PID на удалённой стороне, лог в файл
  в сессионной директории) + инструменты `remote_task_output`, `remote_task_list`, `remote_task_stop`.
  Автоматических уведомлений о завершении, как у встроенных задач, не будет — агент опрашивает
  `remote_task_output` (задокументированное отличие; в системном промпте плагина это отражается).

Конфигурацию сервер получает через переменные окружения, унаследованные от процесса `kimi`
(лончер экспортирует их перед запуском): `KIMI_REMOTE_HOST`, `KIMI_REMOTE_SSH_OPTIONS`,
`KIMI_REMOTE_SHELL_DIR`, `KIMI_LOCAL_PATH`, `KIMI_REMOTE_PATH`, `MUTAGEN_DATA_DIRECTORY`.
*Гипотеза о наследовании env stdio-дочерним процессом MCP проверяется на этапе M0;
запасной вариант — поле `env` в `mcp.json` или env-файл в `KIMI_REMOTE_SHELL_DIR`, читаемый сервером при старте.*

### 3.2. Плагин

`kimi.plugin.json`:

- `mcpServers.remote-shell`: stdio, `command: "node"`, `args: ["./server.mjs"]`.
- `hooks`:
  - `PreToolUse` / matcher `Bash` → `block-local-bash.mjs`: exit 2, stderr =
    «локальный Bash отключён; используй `mcp__remote-shell__bash`» — причина блокировки
    уходит в контекст и перенаправляет модель (штатный механизм хуков Kimi).
  - `UserPromptSubmit` → `remote-context.mjs`: на первом сообщении сессии возвращает текст
    с описанием удалённого окружения (хост, `uname -sr`, TMPDIR, маппинг путей) — динамический
    аналог `--append-system-prompt` (статический `systemPrompt` плагина не знает хост сессии).
- `systemPrompt`: статическая часть («все shell-команды выполняются удалённо через
  `mcp__remote-shell__bash`; локальный Bash недоступен; файловые инструменты локальны;
  после правок файлов команды видят изменения благодаря синку; никогда не используй /tmp,
  только $TMPDIR»).
- `sessionStart.skill` — опционально: загрузка скилла с правилами работы в remote-режиме.

Установка: один раз `/plugins install <путь>` (плагины per-user, копируются в
`$KIMI_CODE_HOME/plugins/managed/`). Лончер проверяет установку и печатает инструкцию,
если плагина нет. Автоматизация установки (прямая запись `installed.json` + managed-копия) —
исследуется на M0, задокументированный путь обязателен в любом случае.

### 3.3. Лончер `kimi-remote-shell`

Порт лончерного режима оригинала:

```
kimi-remote-shell [user@]host[:/path] [kimi args...]
kimi-remote-shell-yolo [user@]host[:/path]   # симлинк → kimi --yolo
```

1. Парсинг destination и опциональной альтернативной команды kimi (проверка через `$SHELL -c "command -v"`).
2. Проверки: `mutagen` в PATH; плагин установлен.
3. Сессионная директория `mktemp -d /tmp/kimi-remote-shell.XXXXXX`;
   `MUTAGEN_DATA_DIRECTORY` внутри неё; экспорт env для MCP-сервера.
4. SSH-опции: `StrictHostKeyChecking=yes`, `ControlMaster=auto`,
   `ControlPath=$session_dir/ssh-%C`, `ControlPersist=yes`.
5. Mutagen-синки:
   - `kimi-project`: `pwd -P` ↔ `host:$remote_path`, `--sync-mode=two-way-resolved`,
     опциональный `-c .kimi-code/remote-shell/mutagen.yml` из проекта;
   - синк tmpdir'а из оригинала **не нужен**: Kimi не трекает cwd через файлы —
     `cwd` передаётся параметром каждого вызова (проверено в `bashTool.ts`), а файлы
     сессий/TaskOutput локальны.
6. `trap teardown EXIT`: terminate sync, stop daemon, `ssh -O exit`, `rm -rf $session_dir`,
   чистка зеркальной tmpdir на удалённой стороне.
7. Запуск: `kimi [args...]` (yolo-симлинк добавляет `--yolo`); через `$SHELL -l`, как в оригинале.

## 4. Сознательные отличия от оригинала

| Фича оригинала | Решение в порте |
|---|---|
| Перехват самого Bash-инструмента | Замена MCP-инструментом + блокирующий хук (штатные механизмы Kimi) |
| Встроенные background-задачи с авто-уведомлениями | Свой реестр удалённых задач + polling через `remote_task_output` |
| Синк claude-tmpdir (cwd-tracking, tool-results) | Не нужен (cwd — параметр вызова; TaskOutput читает локальные файлы) |
| Режим `remote-control` | Не переносим (нет аналога `claude remote-control`; у Kimi есть свой `kimi web`) |
| `CLAUDE_CODE_TMPDIR` | Удалённый TMPDIR создаётся лончером, пробрасывается в remote-команду |

## 5. Этапы разработки

- **M0 — валидация гипотез** (0.5–1 день):
  - stdio MCP-сервер наследует env процесса kimi (минимальный сервер, дамп env в лог);
  - хук плагина `PreToolUse(Bash)` блокирует и модель переключается на MCP-инструмент;
  - установка плагина: `/plugins install <dir>`; изучить формат `$KIMI_CODE_HOME/plugins/installed.json`
    для скриптовой установки;
  - mutagen ssh-доступ к тестовому хосту (начать с `localhost` или docker-контейнера с sshd).
- **M1 — ядро MCP-сервера** (2–3 дня): `remote_bash` (foreground): сборка remote-команды,
  SSH ControlMaster, стриминг stdout/stderr, exit code, таймауты, kill по отмене.
  Smoke: `kimi -p "выполни hostname и покажи uname"` — команды уходят на удалённый хост.
- **M2 — лончер** (1–2 дня): парсинг аргументов, сессионная директория, SSH-опции,
  mutagen-синк проекта, teardown-трап, yolo-симлинк, запуск kimi.
- **M3 — плагин** (1 день): манифест, блокирующий хук, `remote-context.mjs`,
  `systemPrompt`, сценарий установки; e2e: модель не может уйти в локальный Bash.
- **M4 — трансляция путей** (1 день): обе стороны, стримингово; edge-cases — пути с пробелами,
  вхождения подстрок (переводить только токены с границами пути, как `gsub` на всю строку
  в оригинале — зафиксировать его же семантику).
- **M5 — фоновые задачи** (1–2 дня): `run_in_background`, реестр задач,
  `remote_task_output/list/stop`, SIGTERM→grace→SIGKILL на удалённой стороне (через SSH),
  уведомление в тексте результата «опрашивай remote_task_output».
- **M6 — упаковка** (1–2 дня): `mutagen.yml` из проекта, README (usage/permissions/ограничения),
  Homebrew Formula по образцу оригинала (`depends_on "mutagen-io/mutagen/mutagen"`,
  симлинк `kimi-remote-shell-yolo`), интеграционные тесты по SSH на localhost/docker
  (запуск команды, cwd-смена между вызовами, синк изменений в обе стороны, трансляция путей,
  teardown без висячих mutagen/ssh-процессов), CI-workflow обновления формулы.

Итого: ~8–12 дней.

## 6. Риски

1. **Наследование env stdio MCP-сервером** — если не подтвердится, конфиг передавать через
   `env` в `mcp.json` (генерируемый лончером project-level `.kimi-code/mcp.json`) или env-файл
   в сессионной директории. *(M0)*
2. **Хрупкость «модель должна звать MCP-инструмент»** — подстраховка: блокирующий хук с явной
   инструкцией в причине + systemPrompt. Permission-правило `deny Bash` в config.toml —
   опциональный жёсткий режим.
3. **Установка плагина не автоматизируема документированно** — UX: одноразовая ручная установка;
   скриптовая — только если формат `installed.json` стабилен. *(M0/M3)*
4. **Project-level MCP требует trust-промпта** — плагин per-user это обходит.
5. **Трансляция путей по тексту** — те же ограничения, что у оригинала (файлы с абсолютными
   путями внутри синкются как есть; git worktree `.git`-файлы). Унаследовать предупреждение в README.

## 7. Источники

- Оригинал: [torarnv/claude-remote-shell](https://github.com/torarnv/claude-remote-shell) (скрипт, README, Formula)
- Доки Kimi Code: [hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html),
  [plugins](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html),
  [mcp](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html),
  [config-files](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html),
  [kimi command](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html),
  [env-vars](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars.html)
- Бинарник kimi 2.1.1: `agent-core-v2/src/agent/tools/os/bash/bashTool.ts` (spawn с захардкоженным
  `shellPath`), `.../execEnv/environmentProbe.ts` (кандидаты `/bin/bash` и др.)
