import fs from 'node:fs/promises';
import { closeDb, runMigrations } from '../src/db.js';
import { pingBlueBubbles } from '../src/services/bluebubbles.js';
import { createJobFromImage, processJobOcr, saveIncomingImage } from '../src/services/jobs.js';

const sampleImage = process.argv[2] || '/tmp/codex-web-uploads-Pe11M3/fe1ac0c7-b2ed-443a-b2cf-a37cef949dd1';

function assert(value, message) {
  if (!value) throw new Error(message);
}

try {
  await fs.access(sampleImage);
  await runMigrations();

  const buffer = await fs.readFile(sampleImage);
  const imagePath = await saveIncomingImage(buffer, 'sample-job.jpg');
  const created = await createJobFromImage({
    source: 'manual',
    imagePath,
    imageMime: 'image/jpeg'
  });
  const job = await processJobOcr(created.id);

  assert(job.customerName === 'Martha Aiello', `Unexpected name: ${job.customerName}`);
  assert(job.normalizedPhone === '+16309629082', `Unexpected phone: ${job.normalizedPhone}`);
  assert(job.accountNumber === '8771201800088993', `Unexpected account: ${job.accountNumber}`);
  assert(job.address === '1115 Adler Ln, Carol Stream, IL 60188-1333', `Unexpected address: ${job.address}`);

  console.log('Smoke test job created:', job.id);
  console.log('OCR fields:', {
    customerName: job.customerName,
    normalizedPhone: job.normalizedPhone,
    accountNumber: job.accountNumber,
    address: job.address,
    status: job.status,
    followupStatus: job.followupStatus
  });

  if (process.env.TEST_BLUEBUBBLES_PING === 'true') {
    const ping = await pingBlueBubbles();
    console.log('BlueBubbles ping:', ping.message || ping.status || 'ok');
  }
} finally {
  await closeDb();
}
