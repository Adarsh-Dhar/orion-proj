#!/bin/bash

# Start dev server and localtunnel for RugHound project

PORT=8080

echo "Starting RugHound Server and Tunnel..."
echo "=============================================="

# Kill any existing process on the port
if lsof -ti:$PORT > /dev/null 2>&1; then
    echo "Killing existing process on port $PORT..."
    lsof -ti:$PORT | xargs kill -9
    sleep 1
fi

# Start the dev server in background
npm run server &
SERVER_PID=$!
echo "✓ Dev server started (PID: $SERVER_PID)"

# Wait a moment for server to start
sleep 3

# Start localtunnel
echo "Starting localtunnel..."
npm run tunnel &
TUNNEL_PID=$!
echo "✓ LocalTunnel started (PID: $TUNNEL_PID)"

echo ""
echo "=============================================="
echo "Your tunnel is running!"
echo "Press Ctrl+C to stop both server and tunnel"
echo "=============================================="

# Handle cleanup on exit
trap "kill $SERVER_PID $TUNNEL_PID 2>/dev/null; echo 'Stopped server and tunnel'" EXIT

# Wait for both processes
wait