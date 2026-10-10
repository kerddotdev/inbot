export type ThemeChoice = "system" | "light" | "dark";

const storageKey = "inbot-theme";

export function readTheme(): ThemeChoice {
  const stored = window.localStorage.getItem(storageKey);
  return stored === "light" || stored === "dark" ? stored : "system";
}

export function writeTheme(choice: ThemeChoice) {
  if (choice === "system") {
    window.localStorage.removeItem(storageKey);
    delete document.documentElement.dataset["theme"];
  } else {
    window.localStorage.setItem(storageKey, choice);
    document.documentElement.dataset["theme"] = choice;
  }
}

export function applyStoredTheme() {
  writeTheme(readTheme());
}
