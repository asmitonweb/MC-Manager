# MC-Manager

This project is being hosted on the Windows machine under `E:\MC PC - Sandbox`.

## Windows deployment

Use the Windows-specific setup guide at `windows/WINDOWS_SETUP.md` (deployed to `..\WINDOWS_SETUP.md`). The original `setup.sh`, `upgrade.sh`, and Azure deployment instructions are retained for reference only.

The Windows tray controller lives in `windows/tray/` (deployed to `..\tray\`) and owns the Node manager process. From the dashboard, admins install the Minecraft server (Fabric or Forge), manage multiple worlds with backups and restore, and install mods from Modrinth (CurseForge optional).

## Development

```bash
npm test                            # unit tests (node:test)
node test/e2e/e2e.cjs <empty-dir>   # end-to-end check in a throwaway sandbox (needs Java)
windows/deploy-to-mc-pc.sh          # deploy to the Windows host over SSH
```
