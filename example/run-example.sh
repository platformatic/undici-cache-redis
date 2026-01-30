#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Undici Redis Cache Example ===${NC}"
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}Error: Docker is not running. Please start Docker first.${NC}"
    exit 1
fi

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed.${NC}"
    exit 1
fi

# Check Node version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}Error: Node.js version must be >= 18.0.0${NC}"
    exit 1
fi

echo -e "${YELLOW}Starting Redis/Valkey container...${NC}"
docker-compose up -d

# Wait for Redis to be ready
echo -e "${YELLOW}Waiting for Redis to be ready...${NC}"
for i in {1..30}; do
    if docker exec cache-redis-example valkey-cli ping > /dev/null 2>&1; then
        echo -e "${GREEN}Redis is ready!${NC}"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}Error: Redis failed to start${NC}"
        exit 1
    fi
    sleep 1
done

# Install dependencies if needed
if [ ! -d "../node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    (cd .. && npm install)
fi

# Start the server in background
echo -e "${YELLOW}Starting API server...${NC}"
node server.ts &
SERVER_PID=$!

# Wait for server to start
sleep 2

# Check if server is running
if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo -e "${RED}Error: Server failed to start${NC}"
    docker-compose down
    exit 1
fi

echo -e "${GREEN}Server started on http://localhost:3000${NC}"
echo ""

# Run the client demonstration
echo -e "${YELLOW}Running cache demonstration...${NC}"
echo ""
node client.ts

# Cleanup
echo ""
echo -e "${YELLOW}Cleaning up...${NC}"
kill $SERVER_PID 2>/dev/null
docker-compose down

echo -e "${GREEN}Example completed!${NC}"