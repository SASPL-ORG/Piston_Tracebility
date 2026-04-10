# Piston Traceability - Client Installation Guide

## Prerequisites

1. **Docker Desktop** - Must be installed and running
   - Download from: https://www.docker.com/products/docker-desktop
   - Install and start Docker Desktop
   - Wait until Docker Desktop is fully running (check system tray)

2. **MS SQL Server** - Database must be accessible

## Installation Steps

1. **Extract the package** to a folder on your server
   - Example: `C:\Piston_Traceability\`

2. **Configure database connection:**
   - Copy `env.template` to `.env`
   - Edit `.env` file with your database credentials:
     - `DB_HOST` - Your SQL Server hostname or IP
     - `DB_PORT` - SQL Server port (usually 1433)
     - `DB_NAME` - Database name
     - `DB_USER` - Database username
     - `DB_PASSWORD` - Database password

   **For Windows:** Use `host.docker.internal\INSTANCE_NAME` for DB_HOST
   **For Linux:** Use the actual IP address or hostname

3. **Configure CV-X Image Folder (Important):**
   - Create a Windows shared folder (e.g., `D:\TraceabilityData\incoming`)
   - Share it on the network (e.g., `\\APP-PC\trace_images`)
   - Configure CV-X VisionEditor to save images to this shared folder
   - Update `INCOMING_IMAGES_PATH` in `.env` if using a different path

4. **Load Docker images:**
   - Double-click `load-images.bat`
   - Wait for images to load (this may take a few minutes)

5. **Start the application:**
   - Double-click `start.bat`
   - Wait for containers to start

6. **Access the application:**
   - Open browser: `http://localhost:8080`
   - Or from network: `http://YOUR_SERVER_IP:8080`

## Stopping the Application

- Double-click `stop.bat`

## Network Access Setup

To allow clients to access via IP address:

1. **Find your server IP:**
   - Open Command Prompt
   - Run: `ipconfig`
   - Note the IPv4 Address (e.g., 192.168.1.100)

2. **Configure Windows Firewall:**
   - Open Windows Defender Firewall
   - Allow port 8080 (or 80 if changed)
   - Block port 3000 (backend should not be accessible)

3. **Clients access:**
   - `http://YOUR_SERVER_IP:8080`

## Security

- **Backend API is NOT directly accessible** from network
- Only nginx port (8080) is exposed
- All API calls go through nginx reverse proxy
- Clients can only access the web UI

## CV-X Camera Setup

The application uses a folder watcher to receive images from CV-X controllers:

1. **Create Windows Shared Folder:**
   - Create folder: `D:\TraceabilityData\incoming` (or your preferred location)
   - Right-click → Properties → Sharing
   - Share as: `\\APP-PC\trace_images` (use your PC name)
   - Give Full access (read/write)

2. **Configure CV-X VisionEditor:**
   - Go to: `[Output] → [Image Save]` or `[FTP/Network Output]`
   - Set output type: **Shared folder (SMB)**
   - Path: `\\APP-PC\trace_images` (match your share name)
   - Username/password: Windows PC credentials
   - Enable: ☑ Save image

3. **File Naming Format:**
   - Ring camera: `{SERIAL}_RING_{ATTEMPT}_{PICNO}.jpg` (e.g., `PST1001_RING_02_01.jpg`)
   - Circlip camera: `{SERIAL}_CIRCLIP_00_{PICNO}.jpg` (e.g., `PST1001_CIRCLIP_00_01.jpg`)

## Troubleshooting

### Port already in use
- Change nginx port in `docker-compose.yml`: `"8081:80"`

### Database connection errors
- Check `.env` file has correct credentials
- Verify SQL Server is accessible from Docker
- For Windows: Use `host.docker.internal` as hostname

### Application not accessible
- Check Docker containers: `docker ps`
- Check logs: `docker-compose logs`
- Verify firewall allows port 8080

### Images not appearing
- Verify CV-X is saving images to the shared folder
- Check `data/incoming` folder has files
- Verify folder watcher configuration in `.env`
- Check image-service logs: `docker-compose logs image-service`

## Support

For issues, contact your system administrator.
