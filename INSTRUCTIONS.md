# Deployment Instructions for Azure Ubuntu VM

> The active host is Windows. Use `..\WINDOWS_SETUP.md` and `..\tray\README.md` for the current deployment. The instructions below describe the original Azure/Linux deployment and are retained for reference.

## Prerequisites
1.  **Azure VM**: Ubuntu 20.04 or 22.04 LTS.
2.  **SSH Access**: You must be able to SSH into your VM.
3.  **Ports**: Ensure the following ports are open in Azure Networking (NSG):
    -   `22` (SSH)
    -   `80` (HTTP - **Required** for initial SSL creation & auto-redirect to HTTPS)
    -   `443` (HTTPS - optional if you set up SSL)
    -   `25565` (Minecraft Server)

## Step 1: Transfer Files
### Option A: Using GitHub (Recommended for Manager Code)
1.  Initialize a git repo in `MC Manager for Minecraft`:
    ```bash
    git init
    git add .
    git commit -m "Initial commit"
    ```
2.  Create a private repo on GitHub.
3.  Push: `git remote add origin <URL> && git push -u origin master`
4.  On Azure VM: `git clone <URL> mc-manager`

**Note**: Do **NOT** put your massive `server` folder (or world data) in GitHub. Use Option B for that.

### Option B: SCP / SFTP (Required for World Data)
Use `scp` to upload the `server` folder and/or the manager code.

**Example SCP command:**
```powershell
scp -r "C:\Minecraft Server\Minecraft Server 1.21.8\MC Manager for Minecraft" azureuser@<YOUR_VM_IP>:/home/azureuser/mc-manager
```

## Step 2: Environment Setup
1.  SSH into your VM: `ssh azureuser@<YOUR_VM_IP>`
2.  Navigate to the folder: `cd mc-manager`
3.  Make the setup script executable: `chmod +x setup.sh`
4.  Run the setup script: `./setup.sh`

This script will install Node.js 20, Java 21, PM2, and Nginx.

## Step 3: Configure Manager
1.  Edit the `.env` file: `nano .env`
2.  Update `ADMIN_PASSWORD` and `USER_PASSWORD`.
3.  Set `RCON_HOST=localhost` and `RCON_PORT=25575` (ensure matches `server.properties`).
4.  Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X`).

## Step 4: Configure DNS (Namecheap)
1.  Log in to Namecheap.
2.  Go to **Advanced DNS** for your domain.
3.  Add an **A Record**:
    -   **Host**: `@` (or a subdomain like `mc`)
    -   **Value**: `<YOUR_Azure_VM_Public_IP>`
    -   **TTL**: Automatic
4.  Wait a few minutes for propagation.

## Step 5: Configure Nginx (Reverse Proxy)
1.  Edit the Nginx config: `nano nginx_manager.conf`
2.  Replace `YOUR_DOMAIN_HERE` with your actual domain name (e.g., `mc.yourdomain.com`).
3.  Copy it to Nginx sites: `sudo cp nginx_manager.conf /etc/nginx/sites-available/mc-manager`
4.  Enable it: `sudo ln -s /etc/nginx/sites-available/mc-manager /etc/nginx/sites-enabled/`
5.  Test config: `sudo nginx -t`
6.  Restart Nginx: `sudo systemctl restart nginx`

## Step 6: Enable HTTPS (SSL)
Run the following cmd to auto-configure SSL:
```bash
sudo certbot --nginx -d YOUR_DOMAIN_HERE
```
-   Follow the prompts.
-   Select option **2** (Redirect) if asked, to force HTTPS.
-   Certbot will automatically update your Nginx config.

## Step 7: Transfer Minecraft World & Server
1.  Upload your `server` folder (containing `world`, `server.properties`, etc.) to `/home/azureuser/server`.
    - **Note**: The manager expects the server folder to be at `../server` relative to the manager folder.
    - If you uploaded manager to `~/mc-manager`, put server at `~/server`.
2.  Ensure `server.properties` has `enable-rcon=true`, `rcon.port=25575`, and `rcon.password` matches your `.env`.

## Step 8: Start Manager
1.  Go to manager folder: `cd ~/mc-manager`
2.  Start with PM2: `pm2 start server.js --name mc-manager`
3.  Save PM2 list: `pm2 save`
4.  Setup startup hook: `pm2 startup` (run the command it gives you).

## Step 9: Access
-   **Web UI**: `https://<YOUR_DOMAIN>` (Secure HTTPS)
-   **Minecraft**: `<YOUR_DOMAIN>:25565`
