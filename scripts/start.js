import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const prismaCli = path.join(rootDir, 'node_modules', 'prisma', 'build', 'index.js');
const initialMigration = '20260904000000_init';
const prismaEnv = { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: process.env.PRISMA_HIDE_UPDATE_MESSAGE || '1' };

function runPrisma(args) {
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: rootDir,
    env: prismaEnv,
    encoding: 'utf8'
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error) throw result.error;
  return result;
}

function runPrismaCommand(args) {
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: rootDir,
    env: prismaEnv,
    stdio: 'inherit'
  });

  if (result.error) throw result.error;
  return result.status || 0;
}

function runPrismaMigrations() {
  if (process.env.SKIP_PRISMA_MIGRATE === 'true') {
    console.log('[start] skipping Prisma migrate deploy because SKIP_PRISMA_MIGRATE=true');
    return;
  }

  console.log('[start] running Prisma migrate deploy');
  let result = runPrisma(['migrate', 'deploy']);
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;

  if (result.status !== 0 && output.includes('P3005') && process.env.PRISMA_BASELINE_EXISTING_DB !== 'false') {
    console.log(`[start] existing non-empty database detected; baselining ${initialMigration}`);
    const baselineStatus = runPrismaCommand(['migrate', 'resolve', '--applied', initialMigration]);
    if (baselineStatus !== 0) process.exit(baselineStatus);
    console.log('[start] retrying Prisma migrate deploy');
    result = runPrisma(['migrate', 'deploy']);
  }

  if (result.status !== 0) process.exit(result.status || 1);
}

function startServer() {
  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit'
  });

  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      server.kill(signal);
    });
  }

  server.on('exit', (code, signal) => {
    if (signal && shuttingDown) process.exit(0);
    process.exit(code ?? 1);
  });
}

runPrismaMigrations();
if (process.argv.includes('--migrate-only')) process.exit(0);
startServer();
