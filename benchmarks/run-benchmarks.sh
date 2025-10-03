#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if a port is in use
check_port() {
    local port=$1
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
        return 0  # Port is in use
    else
        return 1  # Port is free
    fi
}

# Function to wait for a service to be ready
wait_for_service() {
    local url=$1
    local service_name=$2
    local max_attempts=30
    local attempt=1

    print_status "Waiting for $service_name to be ready..."
    
    while [ $attempt -le $max_attempts ]; do
        if curl -s -f "$url" > /dev/null 2>&1; then
            print_success "$service_name is ready!"
            return 0
        fi
        
        echo -n "."
        sleep 1
        attempt=$((attempt + 1))
    done
    
    print_error "$service_name failed to start after $max_attempts seconds"
    return 1
}

# Function to cleanup background processes
cleanup() {
    print_status "Cleaning up background processes..."
    
    # Kill backend server if we started it
    if [ ! -z "$BACKEND_PID" ]; then
        kill $BACKEND_PID 2>/dev/null || true
        print_status "Stopped backend server (PID: $BACKEND_PID)"
    fi
    
    # Kill any remaining Node.js processes for our servers
    pkill -f "example/server.js" 2>/dev/null || true
    pkill -f "benchmarks/proxy-server.js" 2>/dev/null || true
    
    print_status "Cleanup completed"
}

# Set up trap to cleanup on script exit
trap cleanup EXIT

print_status "🚀 Starting Undici Cache Redis Benchmarks"
echo "========================================"

# Check prerequisites
print_status "Checking prerequisites..."

# Check if Node.js is available
if ! node --version > /dev/null 2>&1; then
    print_error "Node.js is not installed or not in PATH"
    exit 1
fi

# Check if npm dependencies are installed
if [ ! -d "node_modules" ]; then
    print_error "Dependencies not installed. Run 'npm install' first."
    exit 1
fi

# Check Redis/Valkey connection
print_status "Checking Redis/Valkey connection..."
if ! node -e "
const { createClient } = require('iovalkey');
const client = createClient({ 
    host: 'localhost', 
    port: 6379,
    connectTimeout: 5000,
    lazyConnect: true
});

client.on('error', (err) => {
    console.error('Redis connection error:', err.message);
    process.exit(1);
});

(async () => {
    try {
        await client.connect();
        const result = await client.ping();
        console.log('Redis/Valkey connection successful');
        await client.disconnect();
    } catch (err) {
        console.error('Redis connection failed:', err.message);
        process.exit(1);
    }
})();
" 2>/dev/null; then
    print_error "Cannot connect to Redis/Valkey on localhost:6379"
    print_warning "Please start Redis/Valkey first:"
    print_warning "  docker run -d -p 6379:6379 redis:alpine"
    print_warning "  # or"
    print_warning "  npm run valkey"
    exit 1
fi

print_success "Redis/Valkey connection verified"

# Check if backend server is already running
BACKEND_PID=""
if check_port 3000; then
    print_warning "Backend server already running on port 3000"
    print_status "Using existing backend server"
else
    print_status "Starting backend API server..."
    npm run example:server > /tmp/backend.log 2>&1 &
    BACKEND_PID=$!
    
    # Wait for backend to be ready
    if ! wait_for_service "http://localhost:3000/health" "Backend API server"; then
        print_error "Failed to start backend server. Check /tmp/backend.log for details"
        exit 1
    fi
fi

# Run benchmarks
print_status "Running benchmarks..."
echo ""

# Run the main benchmark suite
if node benchmarks/run-proxy-benchmarks.js; then
    print_success "Benchmarks completed successfully!"
else
    print_error "Benchmarks failed!"
    exit 1
fi

print_success "🎉 All benchmarks completed!"
echo ""
print_status "To run individual benchmarks manually:"
print_status "  node benchmarks/bench-proxy-no-cache.js              # No cache baseline"
print_status "  node benchmarks/bench-proxy-memory-cache.js          # Memory cache"
print_status "  node benchmarks/bench-proxy-redis-cache-only.js      # Redis cache"
print_status "  node benchmarks/bench-proxy-redis-cache-tracking.js  # Redis cache with tracking"