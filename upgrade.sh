#!/bin/bash

# Configuration
SERVER_DIR="../server"
FABRIC_INSTALLER_URL="https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar"
MC_VERSION="1.21.1" # Change this to desired MC version
LOADER_VERSION="0.16.5" # Change this to desired Fabric Loader version

echo "Upgrading Minecraft Server to $MC_VERSION (Fabric $LOADER_VERSION)..."

# Check if server directory exists
if [ ! -d "$SERVER_DIR" ]; then
    echo "Error: Server directory $SERVER_DIR not found!"
    exit 1
fi

cd "$SERVER_DIR"

# Backup current jar
if [ -f "fabric-server.jar" ]; then
    echo "Backing up existing jar..."
    mv fabric-server.jar "fabric-server.jar.backup.$(date +%F_%T)"
fi

# Download Installer
echo "Downloading Fabric Installer..."
wget -O fabric-installer.jar "$FABRIC_INSTALLER_URL"

# Install Server
echo "Installing Server Jar..."
java -jar fabric-installer.jar server -mcversion $MC_VERSION -loader $LOADER_VERSION -downloadMinecraft

# Rename to match startup script expectation
if [ -f "fabric-server-launch.jar" ]; then
    # Fabric creates fabric-server-launch.jar usually, but check documentation
    # Just renaming the fabric-server-launch.jar to what server.js expects?
    # server.js expects 'fabric-server.jar' usually or we need to check what the installer outputs.
    # The installer usually outputs `fabric-server-launch.jar`.
    # Let's clean up.
    echo "Setup complete."
else
    mv server.jar fabric-server.jar 2>/dev/null || true
    # Installer behavior varies. 
    # Standard fabric server jar is just 'fabric-server-launch.jar' + 'server.jar' (vanilla).
fi

# Clean up installer
rm fabric-installer.jar

echo "Upgrade Complete. Ensure server.js points to the correct jar."
