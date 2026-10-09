# MC Manager tray controller

This is a lightweight Windows PowerShell/WinForms tray controller for the Node-based MC Manager.

The tray shows a creeper icon (`tray\mc-manager.ico`) and reports the manager's state in its tooltip, e.g. `MC Manager - Running - Minecraft ONLINE`. Regenerate the icon (and the dashboard favicon) with:

```powershell
powershell.exe -ExecutionPolicy Bypass -File 'E:\MC PC - Sandbox\tray\build-icon.ps1' -FaviconPng 'E:\MC PC - Sandbox\mc-manager\client\public\favicon.png'
```

The manager writes `logs\manager.log` itself (rotated at 5 MB); the tray writes `logs\manager-tray.log`.

## Behavior

- The tray controller can start with Windows login.
- The manager starts only from the tray menu.
- The dashboard opens at `http://127.0.0.1:3000`.
- The manager can be stopped gracefully through its supervisor token.
- If graceful shutdown fails, the tray uses a Windows process-tree fallback.
- Minecraft is not started automatically and may remain unconfigured until its core files are selected.

## First run

1. Create `mc-manager\.env` from `mc-manager\.env.example`.
2. Set all authentication and supervisor secrets.
3. Build the client with `npm.cmd run build:client` from `mc-manager`.
4. Run:

   ```powershell
   & 'E:\MC PC - Sandbox\tray\start-tray.cmd'
   ```

5. Right-click the tray icon and choose **Start Manager**.

For remote dashboard access over Tailscale, open an elevated PowerShell window and run:

```powershell
powershell.exe -ExecutionPolicy Bypass -File 'E:\MC PC - Sandbox\tray\setup-dashboard-firewall.ps1'
```

This allows TCP 3000 only from `100.64.0.0/10`.

Install login startup after testing:

```powershell
powershell.exe -ExecutionPolicy Bypass -File 'E:\MC PC - Sandbox\tray\install-startup.ps1'
```

Remove the login startup entry with:

```powershell
powershell.exe -ExecutionPolicy Bypass -File 'E:\MC PC - Sandbox\tray\remove-startup.ps1'
```

Logs are stored under `E:\MC PC - Sandbox\logs`.
