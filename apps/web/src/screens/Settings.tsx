import { useState } from "react";
import { Page, Segmented } from "../components/ui";
import { readTheme, writeTheme, type ThemeChoice } from "../theme";

const choices: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function Settings() {
  const [theme, setTheme] = useState(readTheme);
  return (
    <Page barTitle="Settings" title="Settings">
      <fieldset className="min-w-0">
        <legend className="mb-[7px] p-0 font-semibold">Appearance</legend>
        <Segmented
          name="theme"
          options={choices}
          value={theme}
          onChange={(choice) => {
            setTheme(choice);
            writeTheme(choice);
          }}
        />
      </fieldset>
    </Page>
  );
}
