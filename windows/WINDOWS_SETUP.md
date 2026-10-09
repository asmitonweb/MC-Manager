# Windows E-drive setup

The repository in `mc-manager\` is `asmitonweb/MC-Manager`. Its `setup.sh` and `upgrade.sh` are for the original Ubuntu/Azure deployment and are not used on this Windows host.

```text
E:\MC PC - Sandbox\
  mc-manager\        the manager (this repository)
  server\            Minecraft server, installed from the dashboard
    worlds\<id>\     one folder per world
    mods\
  backups\
    worlds\<id>\     world backups (.zip + .zip.json)
    server-install\  loader files replaced by a reinstall
  manager-data\      server profile, world registry, mod manifest, job logs
  logs\              manager.log and manager-tray.log
  tray\              tray controller
  ssh\
```

## First-time setup

1. Complete `ssh\README.md` from an elevated PowerShell window.
2. Copy `mc-manager\.env.example` to `mc-manager\.env` and replace every placeholder with unique values.
3. Install dependencies and build the web client:
   ```powershell
   Set-Location 'E:\MC PC - Sandbox\mc-manager'
   npm.cmd ci --omit=dev
   npm.cmd --prefix client ci
   npm.cmd run build:client
   ```
4. Start the tray controller (the creeper icon) and choose **Start Manager**:
   ```powershell
   & 'E:\MC PC - Sandbox\tray\start-tray.cmd'
   ```
5. After confirming the tray works, install its login startup entry:
   ```powershell
   powershell.exe -ExecutionPolicy Bypass -File 'E:\MC PC - Sandbox\tray\install-startup.ps1'
   ```

## Using the dashboard (admin)

- **Server**: install Fabric or Forge. Pick the loader, Minecraft version, loader version, Java runtime and memory, accept the EULA, and install. Only Java that is already installed is used: Minecraft 26.x needs Java 25, 1.20.5–1.21.x needs Java 21, older versions need Java 17. Reinstalling keeps worlds, mods, config and `server.properties`.
- **Worlds**: create, import (.zip), duplicate, rename, download, delete, and switch the active world. Switching requires the server to be stopped. Mods and config are shared by all worlds.
- **Backups**: manual only. Backing up the running world pauses autosave while the backup is written and turns it back on afterwards. Restoring over a world takes a safety snapshot first; you can also restore as a new world. Manual backups are kept until you delete them; safety snapshots keep the latest 5 per world.
- **Mods**: search Modrinth for mods that match the installed version and loader, review dependencies, and install. Mod changes require the server to be stopped. Files in `server\mods` that the manager did not install are never changed. Set `CURSEFORGE_API_KEY` in `.env` to enable CurseForge.

The `user` role can only start, stop and restart the server.

## Network

The dashboard listens on `HOST=0.0.0.0`. `tray\setup-dashboard-firewall.ps1` allows TCP 3000 only from the Tailscale range (`100.64.0.0/10`). From another Tailscale device, open `http://<tailscale-ip>:3000`.

To let Tailscale players join, run `tray\setup-minecraft-firewall.ps1` from an elevated PowerShell window. It allows TCP 25565 for the server's java.exe from `100.64.0.0/10` only, and blocks the RCON port (25575) for every remote host; the manager reaches RCON over `127.0.0.1`, which is unaffected. Players connect to `<tailscale-ip>:25565`.

The installer enables RCON with a generated password. Never open the RCON port.

## Deploying changes from another machine

`windows/deploy-to-mc-pc.sh` in the repository syncs the code over SSH, rebuilds the client and restarts the tray in the desktop session. It never overwrites `.env`, `server\`, `backups\` or `manager-data\`.

`test/e2e/e2e.cjs` runs an end-to-end check in a throwaway sandbox on `127.0.0.1:3999` without touching the real server.

Never commit `.env`, world data, server JARs, logs, or private SSH keys.
