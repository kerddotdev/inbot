import { expect, test, vi } from "vitest";
import { generatePassword, PasswordRulesError } from "./generate.js";

const appleFormat = /^[a-zA-Z1-9]{6}-[a-zA-Z1-9]{6}-[a-zA-Z1-9]{6}$/;

function seededRandom() {
  let state = 42;
  return (max: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return Math.floor(((state >>> 0) / 2 ** 32) * max);
  };
}

test("Apple passwords retain their pronounceable pattern with one digit and one uppercase", () => {
  const randomInt = seededRandom();
  for (let sample = 0; sample < 100; sample++) {
    const password = generatePassword({}, randomInt);
    expect(password).toMatch(appleFormat);
    expect(password.match(/[A-Z]/g)).toHaveLength(1);
    expect(password.match(/[1-9]/g)).toHaveLength(1);
    for (const group of password.toLowerCase().split("-")) {
      expect(group).toMatch(
        /^[bcdfghjkmnpqrstvwxz1-9][aeiouy1-9][bcdfghjkmnpqrstvwxz1-9]{2}[aeiouy1-9][bcdfghjkmnpqrstvwxz1-9]$/,
      );
    }
  }
});

test("position zero is selectable and the digit cannot overwrite the uppercase", () => {
  const randomInt = vi.fn(() => 0);
  expect(generatePassword({}, randomInt)).toBe("1Abbab-babbab-babbab");
  expect(randomInt.mock.calls).toContainEqual([18]);
  expect(randomInt.mock.calls).toContainEqual([17]);
  expect(randomInt.mock.calls).toContainEqual([9]);
});

test("every letter position can receive the digit and the uppercase", () => {
  const randomInt = seededRandom();
  const digitPositions = new Set<number>();
  const uppercasePositions = new Set<number>();
  for (let sample = 0; sample < 2000; sample++) {
    const letters = generatePassword({}, randomInt).replaceAll("-", "");
    digitPositions.add(letters.search(/[1-9]/));
    uppercasePositions.add(letters.search(/[A-Z]/));
  }
  expect([...digitPositions].sort((left, right) => left - right)).toEqual(
    Array.from({ length: 18 }, (_, index) => index),
  );
  expect(uppercasePositions.size).toBe(18);
});

test("the default generator uses cryptographic randomness and the Apple format", () => {
  expect(generatePassword()).toMatch(appleFormat);
});

