/**
 * start-all.ts — Start all processes for the watchdog-tweet project
 *
 * This script runs:
 * 1. Backend API server (port 3001)
 * 2. Frontend dev server (port 3000)
 * 3. Telegram bot (sniper bot)
 * 4. Watch-analysis script (optional, requires analysis ID)
 *
 * Usage:
 *   npx tsx start-all.ts [analysisId]
 *
 * Example:
 *   npx tsx start-all.ts
 *   npx tsx start-all.ts 1787387514392-B2000000
 */

import { spawn } from "child_process";
import * as path from "path";

const analysisId = process.argv[2]; // Optional analysis ID for watch-analysis

interface ProcessConfig {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  color: string;
}

const processes: ProcessConfig[] = [
  {
    name: "Backend Server",
    command: "npm",
    args: ["run", "server"],
    color: "\x1b[36m", // Cyan
  },
  {
    name: "Frontend Dev Server",
    command: "npm",
    args: ["run", "dev"],
    cwd: path.join(process.cwd(), "frontend"),
    color: "\x1b[32m", // Green
  },
  {
    name: "Telegram Bot",
    command: "npm",
    args: ["run", "telegram-bot"],
    color: "\x1b[33m", // Yellow
  },
];

// Add watch-analysis if analysis ID is provided
if (analysisId) {
  processes.push({
    name: "Watch Analysis",
    command: "npm",
    args: ["run", "watch-analysis", "--", analysisId, "30"],
    color: "\x1b[35m", // Magenta
  });
}

// Add watch-analysis if analysis ID is provided
if (analysisId) {
  processes.push({
    name: "Watch Analysis",
    command: "npm",
    args: ["run", "watch-analysis", "--", analysisId, "30"],
    color: "\x1b[35m", // Magenta
  });
}

const resetColor = "\x1b[0m";

function startProcess(config: ProcessConfig) {
  const cwd = config.cwd || process.cwd();
  console.log(`${config.color}[${config.name}]${resetColor} Starting in ${cwd}...`);

  const child = spawn(config.command, config.args, {
    cwd,
    stdio: "inherit",
    shell: true,
  });

  child.on("error", (err) => {
    console.error(`${config.color}[${config.name}]${resetColor} Failed to start:`, err);
  });

  child.on("exit", (code) => {
    if (code !== 0) {
      console.error(`${config.color}[${config.name}]${resetColor} Exited with code ${code}`);
    } else {
      console.log(`${config.color}[${config.name}]${resetColor} Exited normally`);
    }
  });

  return child;
}

console.log("\n" + "=".repeat(66));
console.log("  Starting All Processes");
console.log("=".repeat(66) + "\n");

const children = processes.map((config) => startProcess(config));

console.log("\n" + "=".repeat(66));
console.log("  All processes started");
console.log("=".repeat(66));
console.log("\nProcess Status:");
processes.forEach((config, i) => {
  console.log(`${config.color}●${resetColor} ${config.name}`);
});
console.log("\nPress Ctrl+C to stop all processes\n");

// Handle cleanup on exit
process.on("SIGINT", () => {
  console.log("\n\nStopping all processes...");
  children.forEach((child) => {
    child.kill("SIGTERM");
  });
  setTimeout(() => {
    console.log("All processes stopped");
    process.exit(0);
  }, 2000);
});

process.on("SIGTERM", () => {
  console.log("\n\nStopping all processes...");
  children.forEach((child) => {
    child.kill("SIGTERM");
  });
  setTimeout(() => {
    console.log("All processes stopped");
    process.exit(0);
  }, 2000);
});