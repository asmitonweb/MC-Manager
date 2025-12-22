#!/bin/bash

# Exit on error
set -e

echo "Updating system..."
sudo apt-get update && sudo apt-get upgrade -y

echo "Installing curl, wget, unzip, git..."
sudo apt-get install -y curl wget unzip git build-essential

echo "Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "Installing Java 21 (OpenJDK)..."
sudo apt-get install -y openjdk-21-jdk

echo "Installing PM2 globally..."
sudo npm install -g pm2

echo "Installing Nginx & Certbot..."
sudo apt-get install -y nginx certbot python3-certbot-nginx

echo "Verifying versions..."
node -v
java -version
nginx -v

echo "Installing project dependencies..."
npm install

echo "Setup complete! Please configure .env and start the server with 'pm2 start server.js --name mc-manager'"
