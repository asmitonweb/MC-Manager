# Windows E-drive setup

The repository in `mc-manager\` is the supplied `asmitonweb/MC-Manager` project. Its `setup.sh` and `upgrade.sh` are for the original Ubuntu/Azure deployment and are not used on this Windows host.

The manager expects the Minecraft server one directory above the manager directory. The local layout is therefore:

```text
E:\MC PC - Sandbox\
  mc-manager\
  server\
  ssh\
  backups\
  logs\
  tray\
```

Keep the Minecraft world, `server.properties`, server JARs, logs, and backups inside this sandbox. The manager reads `server\server.properties` and launches the configured JAR from `server\`.

The tray controller owns the Node manager process. Minecraft itself remains optional until the server version, loader, mods, and plugins are selected.

Before starting the manager:

1. Complete `ssh\README.md` from an elevated PowerShell window.
2. Copy `mc-manager\.env.example` to `mc-manager\.env` and replace every placeholder with unique values.
3. Confirm `JAVA_BIN` points to the Temurin 25 executable. The current installation is:
   ```text
   C:/Program Files/Eclipse Adoptium/jdk-25.0.4.101-hotspot/bin/java.exe
   ```
4. Build the web client:
   ```powershell
   Set-Location 'E:\MC PC - Sandbox\mc-manager'
   npm.cmd run build:client
   ```
5. Start the tray controller manually for the first test:
   ```powershell
   & 'E:\MC PC - Sandbox\tray\start-tray.cmd'
   ```
6. Use the tray menu to start the manager and open the dashboard. The manager will show Minecraft as `UNCONFIGURED` until the server files exist.
7. After confirming the tray works, install its login startup entry:
   ```powershell
   powershell.exe -ExecutionPolicy Bypass -File 'E:\MC PC - Sandbox\tray\install-startup.ps1'
   ```
8. Later, put the Minecraft server files in `server\` and configure RCON to match `.env`.

The dashboard is configured for Tailscale access through `HOST=0.0.0.0`. The Tailscale-only TCP 3000 firewall rule is installed by `tray\setup-dashboard-firewall.ps1`. From another Tailscale device, open `http://<tailscale-ip>:3000`; the tray itself talks to `127.0.0.1:3000`.

Never commit `.env`, world data, server JARs, logs, or private SSH keys.
