export type ReplyLanguage = 'bn' | 'banglish' | 'en';

// Common Bangla words written in Latin letters. Two or more hits means Banglish.
const BANGLISH_WORDS = new Set([
  'ami', 'apni', 'apnar', 'tumi', 'koto', 'dam', 'ache', 'ase', 'achhe', 'chai', 'lagbe', 'kivabe', 'kemne',
  'vai', 'bhai', 'apu', 'ki', 'na', 'hobe', 'hoibo', 'din', 'taka', 'koren', 'korbo', 'dite', 'diben',
  'deliveri', 'pathan', 'kobe', 'kothay', 'size', 'colour', 'ta', 'ti', 'er', 'theke', 'jabe', 'nibo', 'nite',
]);

/** Picks the language to answer in: Bangla script, Banglish (Bangla in Latin letters) or English. */
export function detectLanguage(text: string): ReplyLanguage {
  const bangla = (text.match(/[ঀ-৿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (bangla > 0 && bangla >= latin) return 'bn';
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const hits = words.filter((w) => BANGLISH_WORDS.has(w)).length;
  return hits >= 2 || (words.length > 0 && hits / words.length >= 0.3) ? 'banglish' : 'en';
}

export const FALLBACK_REPLY: Record<ReplyLanguage, string> = {
  bn: 'ধন্যবাদ! আমাদের একজন প্রতিনিধি শীঘ্রই আপনাকে উত্তর দেবেন।',
  banglish: 'Thank you! Amader ekjon team member khub shiggiri apnake reply dibe.',
  en: 'Thanks! A team member will reply to you shortly.',
};

export const SENT_TO_INBOX: Record<ReplyLanguage, string> = {
  bn: 'আপনার ইনবক্সে বিস্তারিত পাঠানো হয়েছে।',
  banglish: 'Apnar inbox e details pathano hoyeche.',
  en: "We've sent you the details in a message.",
};
