# Start Notes

## Service User Layout

TeleCodex can keep the application source in another user's home while running the service as the `codex` user.

Recommended layout:

```text
/home/userA/telecodex/       # app source/build, readable by codex
/home/codex/workspaces/      # default Codex workspace root
/home/codex/.codex/          # Codex auth/state
```

The service should run as `codex`, but its `WorkingDirectory` can point at the app checkout:

```ini
[Service]
User=codex
Group=codex
WorkingDirectory=/home/userA/telecodex
EnvironmentFile=/home/codex/telecodex.env
ExecStart=/usr/bin/node /home/userA/telecodex/dist/index.js
Restart=on-failure
```

Use the `codex` home for runtime workspaces:

```bash
TELECODEX_WORKSPACE_ROOT=/home/codex/workspaces
CODEX_SANDBOX_MODE=workspace-write
CODEX_APPROVAL_POLICY=never
ENABLE_UNSAFE_LAUNCH_PROFILES=false
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_IDS=...
```

The `codex` user must be able to traverse and read the application path. If `/home/userA` is private, grant only the minimum needed access:

```bash
sudo chgrp -R codex /home/userA/telecodex
sudo chmod -R g+rX /home/userA/telecodex
sudo chmod g+x /home/userA
```

Avoid giving `codex` write access to User A's home unless the service is intentionally allowed to modify the app source.

## Unsandboxed Codex With Sudo

The unset default and the example env use `CODEX_SANDBOX_MODE=workspace-write`. Set `CODEX_SANDBOX_MODE=danger-full-access` only when Codex must work outside the workspace sandbox. With `CODEX_APPROVAL_POLICY=never`, TeleCodex will not pause for approval prompts, which is the expected setup for a service.

Sudo still depends on Linux permissions. The service runs as the `codex` user, so only commands allowed to `codex` can run. For service use, allow exact commands through sudoers without a password:

```sudoers
codex ALL=(root) NOPASSWD: /usr/bin/systemctl restart example.service
codex ALL=(root) NOPASSWD: /usr/bin/journalctl -u example.service
```

Avoid broad rules such as `codex ALL=(ALL) NOPASSWD: ALL` unless the Telegram users and host are fully trusted. Prefer one sudoers file under `/etc/sudoers.d/codex-telecodex`, validate it with `visudo -cf /etc/sudoers.d/codex-telecodex`, then test as the service user:

```bash
sudo -u codex sudo -n /usr/bin/systemctl restart example.service
```
