# Dockerfile
# This file defines the custom environment for your Render service.

# 1. Start with a Node.js base image
FROM node:18-slim

# 2. Set the working directory inside the container
WORKDIR /usr/src/app

# 3. Install necessary dependencies for ffmpeg, yt-dlp, and git
# Added 'ca-certificates' to ensure SSL certificates are trusted
RUN apt-get update && apt-get install -y \
    ffmpeg \
    git \
    wget \
    python3 \
    ca-certificates \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# 4. Install yt-dlp globally
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# 5. Copy your package.json and package-lock.json
COPY package*.json ./

# 6. Install your Node.js app's dependencies
# We specify an older version of uuid that is compatible with require()
RUN npm install uuid@8.3.2
RUN npm install --production

# 7. Copy the rest of your application code
COPY . .

# 8. Expose the port your app runs on
EXPOSE 4000

# 9. Define the command to run your app (using app.js as requested)
CMD ["node", "app.js"]

