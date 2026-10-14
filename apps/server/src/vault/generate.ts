import { randomInt as cryptoRandomInt } from "node:crypto";

export type PasswordMode = "apple" | "random";

export interface GenerateOptions {
  readonly mode?: PasswordMode;
  readonly length?: number;
  readonly rules?: string;
}

export class PasswordRulesError extends Error {}

const lower = "abcdefghijklmnopqrstuvwxyz";
const upper = lower.toUpperCase();
const digits = "0123456789";
const randomSpecials = "-_.!@#$%^&*";
const randomAlphabet = lower + upper + digits + randomSpecials;
const printable = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)).join(
  "",
);
const specials = "-~!@#$%^&*_+=`|(){}[:;\"'<>,.?]";
const classes = new Map([
  ["upper", upper],
  ["lower", lower],
  ["digit", digits],
  ["special", specials],
  ["ascii-printable", printable],
  ["unicode", printable],
]);

interface Rules {
  readonly minlength: number;
  readonly maxlength: number;
  readonly required: readonly ReadonlySet<string>[];
  readonly alphabet: ReadonlySet<string>;
  readonly maxConsecutive: number;
}

function splitRules(input: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let setStart = -1;
  for (let index = 0; index < input.length; index++) {
    const char = input.charAt(index);
    if (
      setStart < 0 &&
      char === "[" &&
      (separator !== ";" || /^\s*(?:required|allowed)\s*:/i.test(input.slice(start, index)))
    )
      setStart = index;
    else if (setStart >= 0 && char === "]" && index > setStart + 1) setStart = -1;
    else if (setStart < 0 && char === separator) {
      parts.push(input.slice(start, index));
      start = index + 1;
    }
  }
  if (setStart >= 0) throw new PasswordRulesError("A custom character set is not closed.");
  parts.push(input.slice(start));
  return parts;
}

function characterSet(value: string): Set<string> {
  const result = new Set<string>();
  for (const entry of splitRules(value, ",")) {
    const name = entry.trim();
    const custom = /^\[(\]?[^\]]*)\]$/.exec(name);
    if (custom !== null) {
      const chars = [...(custom[1] ?? "")].filter((char) => char.charCodeAt(0) <= 127).join("");
      for (let index = 0; index < chars.length; index++) {
        const char = chars.charAt(index);
        if (char === "-" && index !== 0 && index !== chars.length - 1)
          throw new PasswordRulesError("Put a custom set's hyphen first or last.");
        result.add(char);
      }
    } else {
      const chars = classes.get(name.toLowerCase());
      if (chars === undefined) throw new PasswordRulesError("Use a supported character class.");
      for (const char of chars) result.add(char);
    }
  }
  return result;
}

function parseRules(input: string): Rules {
  let minlength = 0;
  let maxlength = 128;
  let hasMaxlength = false;
  let maxConsecutive = Infinity;
  let hasAlphabet = false;
  const alphabet = new Set<string>();
  const required: Set<string>[] = [];
  for (const declaration of splitRules(input, ";")) {
    if (declaration.trim() === "") continue;
    const colon = declaration.indexOf(":");
    if (colon < 0)
      throw new PasswordRulesError("Separate password rule names and values with a colon.");
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (property === "required" || property === "allowed") {
      const chars = characterSet(value);
      if (property === "required") required.push(chars);
      for (const char of chars) alphabet.add(char);
      hasAlphabet = true;
    } else if (["minlength", "maxlength", "max-consecutive"].includes(property)) {
      const number = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(number))
        throw new PasswordRulesError("Password rule limits must be non-negative integers.");
      if (property === "minlength") minlength = Math.max(minlength, number);
      else if (property === "maxlength") {
        maxlength = hasMaxlength ? Math.min(maxlength, number) : number;
        hasMaxlength = true;
      } else maxConsecutive = Math.min(maxConsecutive, number);
    }
  }
  if (!hasAlphabet) for (const char of randomAlphabet) alphabet.add(char);
  if (minlength > maxlength)
    throw new PasswordRulesError("The minimum password length exceeds the maximum.");
  if (alphabet.size === 0 || required.some((set) => set.size === 0))
    throw new PasswordRulesError("Password rules must provide non-empty character sets.");
  if (maxlength < required.length)
    throw new PasswordRulesError("The maximum password length is too short for the requirements.");
  return { minlength, maxlength, required, alphabet, maxConsecutive };
}

function satisfies(password: string, rules: Rules): boolean {
  if (password.length < rules.minlength || password.length > rules.maxlength) return false;
  const chars = [...password];
  if (!chars.every((char) => rules.alphabet.has(char))) return false;
  if (!rules.required.every((set) => chars.some((char) => set.has(char)))) return false;
  let previous = "";
  let consecutive = 0;
  for (const char of chars) {
    consecutive = char === previous ? consecutive + 1 : 1;
    if (consecutive > rules.maxConsecutive) return false;
    previous = char;
  }
  return true;
}

function applePassword(randomInt: (max: number) => number): string {
  const consonants = "bcdfghjkmnpqrstvwxz";
  const vowels = "aeiouy";
  const letters = Array.from({ length: 18 }, (_, index) => {
    const alphabet = index % 3 === 1 ? vowels : consonants;
    return alphabet.charAt(randomInt(alphabet.length));
  });
  const digitPosition = randomInt(18);
  const uppercaseChoice = randomInt(17);
  const uppercasePosition =
    uppercaseChoice >= digitPosition ? uppercaseChoice + 1 : uppercaseChoice;
  const digit = String(1 + randomInt(9));
  const result = letters.map((char, index) =>
    index === digitPosition ? digit : index === uppercasePosition ? char.toUpperCase() : char,
  );
  return [result.slice(0, 6), result.slice(6, 12), result.slice(12)]
    .map((group) => group.join(""))
    .join("-");
}

function randomPassword(length: number, rules: Rules, randomInt: (max: number) => number): string {
  const alphabet = [...rules.alphabet].join("");
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const password = Array.from({ length }, () => alphabet.charAt(randomInt(alphabet.length))).join(
      "",
    );
    if (satisfies(password, rules)) return password;
  }
  throw new PasswordRulesError(
    "Could not satisfy the password rules after 10000 attempts. Relax the restrictions.",
  );
}

export function generatePassword(
  options: GenerateOptions = {},
  randomInt: (max: number) => number = cryptoRandomInt,
): string {
  if (options.rules !== undefined) {
    if (options.length !== undefined)
      throw new PasswordRulesError("Use password rules or an explicit length, not both.");
    const rules = parseRules(options.rules);
    const apple = applePassword(randomInt);
    if (satisfies(apple, rules)) return apple;
    return randomPassword(
      Math.min(rules.maxlength, Math.max(rules.minlength, 20)),
      rules,
      randomInt,
    );
  }
  if ((options.mode ?? "apple") === "apple") {
    if (options.length !== undefined)
      throw new PasswordRulesError("Apple-style passwords have a fixed length of 20.");
    return applePassword(randomInt);
  }
  const length = options.length ?? 20;
  if (!Number.isInteger(length) || length < 8 || length > 128)
    throw new PasswordRulesError("Random password length must be an integer between 8 and 128.");
  return randomPassword(
    length,
    {
      minlength: 8,
      maxlength: 128,
      alphabet: new Set(randomAlphabet),
      required: [lower, upper, digits, randomSpecials].map((chars) => new Set(chars)),
      maxConsecutive: Infinity,
    },
    randomInt,
  );
}