test("random passwords include all four classes at default and boundary lengths", () => {
  const randomInt = seededRandom();
  for (const length of [8, 20, 128]) {
    const password = generatePassword({ mode: "random", length }, randomInt);
    expect(password).toHaveLength(length);
    expect(password).toMatch(/^[a-zA-Z0-9\-_.!@#$%^&*]+$/);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[-_.!@#$%^&*]/);
  }
  expect(generatePassword({ mode: "random" }, randomInt)).toHaveLength(20);
});

test("random generation discards a complete invalid candidate without forcing positions", () => {
  let calls = 0;
  const randomInt = vi.fn((max: number) => {
    expect(max).toBe(73);
    const index = calls++;
    if (index < 8) return 0;
    return [26, 52, 62, 0, 0, 0, 0, 0].at(index - 8) ?? 0;
  });
  expect(generatePassword({ mode: "random", length: 8 }, randomInt)).toBe("A0-aaaaa");
  expect(calls).toBe(16);
});

test.each([7, 129, 8.5, NaN, Infinity])("random mode rejects invalid length %s", (length) => {
  expect(() => generatePassword({ mode: "random", length })).toThrow(PasswordRulesError);
});

test("Apple mode and rules reject a separate length", () => {
  expect(() => generatePassword({ length: 20 })).toThrow(PasswordRulesError);
  expect(() => generatePassword({ mode: "apple", length: 20 })).toThrow(PasswordRulesError);
  expect(() => generatePassword({ rules: "minlength: 8", length: 20 })).toThrow(PasswordRulesError);
});

test("rules use the union of allowed and required classes with separate requirements", () => {
  const password = generatePassword(
    { rules: "  MINLENGTH: 8 ; maxlength: 12; required: LOWER; required: digit; allowed: Upper;" },
    seededRandom(),
  );
  expect(password).toHaveLength(12);
  expect(password).toMatch(/^[a-zA-Z0-9]+$/);
  expect(password).toMatch(/[a-z]/);
  expect(password).toMatch(/[0-9]/);
});

test("custom required characters and the minimum length are honored", () => {
  const password = generatePassword(
    { rules: "required: [!#]; allowed: lower; minlength: 30" },
    seededRandom(),
  );
  expect(password).toHaveLength(30);
  expect(password).toMatch(/^[a-z!#]+$/);
  expect(password).toMatch(/[!#]/);
});

test("maximum consecutive limits reject whole candidates until a valid one is drawn", () => {
  let choices = 0;
  const randomInt = (max: number) => {
    if (max !== 2) return 0;
    return choices++ < 8 ? 0 : choices % 2;
  };
  const password = generatePassword(
    { rules: "allowed: [ab]; maxlength: 8; max-consecutive: 2" },
    randomInt,
  );
  expect(password).toHaveLength(8);
  expect(password).toMatch(/^[ab]+$/);
  expect(password).not.toMatch(/(.)\1\1/);
  expect(choices).toBe(16);
});

test("Apple-compatible rules prefer Apple format and count separators as special", () => {
  const randomInt = seededRandom();
  expect(
    generatePassword(
      {
        mode: "random",
        rules: "minlength: 20; required: lower, upper; required: digit; allowed: [-]",
      },
      randomInt,
    ),
  ).toMatch(appleFormat);
  expect(
    generatePassword(
      {
        rules: "minlength: 20; required: special; allowed: lower, upper, digit",
      },
      randomInt,
    ),
  ).toMatch(appleFormat);
});

test("each required declaration permits any character from its union", () => {
  expect(generatePassword({ rules: "maxlength: 8; required: upper, lower" }, () => 0)).toBe(
    "AAAAAAAA",
  );
});

test.each([
  { set: "[-]", allowed: /^-+$/ },
  { set: "[a-]", allowed: /^[a-]+$/ },
  { set: "[-a]", allowed: /^[a-]+$/ },
  { set: "[]-]", allowed: /^[\]-]+$/ },
  { set: "[]a]", allowed: /^[\]a]+$/ },
  { set: "[]]", allowed: /^\]+$/ },
])(
  "custom sets honor a leading closing bracket and a first or last hyphen: $set",
  ({ set, allowed }) => {
    const password = generatePassword({ rules: `allowed: ${set}; maxlength: 8` }, seededRandom());
    expect(password).toHaveLength(8);
    expect(password).toMatch(allowed);
  },
);

test("commas, semicolons, and opening brackets inside custom sets are literal", () => {
  const password = generatePassword(
    {
      rules: "required: [,]; required: [;]; required: [[]; maxlength: 12",
    },
    seededRandom(),
  );
  expect(password).toHaveLength(12);
  expect(password).toMatch(/^[,;[]+$/);
  expect(password).toContain(",");
  expect(password).toContain(";");
  expect(password).toContain("[");
});

test("custom sets ignore non-ASCII characters without changing literal case", () => {
  expect(generatePassword({ rules: "allowed: [a\u00e9A]; maxlength: 8" }, () => 0)).toBe(
    "aaaaaaaa",
  );
  expect(generatePassword({ rules: "allowed: [\u00e9-a]; maxlength: 8" }, () => 0)).toBe(
    "--------",
  );
});

test("unknown properties are ignored and repeated limits use the strictest value", () => {
  const password = generatePassword(
    {
      rules:
        "unknown: [whatever; minlength: 8; minlength: 10; maxlength: 18; maxlength: 12; allowed: lower; max-consecutive: 3; max-consecutive: 2",
    },
    seededRandom(),
  );
  expect(password).toHaveLength(12);
  expect(password).toMatch(/^[a-z]+$/);
  expect(password).not.toMatch(/(.)\1\1/);
});

test.each(["ascii-printable", "unicode"])("%s uses printable ASCII", (name) => {
  expect(generatePassword({ rules: `allowed: ${name}; maxlength: 8` }, () => 0)).toBe("        ");
});

test("special includes the listed punctuation without spaces, slashes, or backslashes", () => {
  const password = generatePassword({ rules: "allowed: special; maxlength: 8" }, seededRandom());
  expect(password).toHaveLength(8);
  expect(password).not.toMatch(/[a-zA-Z0-9 /\\]/);
});

test.each([
  "minlength: 30; maxlength: 12",
  "minlength: 129",
  "allowed: [\u00e9]",
  "required: [\u00e9]; allowed: lower",
  "maxlength: 1; required: lower; required: digit",
  "minlength: 8; allowed: [a]; max-consecutive: 2",
  "minlength: 8; allowed: lower; max-consecutive: 0",
  "minlength: -1",
  "maxlength: 12.5",
  "minlength: 9007199254740992",
  "required: unsupported",
  "allowed: [a-b]",
  "allowed: [-]]",
  "allowed: [abc",
])("invalid or unsatisfiable rules fail safely: %s", (rules) => {
  expect(() => generatePassword({ rules }, () => 0)).toThrow(PasswordRulesError);
});

test("a bounded sampler fails safely when its random source cannot satisfy the requirements", () => {
  expect(() => generatePassword({ mode: "random", length: 8 }, () => 0)).toThrow(/10000 attempts/);
});
