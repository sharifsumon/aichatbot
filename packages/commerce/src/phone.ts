/**
 * Normalises a Bangladeshi mobile number to 01XXXXXXXXX, or returns null.
 * Accepts +880, 880 and 0 prefixes, spaces and dashes, and Bangla digits.
 */
export function normaliseBdPhone(input: string): string | null {
  const ascii = input.replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - 0x09e6));
  const digits = ascii.replace(/[^\d]/g, '');
  const local = digits.startsWith('880') ? `0${digits.slice(3)}` : digits;
  return /^01[3-9]\d{8}$/.test(local) ? local : null;
}
