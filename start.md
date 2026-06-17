# Start TeleCodex As A System Service

This guide runs TeleCodex as a Linux `systemd` service under the `codex` user.
The app source may live in another user's home, but the running process and the
Codex CLI it spawns inherit the `codex` user's environment and privileges.

## Target Layout

```text
/home/userA/telecodex/       # app source/build, readable by codex
/home/userA/telecodex/.env   # optional app env file, readable by codex
/home/codex/workspaces/      # TeleCodex workspace root
/home/codex/.codex/          # Codex auth/state/config/sessions
/etc/systemd/system/telecodex.service
```

The important rule is that the service runs as `codex`:

```ini
User=codex
Group=codex
Environment=HOME=/home/codex
Environment=CODEX_HOME=/home/codex/.codex
```

With that setup, TeleCodex and every Codex subprocess inherit the `codex` user's
filesystem permissions, Codex login, Codex config, memories, sessions, and sudo
permissions. They do not inherit User A's login identity just because the app
checkout is under `/home/userA`.

## 1. Create Or Prepare The `codex` User

Create the user if it does not already exist:

```bash
sudo useradd --create-home --shell /bin/bash codex
```

Create runtime directories:

```bash
sudo -u codex mkdir -p /home/codex/workspaces /home/codex/.codex
```

If Codex CLI is installed globally, verify the `codex` user can run it:

```bash
sudo -u codex -H bash -lc 'command -v codex && codex --version'
```

If Codex is installed only in a user-local path, install it for the `codex` user
or add the correct binary directory to the service `PATH`.

## 2. Build The App

From the checkout:

```bash
cd /home/userA/telecodex
npm install
npm run build
```

The service uses `dist/index.js`, so rebuild after code changes:

```bash
cd /home/userA/telecodex
npm run build
sudo systemctl restart telecodex
```

## 3. Configure `.env`

You can keep the env file beside the app checkout:

```bash
/home/userA/telecodex/.env
```

Example:

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_IDS=...
TELECODEX_WORKSPACE_ROOT=/home/codex/workspaces

CODEX_SANDBOX_MODE=danger-full-access
CODEX_APPROVAL_POLICY=never
ENABLE_UNSAFE_LAUNCH_PROFILES=false

# Optional
# CODEX_MODEL=gpt-5.4
# CODEX_API_KEY=...
# SHOW_TURN_TOKEN_USAGE=true
```

For the simple full-access service setup, leave these unset:

```bash
CODEX_LAUNCH_PROFILES_JSON=
CODEX_DEFAULT_LAUNCH_PROFILE=
```

TeleCodex loads `.env` from its working directory. The systemd unit below also
uses `EnvironmentFile=/home/userA/telecodex/.env`, which makes systemd fail fast
if the env file is missing. If you prefer to keep secrets under the service
user's home, put the file at `/home/codex/telecodex.env` and update the unit's
`EnvironmentFile`.

Make the file readable by `codex` but not world-readable:

```bash
sudo chgrp codex /home/userA/telecodex/.env
sudo chmod 640 /home/userA/telecodex/.env
```

## 4. Grant Read Access To The Checkout

The `codex` user must be able to traverse `/home/userA` and read the app files:

```bash
sudo chgrp -R codex /home/userA/telecodex
sudo find /home/userA/telecodex -type d -exec chmod 750 {} \;
sudo find /home/userA/telecodex -type f -exec chmod 640 {} \;
sudo chmod 750 /home/userA/telecodex/launchd/start.sh
sudo setfacl -m u:codex:--x /home/userA
```

`setfacl` on `/home/userA` is cleaner than `chmod o+x /home/userA` because it
grants traverse permission only to `codex`, not to every local user.

If your distro does not have ACL support enabled, the fallback is:

```bash
sudo chmod o+x /home/userA
```

Avoid giving `codex` write access to User A's home unless the service is
intentionally allowed to modify the app source or update the env file.

If you already changed permissions recursively in a way that removed executable
bits from `dist/` or `node_modules/`, repair them after `npm install` and
`npm run build`:

```bash
cd /home/userA/telecodex
sudo chgrp -R codex dist node_modules
sudo find dist node_modules -type d -exec chmod 750 {} \;
sudo find dist node_modules -type f -exec chmod 640 {} \;
sudo find node_modules/.bin -type f -exec chmod 750 {} \;
sudo find node_modules/@openai -type f -name codex -exec chmod 750 {} \;
sudo find node_modules -type f \( -name '*.sh' -o -name '*.node' \) -exec chmod 750 {} \;
```

## 5. Authenticate Codex As The `codex` User

If you use ChatGPT login, authenticate as the `codex` user:

```bash
sudo -u codex -H codex login
sudo -u codex -H codex login status
```

If the host is headless, you can use `CODEX_API_KEY` in `.env` instead of a
Codex CLI login.

Confirm the service user owns the Codex state:

```bash
sudo -u codex -H bash -lc 'echo "$HOME"; echo "${CODEX_HOME:-$HOME/.codex}"; codex login status'
```

## 6. Install The Systemd Unit

Create `/etc/systemd/system/telecodex.service`:

```ini
[Unit]
Description=TeleCodex Telegram bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=codex
Group=codex
WorkingDirectory=/home/userA/telecodex
Environment=HOME=/home/codex
Environment=CODEX_HOME=/home/codex/.codex
Environment=PATH=/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/home/userA/telecodex/.env
ExecStart=/usr/bin/node /home/userA/telecodex/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

