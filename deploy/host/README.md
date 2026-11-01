# Host deployment snapshot

These are the exact files running on the reference host (Ubuntu 24.04, systemd user units).

- `systemd/` — `cairn-server`, `cairn-dispatcher`, `cairn-web`, plus `cpu.conf`
- `nginx/` — `cairn.conf` (Basic auth + proxy) and `cairn-extra.conf`
- `dispatch.yaml` — dispatcher config used in production (local execution, 3 workers)
- `systemd/cairn-web.service` uses the console build at `console/`

All paths are absolute (`/home/vic/...`). When replicating, replace them with the target
user's home and the clone location, then `systemctl --user daemon-reload`.
