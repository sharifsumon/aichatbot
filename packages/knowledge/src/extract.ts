import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { extractText as extractPdfText } from 'unpdf';
import { chunkLines, chunkText } from './chunk.ts';

export type FileKind = 'pdf' | 'xlsx' | 'csv' | 'txt';

/** A problem with the source itself; the message is shown to the shop owner. Not worth retrying. */
export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractError';
  }
}

export function fileKind(fileName: string): FileKind {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'pdf' || ext === 'xlsx' || ext === 'csv' || ext === 'txt') return ext;
  throw new ExtractError(`Unsupported file type .${ext}. Use PDF, XLSX, CSV or TXT.`);
}

/** Reads an uploaded file and returns chunks ready to embed. */
export async function chunkFile(bytes: Uint8Array, fileName: string): Promise<string[]> {
  const kind = fileKind(fileName);
  switch (kind) {
    case 'pdf': {
      let text: string;
      try {
        ({ text } = await extractPdfText(new Uint8Array(bytes), { mergePages: true }));
      } catch (err) {
        throw new ExtractError(`Could not read the PDF: ${(err as Error).message}`);
      }
      // Scanned PDFs have images, not text; they need OCR, which we don't do yet.
      if (text.trim().length < 20) throw new ExtractError('The PDF has no readable text (is it a scan?).');
      return chunkText(text);
    }
    case 'xlsx':
      return chunkLines(await xlsxRows(bytes));
    case 'csv':
      return chunkLines(csvRows(new TextDecoder().decode(bytes)));
    case 'txt':
      return chunkText(new TextDecoder().decode(bytes));
  }
}

/** CSV text (an upload, or a Google Sheet exported as CSV) to chunks. */
export function chunkCsv(text: string): string[] {
  return chunkLines(csvRows(text));
}

/**
 * Tables become one line per row, each value labelled with its column
 * ("Name: Cotton Shirt; Price: 850"), so a retrieved chunk makes sense alone.
 */
function rowsToLines(header: string[], rows: string[][]): string[] {
  return rows
    .map((row) =>
      row
        .map((cell, i) => (cell.trim() ? `${header[i]?.trim() || `Column ${i + 1}`}: ${cell.trim()}` : ''))
        .filter(Boolean)
        .join('; '),
    )
    .filter(Boolean);
}

function csvRows(text: string): string[] {
  const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: true });
  const [header, ...rows] = parsed.data;
  if (!header) return [];
  return rowsToLines(header, rows);
}

async function xlsxRows(bytes: Uint8Array): Promise<string[]> {
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch (err) {
    throw new ExtractError(`Could not read the spreadsheet: ${(err as Error).message}`);
  }
  const lines: string[] = [];
  book.eachSheet((sheet) => {
    const table: string[][] = [];
    sheet.eachRow((row) => {
      const values = (row.values as unknown[]).slice(1).map(cellText);
      table.push(values);
    });
    const [header, ...rows] = table;
    if (header) lines.push(...rowsToLines(header, rows).map((l) => (book.worksheets.length > 1 ? `${sheet.name}: ${l}` : l)));
  });
  return lines;
}

function cellText(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v = value as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text) return v.text;
    if (v.result != null) return String(v.result);
    return '';
  }
  return String(value);
}

/** Turns a Google Sheet link into its CSV export URL (the sheet must be shared "anyone with the link"). */
export function googleSheetCsvUrl(url: string): string {
  const id = url.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1];
  if (!id) throw new ExtractError('That is not a Google Sheets link.');
  const gid = url.match(/[#&?]gid=(\d+)/)?.[1];
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
}