If `node` or `codex` are not in the paths above, adjust `Environment=PATH=...`
or use absolute paths from:

```bash
sudo -u codex -H bash -lc 'command -v node; command -v codex'
```

## 7. Start And Verify

Reload systemd and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now telecodex
```

Check status and logs:

```bash
sudo systemctl status telecodex
sudo journalctl -u telecodex -f
```

Verify the service is running as `codex`:

```bash
systemctl show telecodex -p User -p Group -p Environment
ps -o user,group,pid,cmd -C node
```

From Telegram, run:

```text
/auth
/status
/session
```

Those commands should reflect the `codex` user's Codex login, quota, workspace,
and current thread state.

## Privilege Model

TeleCodex does not become root. It inherits the full privilege set of the Linux
`codex` user:

- readable/writable paths allowed to `codex`
- `HOME=/home/codex`
- `CODEX_HOME=/home/codex/.codex`
- Codex CLI auth and sessions under `/home/codex/.codex`
- any passwordless sudo rules granted to `codex`

If `CODEX_SANDBOX_MODE=workspace-write`, Codex tool commands are still sandboxed
to the configured workspace roots. If `CODEX_SANDBOX_MODE=danger-full-access`,
Codex can use the full filesystem and command permissions available to the
`codex` user.

## Optional Sudo Access

Sudo still depends on Linux permissions. The service runs as the `codex` user,
so only commands allowed to `codex` can run. For service use, allow exact
commands through sudoers without a password:

```sudoers
codex ALL=(root) NOPASSWD: /usr/bin/systemctl restart example.service
codex ALL=(root) NOPASSWD: /usr/bin/journalctl -u example.service
```

Prefer one sudoers file under `/etc/sudoers.d/codex-telecodex`, validate it,
then test as the service user:

```bash
sudo visudo -cf /etc/sudoers.d/codex-telecodex
sudo -u codex -H sudo -n /usr/bin/systemctl restart example.service
```

Avoid broad rules such as:

```sudoers
codex ALL=(ALL) NOPASSWD: ALL
```

Use that only when the Telegram users and host are fully trusted.

## Prevent Password Login And Password Changes

For a service user, the safest pattern is that `codex` has no usable password
and cannot log in directly. Root can still run commands as `codex` with
`sudo -u codex -H ...`, and systemd can still start services with `User=codex`.

Lock the account password:

```bash
sudo passwd --lock codex
```

Set a non-login shell:

```bash
sudo usermod --shell /usr/sbin/nologin codex
```

Verify the password is locked:

```bash
sudo passwd --status codex
```

The status should show `L` on most Linux distributions, meaning the password is
locked. If your distro uses different output, check `man passwd`.

With `nologin`, normal `su codex` will fail. Use:

```bash
sudo -u codex -H bash -lc 'cd ~ && exec bash'
```

for maintenance commands under the `codex` identity.

This prevents normal password-based login and prevents the `codex` user from
changing its own password through the usual `passwd` flow. It does not stop root
from changing the password, and it does not stop `codex` from doing privileged
things that you explicitly grant through sudoers.

Do not grant broad sudo rules such as:

```sudoers
codex ALL=(ALL) NOPASSWD: ALL
```

If `codex` has broad root sudo, it can unlock itself, change `/etc/shadow`, or
run `passwd` as root. Keep sudoers limited to exact operational commands.

## Update After `git pull`

When you update the checkout, rebuild before restarting the service. A typical
update flow is:

```bash
cd /home/userA/telecodex
git pull
npm install
npm run build
sudo systemctl restart telecodex
sudo journalctl -u telecodex -n 50 --no-pager
```

If the update changed `package-lock.json`, `package.json`, `dist/`, or
`node_modules/`, and `codex` loses read or execute access afterward, reapply the
runtime permissions:

```bash
cd /home/userA/telecodex
sudo chgrp -R codex dist node_modules
sudo find dist node_modules -type d -exec chmod 750 {} \;
sudo find dist node_modules -type f -exec chmod 640 {} \;
sudo find node_modules/.bin -type f -exec chmod 750 {} \;
sudo find node_modules/@openai -type f -name codex -exec chmod 750 {} \;
sudo find node_modules -type f \( -name '*.sh' -o -name '*.node' \) -exec chmod 750 {} \;
sudo systemctl restart telecodex
```

If the update changed the systemd unit, reload systemd before restarting:

```bash
sudo systemctl daemon-reload
sudo systemctl restart telecodex
```

## Troubleshooting

- `Failed to start: TELEGRAM_BOT_TOKEN is required`: check the env file path and
  permissions.
- `codex: command not found`: add Codex's binary directory to the service `PATH`
  or install Codex for the `codex` user.
- Codex uses the wrong account: check `HOME`, `CODEX_HOME`, and
  `sudo -u codex -H codex login status`.
- `Codex Exec exited with code 1: No such file or directory (os error 2)`:
  check that `dist/` and `node_modules/` are readable by `codex`, and that
  package executables still have execute bits after any recursive `chmod`.
- Cannot read app files: check execute permission on `/home/userA` and read
  permission on `/home/userA/telecodex`, plus traverse permission on
  `/home/userA` for `codex`.
- Cannot write generated files: check `TELECODEX_WORKSPACE_ROOT` exists and is
  writable by `codex`.
