#!/bin/bash

# Burst test for Infura rate limiting
# Tests 32 consecutive eth_getLogs calls to see if they slow down or timeout

INFURA_KEY=$1
if [ -z "$INFURA_KEY" ]; then
  echo "Usage: $0 <infura_key>"
  exit 1
fi

echo "Testing 32 consecutive eth_getLogs calls..."
echo "Key: ${INFURA_KEY:0:8}..."
echo ""

V3_FACTORY="0x33128a8fC17869897dcE68Ed026d694621f6FDfD"
FROM_BLOCK="0x304a5cb"
TO_BLOCK="0x304a5d5"

success_count=0
slow_count=0
timeout_count=0
total_time=0

for i in {1..32}; do
  start=$(date +%s%N)
  
  response=$(curl -s -X POST "https://base-mainnet.infura.io/v3/$INFURA_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getLogs\",\"params\":[{\"fromBlock\":\"$FROM_BLOCK\",\"toBlock\":\"$TO_BLOCK\",\"address\":\"$V3_FACTORY\"}],\"id\":$i}" \
    --max-time 10)
  
  end=$(date +%s%N)
  duration_ms=$(( (end - start) / 1000000 ))
  total_time=$((total_time + duration_ms))
  
  if [ $duration_ms -gt 2000 ]; then
    echo "[$i/32] SLOW: ${duration_ms}ms"
    slow_count=$((slow_count + 1))
  elif echo "$response" | grep -q "error"; then
    echo "[$i/32] ERROR: ${duration_ms}ms - $(echo $response | jq -r '.error.message' 2>/dev/null || echo 'parse error')"
    timeout_count=$((timeout_count + 1))
  else
    echo "[$i/32] OK: ${duration_ms}ms"
    success_count=$((success_count + 1))
  fi
  
  # Small delay between requests to be somewhat realistic
  sleep 0.1
done

echo ""
echo "=== RESULTS ==="
echo "Successful: $success_count/32"
echo "Slow (>2s): $slow_count/32"  
echo "Errors: $timeout_count/32"
echo "Total time: ${total_time}ms"
echo "Average per request: $((total_time / 32))ms"

if [ $slow_count -gt 5 ] || [ $timeout_count -gt 0 ]; then
  echo "⚠️  Signs of rate limiting detected"
  exit 1
else
  echo "✅ No rate limiting detected"
  exit 0
fi
