import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { config } from '../config.js';
import { normalizePhone } from '../utils/phone.js';

function cleanLine(line) {
  return line
    .replace(/[|\u2022]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeOcrText(text) {
  return text
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\r/g, '\n');
}

async function cropToTemp(imagePath, rect, label, targetWidth = 1400) {
  const metadata = await sharp(imagePath).metadata();
  const width = metadata.width || 1;
  const height = metadata.height || 1;
  const extract = {
    left: Math.max(0, Math.round(width * rect.left)),
    top: Math.max(0, Math.round(height * rect.top)),
    width: Math.min(width, Math.round(width * rect.width)),
    height: Math.min(height, Math.round(height * rect.height))
  };
  extract.width = Math.min(extract.width, width - extract.left);
  extract.height = Math.min(extract.height, height - extract.top);

  const output = path.join(os.tmpdir(), `ftr-ocr-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
  await sharp(imagePath)
    .extract(extract)
    .grayscale()
    .normalize()
    .resize({ width: Math.max(targetWidth, extract.width * 2), withoutEnlargement: false })
    .sharpen()
    .png()
    .toFile(output);
  return output;
}

async function recognizeImage(worker, imagePath) {
  const result = await worker.recognize(imagePath);
  return {
    text: normalizeOcrText(result.data.text || ''),
    confidence: result.data.confidence || 0
  };
}

function extractAccount(text) {
  const normalized = text.replace(/[Oo]/g, '0').replace(/[Il]/g, '1');
  const explicit = normalized.match(/Account\s*#?\s*:?\s*([0-9][0-9\s-]{7,})/i);
  if (explicit) return explicit[1].replace(/\D/g, '');

  const longNumber = normalized.match(/\b\d{10,18}\b/);
  return longNumber ? longNumber[0] : '';
}

function extractPhones(text) {
  const matches = [
    ...text.matchAll(/(?:\+?1[\s.-]*)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}/g)
  ].map((match) => match[0]);
  return [...new Set(matches)].map((phone) => normalizePhone(phone)).filter(Boolean);
}

function extractName(lines, text) {
  const legalIndex = lines.findIndex((line) => /^Legal Name\b/i.test(line));
  if (legalIndex >= 0) {
    const sameLine = lines[legalIndex].replace(/^Legal Name\s*/i, '').trim();
    if (sameLine && !/^Call First|Primary|Email/i.test(sameLine)) return sameLine;
    if (lines[legalIndex + 1]) return lines[legalIndex + 1];
  }

  const explicit = text.match(/Legal Name\s+([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,3})/i);
  if (explicit) return cleanLine(explicit[1]);

  const stopWords = /^(Details|Health|History|Job|Dwelling|Drop|Hookup|Account|Diamond|Legal|Call|Primary|Email|Plant|Node|Home|Search|Inventory|Tasking)/i;
  return (
    lines.find((line) => {
      if (stopWords.test(line)) return false;
      if (/\d/.test(line)) return false;
      return /^[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,3}$/.test(line);
    }) || ''
  );
}

function extractAddress(lines) {
  const streetSuffix =
    /\b(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Cir|Circle|Way|Pl|Place|Pkwy|Parkway|Ter|Terrace)\b/i;
  const cityStateZip = /\b[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\d{1,6}\s+/.test(line) && streetSuffix.test(line)) {
      const next = lines[index + 1] || '';
      if (cityStateZip.test(next)) return `${line.replace(/,$/, '')}, ${next}`;
      return line;
    }
  }

  const combined = lines.join(' ');
  const match = combined.match(
    /(\d{1,6}\s+[A-Za-z0-9 .'-]+?\b(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Cir|Circle|Way|Pl|Place|Pkwy|Parkway|Ter|Terrace)\b,?\s+[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)/i
  );
  return match ? cleanLine(match[1]) : '';
}

export function parseJobFields(text) {
  const normalized = normalizeOcrText(text);
  const lines = normalized
    .split('\n')
    .map(cleanLine)
    .filter(Boolean);

  const phones = extractPhones(normalized);
  const contactPhone =
    phones.find((phone) => {
      const line = lines.find((candidate) => candidate.includes(phone.slice(-4)));
      return line && /Call First|Primary/i.test(line);
    }) || phones[0] || '';

  return {
    customerName: extractName(lines, normalized),
    phone: contactPhone,
    accountNumber: extractAccount(normalized),
    address: extractAddress(lines)
  };
}

export async function extractJobFromImage(imagePath) {
  await fs.access(imagePath);
  const tesseractCachePath = path.join(config.dataDir, 'tesseract');
  await fs.mkdir(tesseractCachePath, { recursive: true });

  const crops = [
    { label: 'customer-header', rect: { left: 0, top: 0.2, width: 0.85, height: 0.08 }, width: 2400 },
    { label: 'details', rect: { left: 0, top: 0.17, width: 1, height: 0.29 } },
    { label: 'account', rect: { left: 0, top: 0.43, width: 1, height: 0.16 } },
    { label: 'contact', rect: { left: 0, top: 0.56, width: 1, height: 0.27 } },
    { label: 'full', rect: { left: 0, top: 0.15, width: 1, height: 0.74 } }
  ];

  const tempFiles = [];
  const worker = await createWorker('eng', undefined, { cachePath: tesseractCachePath });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
    const recognized = [];
    for (const crop of crops) {
      const tempFile = await cropToTemp(imagePath, crop.rect, crop.label, crop.width);
      tempFiles.push(tempFile);
      const result = await recognizeImage(worker, tempFile);
      recognized.push({ label: crop.label, ...result });
    }

    const text = recognized.map((entry) => `--- ${entry.label} ---\n${entry.text}`).join('\n');
    const parsed = parseJobFields(text);
    const confidence =
      recognized.reduce((sum, entry) => sum + Number(entry.confidence || 0), 0) / Math.max(recognized.length, 1);

    return {
      ...parsed,
      ocrText: text,
      ocrConfidence: confidence,
      raw: { crops: recognized }
    };
  } finally {
    await worker.terminate();
    await Promise.all(tempFiles.map((file) => fs.unlink(file).catch(() => undefined)));
  }
}
