/** Vietnamese name matching form: no diacritics, đ -> d, upper case, single spaces. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Vietnamese phone number as 0xxxxxxxxx. Accepts Excel numbers that lost the leading 0,
 * spaces, dots, dashes and the +84 / 84 prefix. Returns null when it is not a phone number.
 */
export function normalizePhone(raw: string | number): string | null {
  let d = String(raw).replace(/[\s.\-()]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (!/^\d+$/.test(d)) return null;
  if (d.startsWith("84") && (d.length === 11 || d.length === 12)) d = `0${d.slice(2)}`;
  else if (!d.startsWith("0") && (d.length === 9 || d.length === 10)) d = `0${d}`;
  return /^0\d{9,10}$/.test(d) ? d : null;
}

/**
 * Phone as shown to managers and used to match the same customer across sources:
 * first 4 and last 3 digits, e.g. 0912***678. Also accepts an already masked value.
 */
export function maskPhone(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  const masked = /^(\d{4})[*xX•.]+(\d{3})$/.exec(s.replace(/\s/g, ""));
  if (masked) return `${masked[1]}***${masked[2]}`;
  const phone = normalizePhone(s);
  return phone ? `${phone.slice(0, 4)}***${phone.slice(-3)}` : null;
}

/** Lower case, NFC, single spaces: for matching list values written by hand. */
export const looseForm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

/** "NGUYỄN TRUYỀN GIANG" -> "Nguyễn Truyền Giang" (names written in capitals by Success). */
export const titleCase = (name: string) =>
  name
    .trim()
    .toLocaleLowerCase("vi")
    .replace(/(^|\s)(\p{L})/gu, (_, space: string, letter: string) => space + letter.toLocaleUpperCase("vi"));
