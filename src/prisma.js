import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__ftrFixPrismaClient ||
  new PrismaClient({
    log: process.env.PRISMA_QUERY_LOG === 'true' ? ['query', 'info', 'warn', 'error'] : ['warn', 'error']
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__ftrFixPrismaClient = prisma;
}
